//! Driving FACET's own window, as tools a model can call.
//!
//! The file tools in `mcp.rs` answer questions about things on disk. These
//! answer the other question — *what does the app actually do when you press
//! that* — and they exist because the alternative was shipping UI fixes that
//! had never once been seen working. A hex dump that runs off the side of a
//! phone screen and a blur panel whose controls change one face out of twelve
//! are both invisible to a type checker and obvious within five seconds of
//! looking.
//!
//! Everything here goes through `cdp.rs` to a web view that was started with a
//! debugging port, which means the same tools reach:
//!
//! * the desktop window, started by `facet_ui_open`, and
//! * the phone, over `adb forward tcp:9333 localabstract:webview_devtools_remote_<pid>`
//!   — the port is just a number to this file.
//!
//! Clicks are real protocol-level input events at real coordinates, not
//! `element.click()`. FACET's editor is a canvas that listens for pointer
//! events and a synthetic click would sail straight past it, so a tool that
//! cheated there would report success on exactly the surface that most needs
//! testing.

use serde_json::{json, Map, Value};

use crate::cdp::{pick, targets, Session};
use crate::mcp::Answer;

/// The port FACET is asked to open when `facet_ui_open` starts it.
///
/// 9224 rather than Chrome's usual 9222: a debugging port is claimed by
/// whoever asks first, and colliding with a browser the user already has open
/// would mean these tools quietly drove the wrong application.
pub const DEFAULT_PORT: u16 = 9224;

fn port_of(args: &Map<String, Value>) -> u16 {
    args.get("port").and_then(Value::as_u64).unwrap_or(DEFAULT_PORT as u64) as u16
}

fn target_of(args: &Map<String, Value>) -> Option<String> {
    args.get("target").and_then(Value::as_str).map(str::to_owned)
}

fn session(args: &Map<String, Value>) -> Result<Session, String> {
    let port = port_of(args);
    let t = pick(port, target_of(args).as_deref())?;
    Session::open(&t.ws, port)
}

fn text(args: &Map<String, Value>, key: &str) -> Option<String> {
    args.get(key).and_then(Value::as_str).map(str::to_owned)
}

fn num(args: &Map<String, Value>, key: &str, fallback: f64) -> f64 {
    args.get(key).and_then(Value::as_f64).unwrap_or(fallback)
}

// ------------------------------------------------------------ page script
//
// One helper, injected as part of whatever expression needs it rather than
// installed into the page. Stateless on purpose: a tool call that depends on a
// previous call having left something behind is a tool call that fails the
// first time it is used on a window somebody else opened.

/// Resolve `{selector, text, nth, x, y}` to a point and say what was hit.
const FIND: &str = r##"
const __find = (spec) => {
  if (typeof spec.x === "number" && typeof spec.y === "number") {
    const el = document.elementFromPoint(spec.x, spec.y);
    return { ok: true, x: spec.x, y: spec.y, what: el ? __label(el) : "(nothing there)" };
  }
  let list = [];
  if (spec.selector) {
    try { list = [...document.querySelectorAll(spec.selector)]; }
    catch (e) { return { ok: false, why: "that is not a selector: " + e.message }; }
  } else if (spec.text) {
    // Everything, not only what looks clickable. A file row is a plain div
    // with no role and no tabindex, and it is exactly what a hand would aim
    // at; searching the clickable set alone found only the scrolling box
    // around it, which swallows the click and does nothing.
    list = [...document.querySelectorAll("body *")];
  } else {
    list = [...document.querySelectorAll("button,a,input,select,textarea,label,summary,[role],[tabindex],[data-act]")];
  }
  list = list.filter(__shown);
  if (spec.text) {
    // Runs of whitespace are collapsed on both sides. A tooltip reading
    // "Blur & edit  (E)" has two spaces in it because of how the markup was
    // laid out, and nobody looking at the screen can see that; asking a caller
    // to reproduce it exactly is asking them to read the source.
    const flat = (t) => t.replace(/\s+/g, " ").trim().toLowerCase();
    const want = flat(spec.text);
    const named = (el) => flat(el.getAttribute("aria-label") || el.title || el.value || el.textContent || "");
    const exact = list.filter((el) => named(el) === want);
    const part = list.filter((el) => named(el).includes(want));
    let hits = exact.length ? exact : part;
    // Keep only the innermost matches: a container shows the text its
    // children show, and clicking the container is not clicking the thing.
    const set = new Set(hits);
    hits = hits.filter((el) => !el.querySelector("*") || ![...el.querySelectorAll("*")].some((d) => set.has(d)));
    // The shortest match wins: "Blur" on a button beats "Blur" inside the
    // panel that contains the button, and hitting the panel would do nothing.
    // Between two of the same length, the one built to be pressed wins: a
    // section header and the button inside it often carry the same word, and
    // the header only folds the section away.
    const rank = (el) =>
      el.matches("button,a,input,select,[role=button],[role=link],[role=menuitem]") ? 0 : el.matches("summary,label,legend,h1,h2,h3,h4") ? 2 : 1;
    list = hits.sort((a, b) => named(a).length - named(b).length || rank(a) - rank(b));
  }
  const el = list[spec.nth || 0];
  if (!el) {
    // What to suggest. The first ten clickable things in document order are
    // almost never near what was asked for -- they are whatever the sidebar
    // happens to hold. Offer the closest names instead, so a wrong guess about
    // the wording is one step from the right one.
    const pool = [...document.querySelectorAll("button,a,input,select,summary,[role],[data-act],.lv-row,.grid-item")].filter(__shown);
    let near = pool;
    if (spec.text) {
      const w = spec.text.replace(/\s+/g, " ").trim().toLowerCase();
      const words = w.split(" ").filter((t) => t.length > 2);
      const name = (el) => (el.getAttribute("aria-label") || el.title || el.value || el.textContent || "").replace(/\s+/g, " ").trim().toLowerCase();
      const hit = (el) => { const n = name(el); return words.filter((t) => n.includes(t)).length; };
      const scored = pool.map((el) => [hit(el), el]).filter(([n]) => n > 0).sort((a, b) => b[0] - a[0]);
      if (scored.length) near = scored.map(([, el]) => el);
    }
    return { ok: false, why: "nothing on screen matches that", candidates: near.slice(0, 10).map(__label) };
  }
  el.scrollIntoView({ block: "center", inline: "center" });
  const r = el.getBoundingClientRect();
  if (r.width < 1 || r.height < 1) return { ok: false, why: "that element has no size on screen" };
  return {
    ok: true,
    x: Math.round(r.left + r.width / 2),
    y: Math.round(r.top + r.height / 2),
    what: __label(el),
    rect: [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)],
    offscreen: r.left < 0 || r.top < 0 || r.right > innerWidth || r.bottom > innerHeight,
  };
};
/**
 * Is something else painted over the middle of this element?
 *
 * An app that covers the screen with a sheet leaves everything underneath in
 * the document, laid out, visible by every style rule and utterly unreachable.
 * Listing those is how a caller ends up clicking the file list behind an open
 * editor and reading the silence as a bug in the app.
 *
 * Scrolled out of view is a different thing and is reported separately, as
 * `clipped` -- but a row scrolled off the bottom of a list that is itself
 * under a sheet is still unreachable, so the question is asked of the nearest
 * ancestor that is on screen rather than of the row.
 */
const __covered = (el) => {
  // Scrolled out of view is not the same as covered -- but if the panel it
  // lives in is under a sheet then it is, so the question is asked of the
  // nearest thing up the tree that is actually on screen.
  let node = el;
  while (node && node !== document.body) {
    const b = node.getBoundingClientRect();
    if (b.right > 0 && b.bottom > 0 && b.left < innerWidth && b.top < innerHeight) break;
    node = node.parentElement;
  }
  if (!node || node === document.body) return false;
  const b = node.getBoundingClientRect();
  const x = Math.min(Math.max(b.left + b.width / 2, 1), innerWidth - 1);
  const y = Math.min(Math.max(b.top + b.height / 2, 1), innerHeight - 1);
  const top = document.elementFromPoint(x, y);
  if (!top) return true;
  return !(top === node || node.contains(top) || top.contains(node));
};
const __shown = (el) => {
  const r = el.getBoundingClientRect();
  if (r.width < 1 || r.height < 1) return false;
  const s = getComputedStyle(el);
  if (s.visibility === "hidden" || s.display === "none" || Number(s.opacity) <= 0.01) return false;
  return !__covered(el);
};
const __label = (el) => {
  const name = (el.getAttribute("aria-label") || el.title || el.placeholder || el.value || el.textContent || "").trim().replace(/\s+/g, " ");
  const id = el.id ? "#" + el.id : "";
  const cls = typeof el.className === "string" && el.className ? "." + el.className.trim().split(/\s+/).join(".") : "";
  return (el.tagName.toLowerCase() + id + cls + (name ? ' "' + name.slice(0, 60) + '"' : "")).slice(0, 140);
};
"##;

fn find_expr(spec: &Value, then: &str) -> String {
    format!("(() => {{ {FIND}\nconst __r = __find({spec});\n{then} }})()")
}

fn spec_from(args: &Map<String, Value>) -> Value {
    let mut spec = Map::new();
    // `sel` as well as `selector`, because `facet_ui_snapshot` calls the field
    // `sel` and the obvious next move is to hand a row of its output straight
    // back. Only `selector` was read, so `sel` was dropped in silence, the aim
    // fell back to "everything clickable on the page" and `nth` counted into
    // that instead -- a click that lands on a real control with a real name,
    // just not the one that was asked for. Nothing about the answer said so.
    for key in ["selector", "sel", "text"] {
        if let Some(v) = text(args, key) {
            spec.insert(if key == "sel" { "selector".into() } else { key.into() }, Value::String(v));
        }
    }
    for key in ["nth", "x", "y"] {
        if let Some(v) = args.get(key).and_then(Value::as_f64) {
            spec.insert(key.into(), json!(v));
        }
    }
    Value::Object(spec)
}

/// Resolve a target and fail loudly if it is not there, so a click on nothing
/// is an error the caller can read rather than a mouse event into empty space.
fn locate(s: &mut Session, args: &Map<String, Value>) -> Result<(f64, f64, Value), String> {
    let spec = spec_from(args);
    let obj = spec.as_object();
    if obj.map_or(true, Map::is_empty) {
        return Err("say what to aim at: `selector`, `text`, or `x` and `y`".into());
    }
    // `nth` on its own counts into every clickable thing on the page, which is
    // never what anyone means -- it is what a misspelt selector decays into.
    if obj.is_some_and(|o| o.contains_key("nth") && !o.contains_key("selector") && !o.contains_key("text")) {
        return Err("`nth` says which match, so say what to match: add `selector` or `text`".into());
    }
    let r = s.eval(&find_expr(&spec, "return __r;"))?;
    if r.get("ok").and_then(Value::as_bool) != Some(true) {
        let why = r.get("why").and_then(Value::as_str).unwrap_or("not found");
        let near = r.get("candidates").cloned().unwrap_or(Value::Null);
        return Err(if near.is_null() {
            why.to_owned()
        } else {
            format!("{why}. On screen right now: {near}")
        });
    }
    let x = r.get("x").and_then(Value::as_f64).unwrap_or(0.0);
    let y = r.get("y").and_then(Value::as_f64).unwrap_or(0.0);
    Ok((x, y, r))
}

fn mouse(s: &mut Session, kind: &str, x: f64, y: f64, buttons: i64, count: i64) -> Result<(), String> {
    s.send(
        "Input.dispatchMouseEvent",
        json!({
            "type": kind,
            "x": x,
            "y": y,
            // The button is which one this is about, `buttons` is what is
            // held down after it. A release says "left, and now nothing is
            // held" -- saying "none" on the release is how a press and a
            // release fail to add up to a click.
            "button": if kind == "mouseMoved" && buttons == 0 { "none" } else { "left" },
            "buttons": buttons,
            // The count is what makes a second click a double click: the page
            // is given `dblclick` by the browser only when it is told this is
            // the second in a row, and two clicks of one are two clicks.
            "clickCount": if kind == "mouseMoved" { 0 } else { count },
            "pointerType": "mouse",
        }),
    )
    .map(|_| ())
}

/// Is the app in its phone layout right now?
fn phone_now(s: &mut Session) -> bool {
    s.eval("document.body.classList.contains(\"fct-phone\")").ok().and_then(|v| v.as_bool()).unwrap_or(false)
}

/// One finger, dispatched as an actual touch.
///
/// The phone layout is touch-only where it matters: the editor's canvas and
/// the viewer's swipes both hang off `touchstart`, and a mouse never reaches
/// them -- dragging on the canvas drew nothing and read as a missing feature.
/// Asking the web view to turn mouse input into touches does not work either;
/// it ignores `Emulation.setTouchEmulationEnabled` outright, and
/// `navigator.maxTouchPoints` stays 0 however politely it is asked. So the
/// events have to be the real thing.
fn touch(s: &mut Session, kind: &str, x: f64, y: f64) -> Result<(), String> {
    let points = if kind == "touchEnd" {
        json!([])
    } else {
        json!([{ "x": x, "y": y, "id": 1, "radiusX": 12, "radiusY": 12, "force": 1 }])
    };
    s.send("Input.dispatchTouchEvent", json!({ "type": kind, "touchPoints": points })).map(|_| ())
}

/// Watch for a click, and say afterwards whether one arrived.
///
/// A real touch screen follows an unhandled tap with a click, which is how a
/// plain button works on a phone at all. Whether this web view does the same
/// is not something to guess at -- guessing wrong means either every button in
/// the phone layout is dead or every one of them fires twice. So the tap is
/// watched, and the mouse is used only to make up a click that did not happen.
fn watch_click(s: &mut Session) -> bool {
    s.eval(
        "(() => { window.__fctClicks = 0; window.__fctSeen = window.__fctSeen || (() => { window.__fctClicks++; }); \
         window.removeEventListener('click', window.__fctSeen, true); \
         window.addEventListener('click', window.__fctSeen, true); return true; })()",
    )
    .is_ok()
}

/// How many clicks the page saw since `watch_click`, after giving it two frames.
fn clicks_seen(s: &mut Session) -> i64 {
    s.eval(
        "new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => { \
           window.removeEventListener('click', window.__fctSeen, true); r(window.__fctClicks || 0); })))",
    )
    .ok()
    .and_then(|v| v.as_i64())
    .unwrap_or(0)
}

/// The keys worth naming. Anything else is typed as a character.
fn vkey(name: &str) -> Option<(i64, &'static str)> {
    Some(match name {
        "Enter" => (13, "Enter"),
        "Escape" => (27, "Escape"),
        "Tab" => (9, "Tab"),
        "Backspace" => (8, "Backspace"),
        "Delete" => (46, "Delete"),
        "ArrowLeft" => (37, "ArrowLeft"),
        "ArrowUp" => (38, "ArrowUp"),
        "ArrowRight" => (39, "ArrowRight"),
        "ArrowDown" => (40, "ArrowDown"),
        "Home" => (36, "Home"),
        "End" => (35, "End"),
        "PageUp" => (33, "PageUp"),
        "PageDown" => (34, "PageDown"),
        "Space" => (32, " "),
        "F1" => (112, "F1"),
        "F2" => (113, "F2"),
        "F3" => (114, "F3"),
        "F5" => (116, "F5"),
        "F11" => (122, "F11"),
        _ => return None,
    })
}

/// A chord: any of ctrl/alt/shift/meta, then one key.
///
/// The app's own help text talks in Ctrl+K and Ctrl+Shift+V, so anything that
/// claims to drive it has to be able to say that back.
struct Chord {
    /// CDP's bitmask: alt 1, ctrl 2, meta 4, shift 8.
    mods: i64,
    code: i64,
    key: String,
    /// What a plain letter types. Empty once a modifier is held, because
    /// Ctrl+K inserts nothing.
    text: String,
}

fn chord(spec: &str) -> Result<Chord, String> {
    let mut mods = 0i64;
    let mut last = "";
    for part in spec.split('+') {
        let p = part.trim();
        if p.is_empty() {
            continue;
        }
        match p.to_ascii_lowercase().as_str() {
            "ctrl" | "control" => mods |= 2,
            "alt" | "option" => mods |= 1,
            "shift" => mods |= 8,
            "meta" | "cmd" | "command" | "win" => mods |= 4,
            _ => last = p,
        }
    }
    if last.is_empty() {
        return Err(format!("`{spec}` names modifiers but no key"));
    }
    // Named keys first, then a single character.
    if let Some((code, key)) = vkey(last) {
        let text = if mods == 0 && key.len() == 1 { key.to_owned() } else { String::new() };
        return Ok(Chord { mods, code, key: key.to_owned(), text });
    }
    let mut chars = last.chars();
    let c = chars.next().ok_or_else(|| format!("`{spec}` is not a key"))?;
    if chars.next().is_some() {
        return Err(format!(
            "`{last}` is not a key this understands — a single character, or Enter, Escape, Tab, Backspace, Delete, the arrows, Home, End, PageUp, PageDown, Space, F1-F11. Combine with Ctrl, Alt, Shift or Meta."
        ));
    }
    let upper = c.to_ascii_uppercase();
    // A capital on its own is typing, and typing a capital means holding shift.
    // A capital behind Ctrl or Alt is not: "Ctrl+K" is how every menu, every
    // help page and this app's own shortcut list spells ctrl and the k key, and
    // reading it as Ctrl+Shift+K sent the caller to the wrong panel -- which is
    // exactly what it did, silently, to me. Shift is held when it is asked for.
    let typing = mods & !8 == 0;
    let shifted = mods & 8 != 0 || (typing && c.is_ascii_uppercase());
    let code = upper as i64;
    let key = if shifted { upper.to_string() } else { c.to_ascii_lowercase().to_string() };
    let text = if typing { key.clone() } else { String::new() };
    Ok(Chord { mods: if shifted { mods | 8 } else { mods }, code, key, text })
}

// ------------------------------------------------------------------ tools

pub fn catalogue() -> Vec<Value> {
    let aim = json!({
        "selector": { "type": "string", "description": "CSS selector for the element" },
        "text": { "type": "string", "description": "visible text, aria-label or title — the shortest match wins" },
        "sel": { "type": "string", "description": "alias for `selector` — what `facet_ui_snapshot` calls it" },
        "nth": { "type": "number", "description": "which match, 0-based (default 0) — counts within `selector`/`text`, and means nothing without one" },
        "x": { "type": "number", "description": "viewport x, if aiming by coordinate" },
        "y": { "type": "number", "description": "viewport y" },
        "port": { "type": "number", "description": "debug port (default 9224; use the forwarded port for a phone)" },
        "target": { "type": "string", "description": "page id, url or title fragment, when more than one window is open" },
    });
    let aim_obj = |extra: Value| -> Value {
        let mut props = aim.as_object().cloned().unwrap_or_default();
        if let Some(more) = extra.as_object() {
            for (k, v) in more {
                props.insert(k.clone(), v.clone());
            }
        }
        json!({ "type": "object", "properties": Value::Object(props) })
    };

    vec![
        json!({
            "name": "facet_ui_open",
            "description": "Start FACET with its debugging port open, or report the one already running. Every other facet_ui_* tool needs this first. A FACET started by hand has no port and cannot be driven — if one is already running, this says so and it has to be closed.",
            "inputSchema": { "type": "object", "properties": {
                "port": { "type": "number", "description": "port to open (default 9224)" },
                "path": { "type": "string", "description": "a file or folder to open in the explorer" },
            }},
        }),
        json!({
            "name": "facet_ui_targets",
            "description": "List the pages that can be driven on a debug port: the explorer window, any pop-outs, or the phone's web view over an adb forward.",
            "inputSchema": { "type": "object", "properties": {
                "port": { "type": "number" },
            }},
        }),
        json!({
            "name": "facet_ui_snapshot",
            "description": "What is on screen: the window's size, the panel that is open, and every visible control with its text and position. Read this before clicking — it is cheaper and more exact than a screenshot, and it names the selectors the other tools take.",
            "inputSchema": { "type": "object", "properties": {
                "port": { "type": "number" },
                "target": { "type": "string" },
                "within": { "type": "string", "description": "CSS selector to limit the snapshot to one panel" },
                "limit": { "type": "number", "description": "most entries to return (default 150)" },
            }},
        }),
        json!({
            "name": "facet_ui_screenshot",
            "description": "A picture of the window as it is now. Use it to check layout — things off the edge of the screen, overlapping text, a panel with no way out — which a snapshot describes but does not show.",
            "inputSchema": { "type": "object", "properties": {
                "port": { "type": "number" },
                "target": { "type": "string" },
                "selector": { "type": "string", "description": "shoot just this element" },
                "scale": { "type": "number", "description": "0.1-1, default 0.6 — smaller is cheaper to read" },
                "quality": { "type": "number", "description": "JPEG quality 1-100, default 70" },
            }},
        }),
        json!({
            "name": "facet_ui_click",
            "description": "A real mouse press and release at an element or coordinate. Real protocol input, so canvas and pointer-event handlers see it exactly as they see a hand.",
            "inputSchema": aim_obj(json!({
                "double": { "type": "boolean", "description": "double-click" },
                "touch": { "type": "boolean", "description": "tap instead of click - on by default in the phone layout, where the canvas and the swipes only listen for touch" },
            })),
        }),
        json!({
            "name": "facet_ui_drag",
            "description": "Press at one point, move, release at another — dragging a blur region, resizing it by its handle, scrubbing a timeline. Moves in steps, because a single jump is not a gesture anything recognises.",
            "inputSchema": aim_obj(json!({
                "to_x": { "type": "number", "description": "where to release (viewport x)" },
                "to_y": { "type": "number" },
                "dx": { "type": "number", "description": "or: how far to move, relative" },
                "dy": { "type": "number" },
                "steps": { "type": "number", "description": "intermediate moves, default 12" },
                "touch": { "type": "boolean", "description": "drag with a finger instead of the mouse - on by default in the phone layout" },
            })),
        }),
        json!({
            "name": "facet_ui_type",
            "description": "Type into a field. Clicks it first if you name one, so the text lands where you meant.",
            "inputSchema": aim_obj(json!({
                "value": { "type": "string", "description": "the text to type" },
                "clear": { "type": "boolean", "description": "empty the field first" },
                "enter": { "type": "boolean", "description": "press Enter afterwards" },
            })),
        }),
        json!({
            "name": "facet_ui_key",
            "description": "Press one key or chord: a single character, or Enter, Escape, Tab, Backspace, Delete, the arrows, Home, End, PageUp, PageDown, Space, F1-F11 — with Ctrl, Alt, Shift or Meta in front, as in \"Ctrl+k\" or \"Ctrl+Shift+V\".",
            "inputSchema": json!({ "type": "object", "properties": {
                "key": { "type": "string" },
                "port": { "type": "number" },
                "target": { "type": "string" },
            }, "required": ["key"] }),
        }),
        json!({
            "name": "facet_ui_phone",
            "description": "Put the window into a phone-shaped viewport — narrow, dense, coarse pointer — so the phone layout can be driven here. This is the layout, not the device: it does not replace testing the APK on a real phone, and Android-only paths (camera, share targets) still need one. Pass off: true to go back.",
            "inputSchema": json!({ "type": "object", "properties": {
                "width": { "type": "number", "description": "CSS px, default 384 (the reference phone)" },
                "height": { "type": "number", "description": "CSS px, default 853" },
                "dpr": { "type": "number", "description": "device pixel ratio, default 2.75" },
                "landscape": { "type": "boolean", "description": "swap the two" },
                "off": { "type": "boolean", "description": "back to the real window" },
                "port": { "type": "number" },
                "target": { "type": "string" },
            }}),
        }),
        json!({
            "name": "facet_ui_wait",
            "description": "Wait until something is true — an element appears, a class goes away, a render finishes. Polls a JavaScript condition rather than sleeping a guessed number of seconds.",
            "inputSchema": json!({ "type": "object", "properties": {
                "selector": { "type": "string", "description": "wait for this to be on screen" },
                "gone": { "type": "boolean", "description": "wait for it to leave instead" },
                "condition": { "type": "string", "description": "or: a JavaScript expression that has to become truthy" },
                "ms": { "type": "number", "description": "or, when there is genuinely nothing to poll: just wait this many milliseconds" },
                "timeout": { "type": "number", "description": "seconds, default 10" },
                "port": { "type": "number" },
                "target": { "type": "string" },
            }}),
        }),
        json!({
            "name": "facet_ui_eval",
            "description": "Run a JavaScript expression in the page and return its value. The way out when a tool above does not fit — reading internal state, resizing the window, forcing the phone layout with ?phone=1.",
            "inputSchema": json!({ "type": "object", "properties": {
                "js": { "type": "string" },
                "port": { "type": "number" },
                "target": { "type": "string" },
            }, "required": ["js"] }),
        }),
        json!({
            "name": "facet_ui_console",
            "description": "Errors and console output the page has produced since this was last called. Installs its own recorder on first use, so call it once before the thing you want to watch.",
            "inputSchema": json!({ "type": "object", "properties": {
                "port": { "type": "number" },
                "target": { "type": "string" },
                "clear": { "type": "boolean", "description": "empty the buffer after reading (default true)" },
            }}),
        }),
    ]
}

/// Answer a `facet_ui_*` call, or `None` if the name is not one of ours.
pub fn call(name: &str, args: &Map<String, Value>) -> Option<Result<Answer, String>> {
    if !name.starts_with("facet_ui_") {
        return None;
    }
    Some(dispatch(name, args))
}

fn dispatch(name: &str, args: &Map<String, Value>) -> Result<Answer, String> {
    match name {
        "facet_ui_open" => open(args),
        "facet_ui_targets" => {
            let port = port_of(args);
            let list: Vec<Value> = targets(port)?
                .into_iter()
                .map(|t| json!({ "id": t.id, "title": t.title, "url": t.url }))
                .collect();
            Ok(Answer::Json(json!({ "port": port, "pages": list })))
        }
        "facet_ui_snapshot" => snapshot(args),
        "facet_ui_screenshot" => screenshot(args),
        "facet_ui_click" => click(args),
        "facet_ui_drag" => drag(args),
        "facet_ui_type" => type_text(args),
        "facet_ui_key" => key(args),
        "facet_ui_phone" => phone(args),
        "facet_ui_wait" => wait(args),
        "facet_ui_eval" => {
            let js = text(args, "js").ok_or("`js` is required")?;
            let mut s = session(args)?;
            Ok(Answer::Json(json!({ "value": s.eval(&js)? })))
        }
        "facet_ui_console" => console(args),
        other => Err(format!("no such tool: {other}")),
    }
}

// ------------------------------------------------------------------- open

fn open(args: &Map<String, Value>) -> Result<Answer, String> {
    let port = port_of(args);
    if let Ok(found) = targets(port) {
        if !found.is_empty() {
            return Ok(Answer::Json(json!({
                "port": port,
                "already": true,
                "pages": found.iter().map(|t| json!({ "id": t.id, "title": t.title, "url": t.url })).collect::<Vec<_>>(),
            })));
        }
    }
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let mut cmd = std::process::Command::new(&exe);
    cmd.env("FACET_UI_PORT", port.to_string());
    if let Some(p) = text(args, "path") {
        cmd.arg(p);
    }
    cmd.spawn().map_err(|e| format!("could not start {}: {e}", exe.display()))?;

    // A cold start has to build a window and load the bundle; ten seconds is
    // generous on a slow disk and still short enough to be a tool call.
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
    while std::time::Instant::now() < deadline {
        if let Ok(found) = targets(port) {
            if !found.is_empty() {
                return Ok(Answer::Json(json!({
                    "port": port,
                    "started": true,
                    "pages": found.iter().map(|t| json!({ "id": t.id, "title": t.title, "url": t.url })).collect::<Vec<_>>(),
                })));
            }
        }
        std::thread::sleep(std::time::Duration::from_millis(250));
    }
    Err(format!(
        "FACET did not open a debugging port on {port}. The usual reason is that a copy is already running: \
         a second launch hands its arguments to the first and exits, and the first was started without \
         FACET_UI_PORT. Close FACET and call this again."
    ))
}

// --------------------------------------------------------------- snapshot

fn snapshot(args: &Map<String, Value>) -> Result<Answer, String> {
    let within = text(args, "within").unwrap_or_default();
    let limit = num(args, "limit", 150.0);
    let js = SNAPSHOT
        .replace("%WITHIN%", &serde_json::to_string(&within).unwrap_or_else(|_| "\"\"".into()))
        .replace("%LIMIT%", &limit.to_string());
    let mut s = session(args)?;
    Ok(Answer::Json(s.eval(&js)?))
}

const SNAPSHOT: &str = r##"(() => {
  const root = %WITHIN% ? document.querySelector(%WITHIN%) : document.body;
  if (!root) return { error: "no element matches " + %WITHIN% };
  // Covered by a sheet, a dialog, the editor: laid out, styled visible, and
  // not on screen. Listing those was how a caller ended up driving the file
  // list underneath an open editor and reading the silence as a bug.
  const covered = (el) => {
    // Scrolled out of view is not the same as covered -- but if the panel it
    // lives in is under a sheet then it is, so the question is asked of the
    // nearest thing up the tree that is actually on screen.
    let node = el;
    while (node && node !== document.body) {
      const b = node.getBoundingClientRect();
      if (b.right > 0 && b.bottom > 0 && b.left < innerWidth && b.top < innerHeight) break;
      node = node.parentElement;
    }
    if (!node || node === document.body) return false;
    const b = node.getBoundingClientRect();
    const x = Math.min(Math.max(b.left + b.width / 2, 1), innerWidth - 1);
    const y = Math.min(Math.max(b.top + b.height / 2, 1), innerHeight - 1);
    const top = document.elementFromPoint(x, y);
    if (!top) return true;
    return !(top === node || node.contains(top) || top.contains(node));
  };
  const shown = (el) => {
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return false;
    const s = getComputedStyle(el);
    return s.visibility !== "hidden" && s.display !== "none" && Number(s.opacity) > 0.01;
  };
  let behind = 0;
  const name = (el) => (el.getAttribute("aria-label") || el.title || el.placeholder ||
    (el.tagName === "INPUT" || el.tagName === "TEXTAREA" ? el.value : "") ||
    [...el.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent).join(" ") ||
    el.textContent || "").trim().replace(/\s+/g, " ").slice(0, 80);
  const sel = (el) => {
    if (el.id) return "#" + el.id;
    const cls = typeof el.className === "string" ? el.className.trim().split(/\s+/).filter(Boolean) : [];
    const base = el.tagName.toLowerCase() + (cls.length ? "." + cls.join(".") : "");
    const same = [...document.querySelectorAll(base)];
    return same.length > 1 ? base + " [" + same.indexOf(el) + "]" : base;
  };
  const interactive = "button,a,input,select,textarea,label,summary,canvas,video,[role],[tabindex],[contenteditable]";
  const out = [];
  const seen = new Set();
  for (const el of root.querySelectorAll(interactive)) {
    if (out.length >= %LIMIT%) break;
    if (!shown(el) || seen.has(el)) continue;
    seen.add(el);
    if (covered(el)) { behind++; continue; }
    const r = el.getBoundingClientRect();
    const row = {
      sel: sel(el),
      name: name(el),
      at: [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)],
    };
    if (el.disabled) row.disabled = true;
    if (el.checked) row.checked = true;
    if (el.getAttribute("aria-pressed") === "true" || el.classList.contains("on") || el.classList.contains("active")) row.pressed = true;
    // Anything past the edge is the bug that keeps happening: a Close button
    // no thumb can reach, a hex row running off the side of the phone.
    if (r.right > innerWidth + 1 || r.bottom > innerHeight + 1 || r.left < -1 || r.top < -1) {
      row.clipped = [Math.round(r.right - innerWidth), Math.round(r.bottom - innerHeight)];
    }
    out.push(row);
  }
  const overflow = [...root.querySelectorAll("*")].filter((el) =>
    shown(el) && (el.scrollWidth > el.clientWidth + 2) && getComputedStyle(el).overflowX === "hidden" && !covered(el)
  ).slice(0, 8).map((el) => ({ sel: sel(el), hidden_px: el.scrollWidth - el.clientWidth }));
  return {
    url: location.href,
    title: document.title,
    viewport: [innerWidth, innerHeight, devicePixelRatio],
    phone: document.body.classList.contains("fct-phone"),
    // Said out loud rather than quietly dropped, so "the panel I wanted is
    // missing" is answerable: it is under whatever is on top.
    behind_something: behind,
    body_classes: document.body.className,
    panel: document.querySelector(".fct-phone-panel:not([hidden])")?.className || null,
    scrolls_sideways_but_cannot: overflow,
    controls: out,
  };
})()"##;

// ------------------------------------------------------------- screenshot

fn screenshot(args: &Map<String, Value>) -> Result<Answer, String> {
    let mut s = session(args)?;
    let scale = num(args, "scale", 0.6).clamp(0.1, 1.0);
    let quality = num(args, "quality", 70.0).clamp(1.0, 100.0);
    let mut params = json!({ "format": "jpeg", "quality": quality });
    if let Some(sel) = text(args, "selector") {
        let spec = json!({ "selector": sel });
        let r = s.eval(&find_expr(&spec, "return __r;"))?;
        let rect = r.get("rect").and_then(Value::as_array).cloned().unwrap_or_default();
        if rect.len() == 4 {
            params["clip"] = json!({
                "x": rect[0], "y": rect[1], "width": rect[2], "height": rect[3], "scale": scale,
            });
        }
    } else {
        // No clip means "the viewport at its own size", so the scale goes on a
        // clip that is the viewport.
        let v = s.eval("[innerWidth, innerHeight]")?;
        let w = v.get(0).and_then(Value::as_f64).unwrap_or(1280.0);
        let h = v.get(1).and_then(Value::as_f64).unwrap_or(800.0);
        params["clip"] = json!({ "x": 0, "y": 0, "width": w, "height": h, "scale": scale });
    }
    let r = s.send("Page.captureScreenshot", params)?;
    let b64 = r.get("data").and_then(Value::as_str).ok_or("the page returned no image")?;
    Ok(Answer::Image { b64: b64.to_owned(), mime: "image/jpeg" })
}

// ------------------------------------------------------------------ input

fn click(args: &Map<String, Value>) -> Result<Answer, String> {
    let mut s = session(args)?;
    let (x, y, hit) = locate(&mut s, args)?;
    let times = if args.get("double").and_then(Value::as_bool) == Some(true) { 2 } else { 1 };
    // A finger in the phone layout, a mouse everywhere else, unless the caller
    // says otherwise. `touch` is there for the one case the layout cannot tell
    // you about: a surface that wants the other kind.
    let touching = args.get("touch").and_then(Value::as_bool).unwrap_or_else(|| phone_now(&mut s));
    let mut how = "mouse";
    if touching {
        let watching = watch_click(&mut s);
        for _ in 0..times {
            touch(&mut s, "touchStart", x, y)?;
            touch(&mut s, "touchEnd", x, y)?;
        }
        how = "touch";
        // No click out of the tap means this web view does not make one, so
        // the button would never have fired. One is sent, and only then.
        if watching && clicks_seen(&mut s) == 0 {
            how = "touch+click";
            mouse(&mut s, "mouseMoved", x, y, 0, 0)?;
            for n in 1..=times {
                mouse(&mut s, "mousePressed", x, y, 1, n)?;
                mouse(&mut s, "mouseReleased", x, y, 0, n)?;
            }
        }
    } else {
        mouse(&mut s, "mouseMoved", x, y, 0, 0)?;
        for n in 1..=times {
            mouse(&mut s, "mousePressed", x, y, 1, n)?;
            mouse(&mut s, "mouseReleased", x, y, 0, n)?;
        }
    }
    // Give the app a frame to react, then say what the click actually did —
    // "clicked" on its own is not evidence of anything.
    let after = s.eval("new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r({ panel: document.querySelector('.fct-phone-panel:not([hidden])')?.className || null, toast: document.querySelector('.fct-toast, .fct-say')?.textContent?.trim() || null }))))")?;
    Ok(Answer::Json(json!({ "clicked": hit.get("what"), "at": [x, y], "as": how, "then": after })))
}

fn drag(args: &Map<String, Value>) -> Result<Answer, String> {
    let mut s = session(args)?;
    let (x, y, hit) = locate(&mut s, args)?;
    let (tx, ty) = match (args.get("to_x"), args.get("to_y")) {
        (Some(a), Some(b)) => (a.as_f64().unwrap_or(x), b.as_f64().unwrap_or(y)),
        _ => (x + num(args, "dx", 0.0), y + num(args, "dy", 0.0)),
    };
    if (tx - x).abs() < 0.5 && (ty - y).abs() < 0.5 {
        return Err("a drag that goes nowhere: give `to_x`/`to_y` or `dx`/`dy`".into());
    }
    let steps = num(args, "steps", 12.0).clamp(2.0, 60.0) as i32;
    let touching = args.get("touch").and_then(Value::as_bool).unwrap_or_else(|| phone_now(&mut s));
    if touching {
        touch(&mut s, "touchStart", x, y)?;
        for i in 1..=steps {
            let f = f64::from(i) / f64::from(steps);
            touch(&mut s, "touchMove", x + (tx - x) * f, y + (ty - y) * f)?;
        }
        touch(&mut s, "touchEnd", tx, ty)?;
    } else {
        mouse(&mut s, "mouseMoved", x, y, 0, 0)?;
        mouse(&mut s, "mousePressed", x, y, 1, 1)?;
        for i in 1..=steps {
            let f = f64::from(i) / f64::from(steps);
            mouse(&mut s, "mouseMoved", x + (tx - x) * f, y + (ty - y) * f, 1, 0)?;
        }
        mouse(&mut s, "mouseReleased", tx, ty, 0, 1)?;
    }
    let how = if touching { "touch" } else { "mouse" };
    Ok(Answer::Json(json!({ "dragged": hit.get("what"), "from": [x, y], "to": [tx, ty], "as": how })))
}

fn type_text(args: &Map<String, Value>) -> Result<Answer, String> {
    let value = text(args, "value").ok_or("`value` is required")?;
    let mut s = session(args)?;
    let mut aimed = Value::Null;
    if !spec_from(args).as_object().map_or(true, Map::is_empty) {
        let (x, y, hit) = locate(&mut s, args)?;
        mouse(&mut s, "mousePressed", x, y, 1, 1)?;
        mouse(&mut s, "mouseReleased", x, y, 0, 1)?;
        aimed = hit.get("what").cloned().unwrap_or(Value::Null);
    }
    if args.get("clear").and_then(Value::as_bool) == Some(true) {
        s.eval(
            "(() => { const el = document.activeElement; if (!el) return false; \
             el.select?.(); el.value = ''; el.dispatchEvent(new Event('input', { bubbles: true })); return true; })()",
        )?;
    }
    s.send("Input.insertText", json!({ "text": value }))?;
    if args.get("enter").and_then(Value::as_bool) == Some(true) {
        press(&mut s, "Enter")?;
    }
    let now = s.eval("document.activeElement?.value ?? null")?;
    Ok(Answer::Json(json!({ "typed": value, "into": aimed, "field_now": now })))
}

fn press(s: &mut Session, name: &str) -> Result<(), String> {
    let c = chord(name)?;
    // `keyDown` rather than `rawKeyDown` when there is text, because that is
    // the event a plain character rides in on; a chord carries no text and
    // `rawKeyDown` is what a shortcut listener expects.
    let down = if c.text.is_empty() { "rawKeyDown" } else { "keyDown" };
    for kind in [down, "keyUp"] {
        let mut ev = json!({
            "type": kind,
            "key": c.key,
            "windowsVirtualKeyCode": c.code,
            "nativeVirtualKeyCode": c.code,
            "modifiers": c.mods,
        });
        if kind == "keyDown" {
            ev["text"] = json!(c.text);
            ev["unmodifiedText"] = json!(c.text);
        }
        s.send("Input.dispatchKeyEvent", ev)?;
    }
    Ok(())
}

/// A phone-shaped viewport.
///
/// `isPhone()` asks for a coarse pointer as well as a narrow window -- a
/// desktop window dragged narrow is deliberately still a desktop -- so the
/// metrics override alone would not do it. `mobile: true` plus touch emulation
/// is what makes `pointer: coarse` answer yes.
/// Reload and wait for the app to mount again, so what follows reads a real page.
fn reload(s: &mut Session) -> Result<(), String> {
    s.send("Page.reload", json!({ "ignoreCache": false }))?;
    for _ in 0..100 {
        std::thread::sleep(std::time::Duration::from_millis(100));
        if s.eval("document.readyState === \"complete\" && !!document.querySelector(\"body > div\")") == Ok(Value::Bool(true)) {
            // Mounted, but the first paint is a frame away.
            std::thread::sleep(std::time::Duration::from_millis(400));
            return Ok(());
        }
    }
    Err("the page did not come back after reloading".into())
}

fn phone(args: &Map<String, Value>) -> Result<Answer, String> {
    let mut s = session(args)?;
    if args.get("off").and_then(Value::as_bool).unwrap_or(false) {
        // Clearing is what the protocol says and it is not enough here: this
        // web view keeps the width and gives back only the scale factor, so
        // the layout goes back to desktop inside a 384 px page and every
        // measurement after it is a lie. Zero is the documented "no override",
        // and sending it explicitly is what actually lets go of the size.
        s.send(
            "Emulation.setDeviceMetricsOverride",
            json!({ "width": 0, "height": 0, "deviceScaleFactor": 0, "mobile": false }),
        )?;
        s.send("Emulation.clearDeviceMetricsOverride", json!({}))?;
        s.send("Emulation.setTouchEmulationEnabled", json!({ "enabled": false }))?;
        let _ = s.send(
            "Emulation.setEmitTouchEventsForMouse",
            json!({ "enabled": false, "configuration": "desktop" }),
        );
        s.eval("sessionStorage.setItem(\"fct.phone\", \"0\"), 1")?;
        reload(&mut s)?;
        let view = s.eval("[innerWidth, innerHeight, devicePixelRatio]")?;
        let stuck = s.eval("innerWidth < outerWidth - 40")? == Value::Bool(true);
        let mut out = json!({
            "phone_layout": s.eval("document.body.classList.contains(\"fct-phone\")")?,
            "viewport": view,
        });
        if stuck {
            out["warning"] = json!("the page is still narrower than the window — the size override did not let go");
        }
        return Ok(Answer::Json(out));
    }
    let mut w = num(args, "width", 384.0);
    let mut h = num(args, "height", 853.0);
    if args.get("landscape").and_then(Value::as_bool).unwrap_or(false) {
        std::mem::swap(&mut w, &mut h);
    }
    s.send(
        "Emulation.setDeviceMetricsOverride",
        json!({
            "width": w.round() as i64,
            "height": h.round() as i64,
            "deviceScaleFactor": num(args, "dpr", 2.75),
            "mobile": true,
        }),
    )?;
    // Asked for, and ignored: this web view leaves `navigator.maxTouchPoints`
    // at 0 whatever it is told, so neither this nor
    // `Emulation.setEmitTouchEventsForMouse` makes a dispatched mouse arrive
    // as a touch. Sent anyway because it costs nothing and a shell that does
    // honour it gets the more faithful page. What actually makes taps into
    // touches is `facet_ui_click` and `facet_ui_drag` dispatching real touch
    // events while the phone layout is on -- see `touch`.
    let _ = s.send("Emulation.setTouchEmulationEnabled", json!({ "enabled": true, "maxTouchPoints": 5 }));
    let _ = s.send(
        "Emulation.setEmitTouchEventsForMouse",
        json!({ "enabled": true, "configuration": "mobile" }),
    );
    // A narrow viewport is only half of `isPhone()`; the other half is
    // `pointer: coarse`, and WebView2 does not move that media query when it is
    // told to emulate touch. So use the app's own override, which exists for
    // exactly this -- working on the phone layout from a desktop browser.
    //
    // It is read once when the module loads, deliberately: two shells
    // disagreeing about which of them is mounted is worse than a reload. So
    // reload, rather than poking at a live page and getting half of each.
    s.eval("sessionStorage.setItem(\"fct.phone\", \"1\"), 1")?;
    reload(&mut s)?;
    let is = s.eval("document.body.classList.contains(\"fct-phone\")")?;
    Ok(Answer::Json(json!({
        "viewport": [w, h],
        "phone_layout": is,
        // Said out loud, because the difference is the difference between
        // "tapping the picture does nothing" meaning a bug and meaning this.
        // True because click and drag dispatch touches here, not because the
        // web view emulates anything: it does not.
        "taps_are_touches": is == Value::Bool(true),
        "note": if is == Value::Bool(true) { "the app is in its phone layout" } else { "the viewport changed but the app did not switch — check isPhone()" },
        "reminder": "this is the phone layout on a desktop web view. It is not a phone, and it does not replace running the APK.",
    })))
}

fn key(args: &Map<String, Value>) -> Result<Answer, String> {
    let name = text(args, "key").ok_or("`key` is required")?;
    let mut s = session(args)?;
    press(&mut s, &name)?;
    Ok(Answer::Json(json!({ "pressed": name })))
}

// ------------------------------------------------------------------- wait

fn wait(args: &Map<String, Value>) -> Result<Answer, String> {
    let timeout = num(args, "timeout", 10.0).clamp(0.5, 60.0);
    let gone = args.get("gone").and_then(Value::as_bool) == Some(true);
    let cond = match (text(args, "condition"), text(args, "selector")) {
        (Some(js), _) => js,
        (None, Some(sel)) => {
            let q = serde_json::to_string(&sel).unwrap_or_default();
            if gone {
                format!("!document.querySelector({q}) || document.querySelector({q}).getBoundingClientRect().width < 1")
            } else {
                format!("!!document.querySelector({q}) && document.querySelector({q}).getBoundingClientRect().width > 0")
            }
        }
        // A flat delay is the honest answer when there is nothing to poll --
        // a model warming up, an animation, a debounce. Better to say so than
        // to invent a condition that is really a sleep in disguise.
        _ => match args.get("ms").and_then(Value::as_f64) {
            Some(ms) => {
                std::thread::sleep(std::time::Duration::from_millis(ms.clamp(0.0, 120_000.0) as u64));
                return Ok(Answer::Json(json!({ "waited": ms })));
            }
            None => return Err("give a `selector`, a `condition`, or `ms`".into()),
        },
    };
    let mut s = session(args)?;
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs_f64(timeout);
    let mut polls = 0;
    loop {
        polls += 1;
        let v = s.eval(&format!("!!({cond})"))?;
        if v.as_bool() == Some(true) {
            return Ok(Answer::Json(json!({ "waited_for": cond, "polls": polls })));
        }
        if std::time::Instant::now() > deadline {
            return Err(format!("still not true after {timeout}s: {cond}"));
        }
        std::thread::sleep(std::time::Duration::from_millis(150));
    }
}

// ---------------------------------------------------------------- console

fn console(args: &Map<String, Value>) -> Result<Answer, String> {
    let clear = args.get("clear").and_then(Value::as_bool).unwrap_or(true);
    let mut s = session(args)?;
    let js = CONSOLE.replace("%CLEAR%", if clear { "true" } else { "false" });
    let out = s.eval(&js)?;
    Ok(Answer::Json(out))
}

const CONSOLE: &str = r##"(() => {
  if (!window.__fctLog) {
    const buf = [];
    window.__fctLog = buf;
    for (const level of ["log", "info", "warn", "error"]) {
      const was = console[level].bind(console);
      console[level] = (...a) => {
        try {
          buf.push(level + ": " + a.map((x) => {
            if (x instanceof Error) return x.stack || x.message;
            if (typeof x === "object") { try { return JSON.stringify(x).slice(0, 300); } catch (e) { return String(x); } }
            return String(x);
          }).join(" ").slice(0, 500));
          if (buf.length > 400) buf.splice(0, buf.length - 400);
        } catch (e) { /* a broken recorder must never break the app */ }
        was(...a);
      };
    }
    addEventListener("error", (e) => buf.push("uncaught: " + (e.error?.stack || e.message)));
    addEventListener("unhandledrejection", (e) => buf.push("unhandled promise: " + (e.reason?.stack || e.reason)));
    return { installed: true, lines: [], note: "recording from now on — call again after doing the thing you want to watch" };
  }
  const lines = window.__fctLog.slice();
  if (%CLEAR%) window.__fctLog.length = 0;
  return { installed: false, lines: lines };
})()"##;

// ------------------------------------------------------------------ tests

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_ui_tool_has_a_description_and_a_schema() {
        for t in catalogue() {
            let name = t["name"].as_str().expect("a name");
            assert!(name.starts_with("facet_ui_"), "{name} is not one of ours");
            assert!(t["description"].as_str().unwrap_or("").len() > 30, "{name} needs a real description");
            assert_eq!(t["inputSchema"]["type"], "object", "{name} needs an object schema");
        }
    }

    #[test]
    fn aiming_at_nothing_is_refused_rather_than_clicked() {
        // No port is open in a test run, so this must fail on the argument
        // check before it ever tries to connect.
        let empty = Map::new();
        let spec = spec_from(&empty);
        assert!(spec.as_object().expect("an object").is_empty());
    }

    #[test]
    fn a_name_that_is_not_ours_is_left_alone() {
        assert!(call("facet_list_dir", &Map::new()).is_none());
    }

    #[test]
    fn a_capital_behind_ctrl_is_spelling_not_a_held_shift() {
        // "Ctrl+K" is how the app's own shortcut list writes it, and it is the
        // palette. Ctrl+Shift+K is a different shortcut entirely.
        let k = chord("Ctrl+K").expect("a chord");
        assert_eq!(k.mods, 2, "no shift");
        assert_eq!(k.key, "k");
        assert_eq!(k.text, "", "a shortcut types nothing");
        assert_eq!(chord("Ctrl+k").expect("a chord").mods, 2);
        assert_eq!(chord("Ctrl+Shift+K").expect("a chord").mods, 10, "shift when asked for");
        assert_eq!(chord("Ctrl+Shift+K").expect("a chord").key, "K");
    }

    #[test]
    fn a_capital_on_its_own_is_typed_with_shift() {
        let k = chord("K").expect("a chord");
        assert_eq!(k.mods, 8);
        assert_eq!(k.key, "K");
        assert_eq!(k.text, "K");
        let lower = chord("k").expect("a chord");
        assert_eq!(lower.mods, 0);
        assert_eq!(lower.text, "k");
    }

    #[test]
    fn the_keys_worth_naming_all_map_to_a_code() {
        for k in ["Enter", "Escape", "Tab", "ArrowDown", "PageUp", "Space"] {
            assert!(vkey(k).is_some(), "{k}");
        }
        assert!(vkey("F13").is_none());
    }
}
