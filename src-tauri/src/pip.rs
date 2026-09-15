//! Pop-out windows: any file, in its own small always-on-top window, as many
//! as you like up to a cap.
//!
//! The windows are built here, in Rust, and never by a page asking for one.
//! Nothing in the pop-out's capability lets it create a window, so a page that
//! misbehaves — a PDF, an HTML file, a model with a malicious texture path —
//! cannot turn one pop-out into a hundred.
//!
//! Each window is a borderless webview on `pip.html?id=N` with the label
//! `pip-N`. The page asks `pip_info` what it is showing, which keeps the file's
//! path out of the URL and means an id that is not in the table below shows
//! nothing at all.
//!
//! **Why the windows skip the taskbar.** Twelve buttons on the taskbar for
//! twelve thumbnails is the opposite of what a pop-out is for. The cost is that
//! a pop-out behind something else is hard to find, which is why the explorer
//! has a Pop-outs panel and why `pip list` exists.
//!
//! **Replies to a command line.** A second `facet.exe` hands its arguments to
//! this one and exits; the plugin carries nothing back. So every change here
//! rewrites `pip-state.json` in the app's local data folder, carrying the
//! windows, the monitors, and the number of the last request handled together
//! with any error it produced. A caller that passed `--req N` waits for N to
//! appear there. That file lives on this machine only and is never shipped.

use std::collections::BTreeMap;
use std::sync::Mutex;

use serde::Serialize;
use tauri::{
    AppHandle, Emitter, Manager, Monitor, PhysicalPosition, PhysicalSize, Runtime, WebviewUrl,
    WebviewWindow, WebviewWindowBuilder,
};

use crate::cli::{CloseTarget, Command, Layout, OpenReq, PipOpts, Request};
use crate::pip_layout::{self as lay, Metrics, Rect};

/// Past this the machine is spending a gigabyte or two on thumbnails, and a
/// wall of windows is not something anyone can watch.
pub const MAX_PIPS: usize = 12;
/// Chromium keeps about sixteen live WebGL contexts per browser process and
/// silently kills the oldest past that, and every FACET window shares one
/// process. Eight leaves room for the explorer's own viewer and some slack.
pub const MAX_3D: usize = 8;

const MODEL_EXTS: &[&str] = &[
    "glb", "gltf", "obj", "stl", "ply", "3mf", "dae", "fbx", "step", "stp", "iges", "igs", "brep",
    "splat", "spz", "ksplat",
];

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Pip {
    pub id: u32,
    pub path: String,
    pub name: String,
    pub opts: PipOpts,
    /// Width over height of the picture, once the page has measured it.
    pub aspect: Option<f64>,
    /// Bytes on disk, read when the page asks. The table view needs it to know
    /// how much of the file there is.
    #[serde(default)]
    pub size: Option<u64>,
    /// Given an explicit `--size`, so a measured picture must not reshape it.
    #[serde(skip)]
    sized: bool,
}

#[derive(Default)]
struct Inner {
    next: u32,
    wins: BTreeMap<u32, Pip>,
    last_req: Option<u64>,
    last_error: Option<String>,
}

#[derive(Default)]
pub struct Pips {
    inner: Mutex<Inner>,
}

fn label(id: u32) -> String {
    format!("pip-{id}")
}

fn id_of(label: &str) -> Option<u32> {
    label.strip_prefix("pip-")?.parse().ok()
}

fn is_model(path: &str) -> bool {
    let ext = path.rsplit_once('.').map(|(_, e)| e.to_ascii_lowercase()).unwrap_or_default();
    MODEL_EXTS.contains(&ext.as_str())
}

fn name_of(path: &str) -> String {
    path.rsplit(['/', '\\']).next().unwrap_or(path).to_string()
}

/// Never hold this across a call that can raise a window event: closing a
/// window runs `forget`, which takes the same lock.
fn lock(app: &AppHandle<impl Runtime>) -> std::sync::MutexGuard<'_, Inner> {
    // A panic while holding this lock is a bug elsewhere; carrying on with the
    // table as it was is better than every later pop-out command failing.
    app.state::<Pips>().inner().inner.lock().unwrap_or_else(|e| e.into_inner())
}

// ── Monitors ────────────────────────────────────────────────────────────────

/// Monitors left to right, then top to bottom, so `--monitor 0` is the
/// leftmost screen whatever order the OS enumerates them in.
fn monitors(app: &AppHandle<impl Runtime>) -> Vec<Monitor> {
    let mut ms = app.available_monitors().unwrap_or_default();
    ms.sort_by_key(|m| (m.position().x, m.position().y));
    ms
}

/// The screen the person is looking at: the one under the mouse, else the
/// primary, else the first.
fn pick_monitor(app: &AppHandle<impl Runtime>, index: Option<usize>) -> Option<Monitor> {
    let ms = monitors(app);
    if let Some(i) = index {
        if let Some(m) = ms.get(i) {
            return Some(m.clone());
        }
    }
    if let Ok(p) = app.cursor_position() {
        if let Ok(Some(m)) = app.monitor_from_point(p.x, p.y) {
            return Some(m);
        }
    }
    app.primary_monitor().ok().flatten().or_else(|| ms.into_iter().next())
}

fn work_area(m: &Monitor) -> Rect {
    let wa = m.work_area();
    Rect {
        x: wa.position.x as f64,
        y: wa.position.y as f64,
        w: wa.size.width as f64,
        h: wa.size.height as f64,
    }
}

fn place(win: &WebviewWindow<impl Runtime>, r: Rect) {
    let _ = win.set_size(PhysicalSize::new(r.w.round().max(1.0) as u32, r.h.round().max(1.0) as u32));
    let _ = win.set_position(PhysicalPosition::new(r.x.round() as i32, r.y.round() as i32));
}

fn rect_of(win: &WebviewWindow<impl Runtime>) -> Option<Rect> {
    let p = win.outer_position().ok()?;
    let s = win.outer_size().ok()?;
    Some(Rect { x: p.x as f64, y: p.y as f64, w: s.width as f64, h: s.height as f64 })
}

// ── Requests ────────────────────────────────────────────────────────────────

/// Carry out one parsed command line. Records the outcome for `--req`.
pub fn dispatch<R: Runtime>(app: &AppHandle<R>, request: Request) {
    let app = app.clone();
    // Window creation must not run on the thread that owns the event loop
    // while that thread waits for it — the async runtime is the safe place.
    tauri::async_runtime::spawn(async move {
        let outcome = match request.command {
            Command::PipOpen(o) => open(&app, o).map(|_| ()),
            Command::PipTile { layout, monitor } => {
                tile(&app, layout, monitor);
                Ok(())
            }
            Command::PipClose(t) => {
                // Closing the last pop-out ends a facet that has no explorer
                // open, possibly before the state below is written, so the
                // answer goes out with close's own write, before any window goes.
                if request.req.is_some() {
                    lock(&app).last_req = request.req;
                }
                close(&app, t);
                Ok(())
            }
            Command::PipList | Command::Nothing => {
                if !request.is_pip() {
                    show_main(&app);
                }
                Ok(())
            }
            Command::Explore(paths) => {
                crate::openwith::queue_desktop(paths);
                show_main(&app);
                let _ = app.emit_to("main", "facet-open", ());
                Ok(())
            }
        };
        {
            let mut g = lock(&app);
            if request.req.is_some() {
                g.last_req = request.req;
            }
            g.last_error = outcome.err();
        }
        write_state(&app);
        exit_if_windowless(&app);
    });
}

/// A facet started only to run a pop-out command that opened nothing — a bad
/// path, `pip list` with nothing running — would otherwise sit in the
/// background with no window to close it by. Windows still closing count as
/// windows, so `pip close all` leaves the exit to the last one going.
fn exit_if_windowless<R: Runtime>(app: &AppHandle<R>) {
    if app.webview_windows().is_empty() {
        app.exit(0);
    }
}

/// Record a command line that did not parse, so a waiting caller sees why.
pub fn record_error<R: Runtime>(app: &AppHandle<R>, req: Option<u64>, error: String) {
    {
        let mut g = lock(app);
        if req.is_some() {
            g.last_req = req;
        }
        g.last_error = Some(error);
    }
    write_state(app);
    // Not from inside `setup`, where a cold start's bad command line lands.
    let app = app.clone();
    tauri::async_runtime::spawn(async move { exit_if_windowless(&app) });
}

/// Open one pop-out per path. Refuses the whole batch past a cap rather than
/// opening some of it, so "open these six" never quietly becomes four.
pub fn open<R: Runtime>(app: &AppHandle<R>, req: OpenReq) -> Result<Vec<u32>, String> {
    for p in &req.paths {
        match std::fs::metadata(p) {
            Ok(m) if m.is_file() => {}
            _ => return Err(format!("{p}: no such file")),
        }
    }

    let (ids, existing): (Vec<u32>, Vec<u32>) = {
        let mut g = lock(app);
        let open_now = g.wins.len();
        if open_now + req.paths.len() > MAX_PIPS {
            return Err(format!(
                "{open_now} pop-outs are open and the most is {MAX_PIPS} — close some first"
            ));
        }
        let models = g.wins.values().filter(|p| is_model(&p.path)).count()
            + req.paths.iter().filter(|p| is_model(p)).count();
        if models > MAX_3D {
            return Err(format!("at most {MAX_3D} 3D pop-outs at once"));
        }
        let existing = g.wins.keys().copied().collect();
        let mut ids = Vec::new();
        for path in &req.paths {
            g.next += 1;
            let id = g.next;
            g.wins.insert(
                id,
                Pip {
                    id,
                    path: path.clone(),
                    name: name_of(path),
                    opts: req.opts.clone(),
                    aspect: None,
                    size: None,
                    sized: req.size.is_some(),
                },
            );
            ids.push(id);
        }
        (ids, existing)
    };

    let monitor = pick_monitor(app, req.monitor);
    let scale = monitor.as_ref().map(|m| m.scale_factor()).unwrap_or(1.0);
    let area = monitor
        .as_ref()
        .map(work_area)
        .unwrap_or(Rect { x: 0.0, y: 0.0, w: 1280.0, h: 720.0 });
    let m = Metrics::at_scale(scale);
    let layout = req.layout.unwrap_or(if req.paths.len() > 1 { Layout::Tile } else { Layout::Corner });

    let mut built = Vec::new();
    for &id in &ids {
        let (path, name) = {
            let g = lock(app);
            let p = &g.wins[&id];
            (p.path.clone(), p.name.clone())
        };
        let _ = path;
        let win = WebviewWindowBuilder::new(app, label(id), WebviewUrl::App(format!("pip.html?id={id}").into()))
            .title(format!("{name} — FACET"))
            .decorations(false)
            .always_on_top(true)
            .skip_taskbar(true)
            .focused(false)
            .resizable(true)
            .transparent(true)
            .shadow(false)
            .min_inner_size(160.0, 90.0)
            .inner_size(480.0, 270.0)
            .position(area.x / scale + 40.0, area.y / scale + 40.0)
            .build();
        match win {
            Ok(w) => built.push((id, w)),
            Err(e) => {
                lock(app).wins.remove(&id);
                return Err(format!("could not open a window: {e}"));
            }
        }
    }

    // Where they go. Tile re-places every pop-out, old and new, so the grid is
    // one grid; corner and cascade continue on from the ones already open.
    match layout {
        Layout::Tile => tile(app, Layout::Tile, req.monitor),
        Layout::Corner | Layout::Cascade => {
            let n = existing.len() + built.len();
            let aspects = vec![lay::DEFAULT_ASPECT; n];
            let slots = if layout == Layout::Corner {
                lay::corner(area, &aspects, &m, scale)
            } else {
                lay::cascade(area, &aspects, &m, scale)
            };
            for (k, (_, w)) in built.iter().enumerate() {
                if let Some(&r) = slots.get(existing.len() + k) {
                    place(w, r);
                }
            }
        }
    }

    // An explicit size in the corner restacks the new windows at that size, so
    // they hug the corner instead of sitting inside default-width slots.
    let corner_size = req.size.filter(|_| req.at.is_none() && layout == Layout::Corner);
    if let Some((sw, sh)) = corner_size {
        let mut sizes: Vec<(f64, f64)> = existing
            .iter()
            .filter_map(|&id| app.get_webview_window(&label(id)).and_then(|w| rect_of(&w)))
            .map(|r| (r.w, r.h))
            .collect();
        let first_new = sizes.len();
        sizes.extend(built.iter().map(|_| (sw as f64 * scale, sh as f64 * scale)));
        let slots = lay::corner_sized(area, &sizes, &m);
        for (k, (_, w)) in built.iter().enumerate() {
            if let Some(&r) = slots.get(first_new + k) {
                place(w, r);
            }
        }
    }

    // An explicit size or position wins over the layout, kept on screen.
    if corner_size.is_none() && (req.size.is_some() || req.at.is_some()) {
        for (_, w) in &built {
            let Some(cur) = rect_of(w) else { continue };
            let mut r = cur;
            if let Some((sw, sh)) = req.size {
                r.w = sw as f64 * scale;
                r.h = sh as f64 * scale;
            }
            if let Some((ax, ay)) = req.at {
                r.x = area.x + ax as f64 * scale;
                r.y = area.y + ay as f64 * scale;
            }
            place(w, lay::clamp_into(r, area, &m));
        }
    }

    write_state(app);
    Ok(ids)
}

/// Re-place every pop-out on one monitor.
pub fn tile<R: Runtime>(app: &AppHandle<R>, layout: Layout, monitor: Option<usize>) {
    let Some(mon) = pick_monitor(app, monitor) else { return };
    let scale = mon.scale_factor();
    let area = work_area(&mon);
    let m = Metrics::at_scale(scale);
    let wins: Vec<(u32, Option<f64>)> = lock(app).wins.values().map(|p| (p.id, p.aspect)).collect();
    let aspects: Vec<f64> = wins.iter().map(|(_, a)| a.unwrap_or(lay::DEFAULT_ASPECT)).collect();
    let rects = match layout {
        Layout::Tile => lay::tile(area, &aspects, &m),
        Layout::Corner => lay::corner(area, &aspects, &m, scale),
        Layout::Cascade => lay::cascade(area, &aspects, &m, scale),
    };
    for ((id, _), r) in wins.iter().zip(rects) {
        if let Some(w) = app.get_webview_window(&label(*id)) {
            place(&w, r);
        }
    }
    write_state(app);
}

pub fn close<R: Runtime>(app: &AppHandle<R>, target: CloseTarget) {
    let ids: Vec<u32> = match target {
        CloseTarget::All => lock(app).wins.keys().copied().collect(),
        CloseTarget::Id(id) => vec![id],
    };
    // Forgotten and written down first: the windows close asynchronously, and
    // the last one closing can end the process.
    let wins: Vec<u32> = {
        let mut g = lock(app);
        g.last_error = None;
        ids.iter().filter(|id| g.wins.remove(id).is_some()).copied().collect()
    };
    write_state(app);
    for id in wins {
        if let Some(w) = app.get_webview_window(&label(id)) {
            let _ = w.close();
        }
    }
}


/// A pop-out's window has gone, however it went.
pub fn forget<R: Runtime>(app: &AppHandle<R>, window_label: &str) {
    let Some(id) = id_of(window_label) else { return };
    lock(app).wins.remove(&id);
    let app = app.clone();
    tauri::async_runtime::spawn(async move { write_state(&app) });
}

/// Raise the explorer, building it first if it was closed or never opened
/// (a cold `facet pip open` starts without it).
pub fn show_main<R: Runtime>(app: &AppHandle<R>) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
        return;
    }
    if let Some(cfg) = app.config().app.windows.iter().find(|w| w.label == "main") {
        if let Ok(b) = WebviewWindowBuilder::from_config(app, cfg) {
            let _ = b.build();
        }
    }
}

// ── State file ──────────────────────────────────────────────────────────────

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct StateWin {
    id: u32,
    path: String,
    name: String,
    x: i32,
    y: i32,
    w: u32,
    h: u32,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct StateMon {
    index: usize,
    x: i32,
    y: i32,
    w: u32,
    h: u32,
    scale: f64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct StateFile {
    version: u32,
    pid: u32,
    updated_ms: u128,
    max: usize,
    windows: Vec<StateWin>,
    monitors: Vec<StateMon>,
    last_req: Option<u64>,
    last_error: Option<String>,
}

/// Rewrite `pip-state.json`. Written to a temporary name and renamed, so a
/// reader polling it never sees half a file.
pub fn write_state<R: Runtime>(app: &AppHandle<R>) {
    let (pips, last_req, last_error) = {
        let g = lock(app);
        (g.wins.values().cloned().collect::<Vec<_>>(), g.last_req, g.last_error.clone())
    };
    let windows = pips
        .into_iter()
        .map(|p| {
            let r = app.get_webview_window(&label(p.id)).and_then(|w| rect_of(&w));
            let r = r.unwrap_or(Rect { x: 0.0, y: 0.0, w: 0.0, h: 0.0 });
            StateWin { id: p.id, path: p.path, name: p.name, x: r.x as i32, y: r.y as i32, w: r.w as u32, h: r.h as u32 }
        })
        .collect();
    let monitors = monitors(app)
        .iter()
        .enumerate()
        .map(|(index, m)| {
            let a = work_area(m);
            StateMon { index, x: a.x as i32, y: a.y as i32, w: a.w as u32, h: a.h as u32, scale: m.scale_factor() }
        })
        .collect();
    let state = StateFile {
        version: 1,
        pid: std::process::id(),
        updated_ms: std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or(0),
        max: MAX_PIPS,
        windows,
        monitors,
        last_req,
        last_error,
    };
    let Ok(dir) = app.path().app_local_data_dir() else { return };
    let _ = std::fs::create_dir_all(&dir);
    let Ok(json) = serde_json::to_vec_pretty(&state) else { return };
    let tmp = dir.join("pip-state.json.tmp");
    if std::fs::write(&tmp, json).is_ok() {
        let _ = std::fs::rename(&tmp, dir.join("pip-state.json"));
    }
}

// ── Commands the pages call ─────────────────────────────────────────────────

/// What this pop-out window is showing. Null for any window that is not one.
#[tauri::command]
pub fn pip_info<R: Runtime>(app: AppHandle<R>, window: WebviewWindow<R>) -> Option<Pip> {
    let id = id_of(window.label())?;
    let mut pip = lock(&app).wins.get(&id).cloned()?;
    pip.size = std::fs::metadata(&pip.path).ok().map(|m| m.len());
    Some(pip)
}

/// The page has measured its picture. Shrink the window to that shape inside
/// the space it was given, unless someone asked for an exact size.
#[tauri::command]
pub fn pip_ready<R: Runtime>(app: AppHandle<R>, window: WebviewWindow<R>, aspect: Option<f64>) {
    let Some(id) = id_of(window.label()) else { return };
    let sized = {
        let mut g = lock(&app);
        let Some(p) = g.wins.get_mut(&id) else { return };
        if let Some(a) = aspect.filter(|a| a.is_finite() && *a > 0.0) {
            p.aspect = Some(a);
        }
        p.sized
    };
    if let (false, Some(a), Some(r)) = (sized, aspect, rect_of(&window)) {
        let scale = window.scale_factor().unwrap_or(1.0);
        place(&window, lay::letterbox(r, a, &Metrics::at_scale(scale)));
    }
}

/// From the explorer: pop these files out.
#[tauri::command]
pub async fn pip_open<R: Runtime>(
    app: AppHandle<R>,
    paths: Vec<String>,
    layout: Option<String>,
) -> Result<Vec<u32>, String> {
    let layout = match layout.as_deref() {
        None => None,
        Some(s) => Some(Layout::parse(s).ok_or_else(|| format!("{s}: not a layout"))?),
    };
    open(
        &app,
        OpenReq { paths, layout, size: None, at: None, monitor: None, opts: PipOpts::default() },
    )
}

#[tauri::command]
pub fn pip_list<R: Runtime>(app: AppHandle<R>) -> Vec<Pip> {
    lock(&app).wins.values().cloned().collect()
}

#[tauri::command]
pub async fn pip_tile<R: Runtime>(app: AppHandle<R>, layout: Option<String>) -> Result<(), String> {
    let l = match layout.as_deref() {
        None => Layout::Tile,
        Some(s) => Layout::parse(s).ok_or_else(|| format!("{s}: not a layout"))?,
    };
    tile(&app, l, None);
    Ok(())
}

#[tauri::command]
pub async fn pip_close<R: Runtime>(app: AppHandle<R>, id: Option<u32>) {
    close(&app, id.map(CloseTarget::Id).unwrap_or(CloseTarget::All));
}

/// Show or hide every pop-out at once, for the explorer's Pop-outs panel.
#[tauri::command]
pub async fn pip_show_all<R: Runtime>(app: AppHandle<R>, show: bool) {
    let ids: Vec<u32> = lock(&app).wins.keys().copied().collect();
    for id in ids {
        if let Some(w) = app.get_webview_window(&label(id)) {
            let _ = if show { w.show() } else { w.hide() };
        }
    }
}

/// "Open in FACET" from a pop-out: raise the explorer on this file's folder.
#[tauri::command]
pub async fn pip_reveal<R: Runtime>(app: AppHandle<R>, window: WebviewWindow<R>) {
    let Some(id) = id_of(window.label()) else { return };
    let Some(path) = lock(&app).wins.get(&id).map(|p| p.path.clone()) else { return };
    crate::openwith::queue_desktop(vec![path]);
    show_main(&app);
    let _ = app.emit_to("main", "facet-open", ());
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn labels_round_trip_and_reject_other_windows() {
        assert_eq!(id_of(&label(7)), Some(7));
        assert_eq!(id_of("main"), None);
        assert_eq!(id_of("pip-"), None);
        assert_eq!(id_of("pip-x"), None);
    }

    #[test]
    fn model_detection_is_by_extension_any_case() {
        assert!(is_model("C:/a/b/Part.STEP"));
        assert!(is_model("/x/y.glb"));
        assert!(!is_model("/x/y.mp4"));
        assert!(!is_model("/x/noext"));
        assert_eq!(name_of("C:/a/b/c d.mp4"), "c d.mp4");
    }
}
