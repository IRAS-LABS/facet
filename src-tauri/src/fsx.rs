//! Real filesystem access for the explorer.
//!
//! This is deliberately hand-written rather than the `tauri-plugin-fs` route.
//! The plugin gives you `readDir` + `stat` as separate round-trips, which means
//! a 4000-file folder costs 4001 IPC hops and the canvas sits empty for a
//! second. `std::fs::read_dir` already hands back a `DirEntry` carrying the
//! metadata, so one command returns the whole listing with sizes and dates
//! attached — one hop, no N+1.
//!
//! Nothing here classifies files. Kind detection lives in TypeScript
//! (`core/explorer/types.ts`) so the Android adapter, which will get its
//! listings from Kotlin, produces identical `FileEntry` objects without the
//! rules being written twice.

use std::fs;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

use serde::Serialize;

#[cfg(windows)]
use std::os::windows::fs::MetadataExt;
#[cfg(windows)]
const FILE_ATTRIBUTE_HIDDEN: u32 = 0x2;
#[cfg(windows)]
const FILE_ATTRIBUTE_SYSTEM: u32 = 0x4;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RawEntry {
    name: String,
    path: String,
    is_dir: bool,
    /// `None` for directories — computing a recursive size on every listing
    /// would turn opening C:\ into a disk crawl.
    size: Option<u64>,
    /// Milliseconds since the Unix epoch, or `None` if the OS won't say.
    modified: Option<f64>,
    hidden: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Listing {
    path: String,
    parent: Option<String>,
    entries: Vec<RawEntry>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RawPlace {
    id: String,
    name: String,
    path: String,
    icon: String,
    /// Free / total bytes, drives only. `None` keeps the UI from drawing a bar.
    free: Option<u64>,
    total: Option<u64>,
}

/// Forward slashes everywhere, including on Windows.
///
/// The whole TypeScript side splits paths on `/` for breadcrumbs and joins the
/// same way. Windows accepts forward slashes in every API that matters, so
/// normalising here means the explorer never carries two path dialects.
fn norm(p: &Path) -> String {
    p.to_string_lossy().replace('\\', "/")
}

fn is_hidden(meta: &fs::Metadata, name: &str) -> bool {
    #[cfg(windows)]
    {
        let a = meta.file_attributes();
        if a & (FILE_ATTRIBUTE_HIDDEN | FILE_ATTRIBUTE_SYSTEM) != 0 {
            return true;
        }
    }
    #[cfg(not(windows))]
    let _ = meta;
    name.starts_with('.')
}

fn millis(meta: &fs::Metadata) -> Option<f64> {
    meta.modified()
        .ok()?
        .duration_since(UNIX_EPOCH)
        .ok()
        .map(|d| d.as_millis() as f64)
}

/// One directory, one IPC hop, metadata included.
///
/// Unreadable children are skipped rather than failing the whole listing —
/// a single permission-denied junction in C:\ must not blank the window.
#[tauri::command]
pub fn list_dir(path: String) -> Result<Listing, String> {
    let dir = PathBuf::from(&path);
    let read = fs::read_dir(&dir).map_err(|e| format!("{path}: {e}"))?;

    let mut entries = Vec::new();
    for item in read.flatten() {
        let Ok(meta) = item.metadata() else { continue };
        let name = item.file_name().to_string_lossy().into_owned();
        let is_dir = meta.is_dir();
        entries.push(RawEntry {
            hidden: is_hidden(&meta, &name),
            path: norm(&item.path()),
            name,
            is_dir,
            size: if is_dir { None } else { Some(meta.len()) },
            modified: millis(&meta),
        });
    }

    Ok(Listing {
        parent: dir.parent().map(norm),
        path: norm(&dir),
        entries,
    })
}

/// One media file found by `scan_media`, with its folder already attached.
///
/// `folder` and `folder_name` are carried rather than derived on the TypeScript
/// side because the Albums tab groups by them: re-splitting 20,000 paths in JS
/// to recover something the walk already knew is work done twice.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaHit {
    name: String,
    path: String,
    size: u64,
    modified: Option<f64>,
    folder: String,
    folder_name: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaScan {
    hits: Vec<MediaHit>,
    /// Directories actually descended into. Useful for "scanned 412 folders".
    dirs_visited: usize,
    /// True when a cap stopped the walk early, so the UI can say "showing the
    /// most recent N" instead of implying it found everything there is.
    truncated: bool,
    /// Contents of every `.facet-trash` folder the walk passed, newest first.
    /// Collected on the same walk because a second one would double the most
    /// expensive operation in the app to list a folder that is usually empty.
    trash: Vec<MediaHit>,
}

/// Folder names that are never worth walking on a phone or a desktop.
///
/// `.thumbnails` and `.trashed*` are the two that matter most on Android: the
/// first is a cache of the very images being scanned (so every photo would
/// appear twice, once as a 128px copy) and the second is the recycle bin, whose
/// contents the user deleted on purpose and must not see back in their gallery.
/// `Android/data` and `Android/obb` are per-app sandboxes — thousands of
/// directories, unreadable without special access, and nothing a person thinks
/// of as "my photos".
fn skip_dir(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    matches!(
        lower.as_str(),
        ".thumbnails" | ".trash" | "cache" | "caches" | ".cache"
            | "node_modules" | ".git" | "obb" | "$recycle.bin"
            | "system volume information"
    ) || lower.starts_with(".trashed")
}

/// Every media file under a set of roots, newest first, in one IPC hop.
///
/// This exists because a gallery is not a directory listing. "All my photos"
/// spans DCIM, Pictures, Download, and a folder per app that ever saved an
/// image, and answering it by calling `list_dir` per directory from TypeScript
/// costs one IPC round-trip per folder — hundreds of them before the first tile
/// can be drawn. The walk belongs on this side of the bridge.
///
/// Three caps keep it bounded, because these roots are user-supplied and
/// `/sdcard` on a full phone is not a small tree:
///
/// * `max_depth` — how far below each root to descend.
/// * `limit` — how many hits to keep. The walk still *finishes* when this is
///   hit rather than returning early, because the results are sorted by date at
///   the end and stopping early would return an arbitrary set rather than the
///   newest one. What it stops doing is growing the vector.
/// * `budget_ms` — a wall-clock ceiling. A scan that runs into a network mount
///   or a pathological tree returns what it has and says so, instead of leaving
///   the gallery on a spinner forever.
///
/// Symlinked directories are not followed. A single loop (`a/b -> a`) would
/// otherwise walk until the depth cap on every branch, and on Android the
/// storage emulation layer has real ones — `/sdcard` is itself a link.
/// Off the IPC thread, always.
///
/// This is the single most expensive command in the app -- a full walk of the
/// card is 716 directories and fourteen thousand files, and on the phone it
/// takes about nine seconds. Declared as a plain `fn` it ran on the thread that
/// dispatches commands, so for those nine seconds *every other* `invoke` was
/// simply queued behind it: measured on device, the gallery had its first nine
/// hundred photos on screen at 2.4 s and could not fetch a single thumbnail
/// until 11.4 s, because each thumbnail is an `invoke` and the walk owned the
/// channel. The grid was up and blank for nine seconds and it looked exactly
/// like a slow scan, which is why this was mis-diagnosed twice.
///
/// `spawn_blocking` puts the walk on the blocking pool, where taking nine
/// seconds inconveniences nobody.
#[tauri::command]
pub async fn scan_media(
    roots: Vec<String>,
    exts: Vec<String>,
    max_depth: usize,
    limit: usize,
    budget_ms: u64,
) -> Result<MediaScan, String> {
    tauri::async_runtime::spawn_blocking(move || {
        scan_media_blocking(roots, exts, max_depth, limit, budget_ms)
    })
    .await
    .map_err(|e| e.to_string())?
}

fn scan_media_blocking(
    roots: Vec<String>,
    exts: Vec<String>,
    max_depth: usize,
    limit: usize,
    budget_ms: u64,
) -> Result<MediaScan, String> {
    use std::collections::HashSet;
    use std::sync::{Arc, Mutex};
    use std::time::{Duration, Instant};

    let started = Instant::now();
    let wanted: HashSet<String> =
        exts.iter().map(|e| e.trim_start_matches('.').to_ascii_lowercase()).collect();

    // Everything the walkers share, behind one lock that is held only for
    // bookkeeping -- never across a `read_dir` or a `stat`.
    struct Shared {
        /// Directories still to walk. `pop()` takes the most recently pushed.
        stack: Vec<(PathBuf, usize)>,
        /// Roots can overlap (a user pinning both /sdcard and /sdcard/DCIM is
        /// ordinary), and without this every file under the narrower one is
        /// found twice and the grid shows visible duplicates.
        seen_dirs: HashSet<String>,
        /// Walkers currently inside a directory. The walk is over when the
        /// stack is empty *and* nobody is about to push more onto it.
        busy: usize,
        dirs_visited: usize,
        truncated: bool,
        trash: Vec<MediaHit>,
    }

    // Reversed, because the loop below is `stack.pop()` -- so pushing the roots
    // in order makes the LAST one the first walked. That silently inverted the
    // priority the caller wrote down: with the phone's list, `DCIM` was declared
    // first and scanned last, behind Instagram, Telegram, WhatsApp and Snapchat.
    // Every budget that ran out did so before reaching the camera roll, which is
    // the one folder the gallery opens onto. Seeding in reverse makes the walk
    // follow the declared order, so a truncated scan is truncated at the end the
    // caller cares least about.
    let shared = Arc::new(Mutex::new(Shared {
        stack: roots.iter().rev().map(|r| (PathBuf::from(r), 0usize)).collect(),
        seen_dirs: HashSet::new(),
        busy: 0,
        dirs_visited: 0,
        truncated: false,
        trash: Vec::new(),
    }));

    // Four walkers, not one. The walk is not CPU work: it is one `readdir` and
    // one `stat` per kept file against Android's FUSE mount, each a third of
    // a millisecond of waiting on the storage daemon. Measured single-threaded
    // at about nine seconds for 716 directories and fourteen thousand files,
    // almost all of it that waiting -- and FUSE serves independent requests
    // concurrently, so four walkers sharing one stack finish in a fraction of
    // the time. Not more: the daemon has its own thread pool and past four the
    // walkers queue on it instead of on the disk. Priority is preserved in the
    // large -- the hot roots are still popped first -- and the newest-first
    // order the caller sees is the sort at the end anyway.
    let walkers = 4usize;

    let per_thread: Vec<Vec<MediaHit>> = std::thread::scope(|scope| {
        let handles: Vec<_> = (0..walkers)
            .map(|_| {
                let shared = Arc::clone(&shared);
                let wanted = &wanted;
                scope.spawn(move || {
                    let mut hits: Vec<MediaHit> = Vec::new();
                    loop {
                        // Take a directory, or learn that the walk is over.
                        let job = {
                            let mut g = shared.lock().unwrap_or_else(|e| e.into_inner());
                            if started.elapsed().as_millis() as u64 > budget_ms && !g.stack.is_empty() {
                                g.truncated = true;
                                g.stack.clear();
                            }
                            loop {
                                match g.stack.pop() {
                                    Some((dir, depth)) => {
                                        if !g.seen_dirs.insert(norm(&dir)) {
                                            continue;
                                        }
                                        g.busy += 1;
                                        break Some((dir, depth));
                                    }
                                    None => break None,
                                }
                            }
                        };
                        let Some((dir, depth)) = job else {
                            let g = shared.lock().unwrap_or_else(|e| e.into_inner());
                            if g.busy == 0 {
                                break;
                            }
                            drop(g);
                            // Another walker is inside a directory and may push
                            // children; the wait is a millisecond, the walk is
                            // seconds.
                            std::thread::sleep(Duration::from_millis(1));
                            continue;
                        };

                        let mut children: Vec<(PathBuf, usize)> = Vec::new();
                        let mut trash_here: Vec<MediaHit> = Vec::new();
                        let mut truncated_here = false;
                        let mut visited = false;

                        // `.nomedia` is Android's opt-out marker: an app drops it in a
                        // folder to say "these files are not the user's media, keep
                        // them out of the gallery". WhatsApp's `Backup Excluded
                        // Stickers` folder is the case that forced this check -- 241
                        // animated-sticker bundles that are ZIP archives wearing a
                        // `.webp` extension, undecodable by anything, all stamped with
                        // the folder's date so they flooded one day of the roll with
                        // permanently blank tiles. The marker applies to the whole
                        // subtree (that is how MediaStore treats it), which is why
                        // this skips before any children are pushed. Cost: one `stat`
                        // per directory, hundreds of times cheaper than listing even
                        // one junk folder.
                        //
                        // An unreadable folder is the normal case on Android, not an
                        // error: scoped storage denies most of `/sdcard` to an app
                        // without MANAGE_EXTERNAL_STORAGE. Skipping it keeps the
                        // folders that *are* granted showing rather than failing the
                        // whole gallery.
                        if !dir.join(".nomedia").exists() {
                            if let Ok(read) = fs::read_dir(&dir) {
                                visited = true;

                                // Names descending, not readdir order. `readdir` hands
                                // back whatever the filesystem's internal layout is,
                                // which on a FUSE-mounted card is effectively random --
                                // and a capped scan keeps the FIRST `limit` hits it
                                // meets, so its "newest 300" were an arbitrary 300, and
                                // the gallery opened on the 30th of April for a second
                                // before the full walk corrected it. Every camera app
                                // names files by timestamp (`20260830_…`,
                                // `Screenshot_2026…`), so descending name order visits a
                                // folder newest-first and the capped prefix becomes the
                                // newest files rather than a random slice. Folders with
                                // un-dated names lose nothing: they were unordered
                                // before and are unordered now, and the final mtime sort
                                // below is what actually orders whatever is kept.
                                let mut items: Vec<fs::DirEntry> = read.flatten().collect();
                                items.sort_by(|a, b| b.file_name().cmp(&a.file_name()));

                                // The cap is per directory, not per walk. A global cap
                                // let the first root swallow every slot: the camera roll
                                // holds thousands of files, so the quick scan's three
                                // hundred were all camera shots -- and when the newest
                                // photograph was days older than the newest screenshot,
                                // the gallery opened on Friday for a beat and then jumped
                                // to today once the full walk landed. Giving each
                                // directory its own allowance lets every hot root
                                // contribute its newest files, and the mtime sort plus
                                // truncate at the bottom picks the true newest `limit`
                                // from among them.
                                let mut kept_here = 0usize;
                                for item in items {
                                    let name = item.file_name().to_string_lossy().into_owned();
                                    if name == ".facet-trash" {
                                        // The app's own recycle folder -- one per directory
                                        // a delete ever happened in. Its contents are
                                        // listed flat (never descended into) so the Trash
                                        // screen can restore them, but they must not fall
                                        // through to `hits`: a deleted photo back in the
                                        // roll is the bug `.trashed` in `skip_dir` exists
                                        // to prevent. Capped, because an unbounded junk
                                        // drawer must not be able to starve the walk that
                                        // feeds the gallery.
                                        collect_trash(&item.path(), &mut trash_here, 1000);
                                        continue;
                                    }
                                    if name.starts_with('.') {
                                        continue;
                                    }

                                    // `file_type()` comes out of the `readdir` record
                                    // itself and costs nothing; `metadata()` is a `stat`,
                                    // and the previous version of this loop made *two* of
                                    // them for every entry -- before knowing whether the
                                    // file was even a photo. On `/sdcard`, which is a
                                    // FUSE mount, a `stat` is around a third of a
                                    // millisecond, so the camera roll's three thousand
                                    // seven hundred files cost two and a half seconds of
                                    // syscalls to find the three hundred that mattered.
                                    //
                                    // A symlink is skipped whichever it points at:
                                    // following one is how a directory loop becomes
                                    // invisible, and there are no symlinked photographs
                                    // worth the check.
                                    let Ok(ft) = item.file_type() else { continue };
                                    if ft.is_symlink() {
                                        continue;
                                    }

                                    if ft.is_dir() {
                                        if depth + 1 > max_depth { continue; }
                                        if skip_dir(&name) { continue; }
                                        children.push((item.path(), depth + 1));
                                        continue;
                                    }

                                    let ext = Path::new(&name)
                                        .extension()
                                        .map(|e| e.to_string_lossy().to_ascii_lowercase())
                                        .unwrap_or_default();
                                    // An empty list means "every file" -- the Downloads
                                    // category asks for exactly that, and an empty set
                                    // that matched nothing left its hero card permanently
                                    // on "No downloads found".
                                    if !wanted.is_empty() && !wanted.contains(&ext) { continue; }

                                    if kept_here >= limit {
                                        // This directory has spent its allowance. `continue`
                                        // rather than `break`: the remaining names still
                                        // need walking so any subdirectories sorted after
                                        // this point get pushed, and a skipped name costs no
                                        // `stat` -- the loop below is the only thing that
                                        // pays for one.
                                        truncated_here = true;
                                        continue;
                                    }

                                    // Only now is a `stat` worth paying for: once per file
                                    // that is actually going into the gallery.
                                    let Ok(meta) = item.metadata() else { continue };
                                    kept_here += 1;
                                    hits.push(MediaHit {
                                        path: norm(&item.path()),
                                        name,
                                        size: meta.len(),
                                        modified: millis(&meta),
                                        folder: norm(&dir),
                                        folder_name: dir
                                            .file_name()
                                            .map(|n| n.to_string_lossy().into_owned())
                                            .unwrap_or_else(|| norm(&dir)),
                                    });
                                }
                            }
                        }

                        // Hand the children over in one go. They were collected in
                        // name-descending order, the same order the single-walker
                        // version pushed them in, so the pop order is unchanged.
                        let mut g = shared.lock().unwrap_or_else(|e| e.into_inner());
                        if visited {
                            g.dirs_visited += 1;
                        }
                        g.stack.extend(children);
                        if truncated_here {
                            g.truncated = true;
                        }
                        if !trash_here.is_empty() {
                            let room = 1000usize.saturating_sub(g.trash.len());
                            trash_here.truncate(room);
                            g.trash.extend(trash_here);
                        }
                        g.busy -= 1;
                    }
                    hits
                })
            })
            .collect();
        handles
            .into_iter()
            .map(|h| h.join().unwrap_or_default())
            .collect()
    });

    let shared = Arc::try_unwrap(shared)
        .map_err(|_| "scan workers still hold state".to_string())?
        .into_inner()
        .unwrap_or_else(|e| e.into_inner());
    let Shared { dirs_visited, mut truncated, mut trash, .. } = shared;

    let mut hits: Vec<MediaHit> = per_thread.into_iter().flatten().collect();

    // Newest first -- a gallery opens on what you just shot, never on whatever
    // the directory order happened to be. `None` (an OS that won't report a
    // mtime) sorts last rather than first, so an undateable file cannot claim
    // the top of the grid.
    hits.sort_by(|a, b| {
        b.modified
            .unwrap_or(f64::MIN)
            .partial_cmp(&a.modified.unwrap_or(f64::MIN))
            .unwrap_or(std::cmp::Ordering::Equal)
    });

    // The per-directory allowance can keep more than `limit` in total (each
    // root contributes up to `limit` of its own); the caller asked for the
    // newest `limit` overall, which is exactly the prefix of the sort above.
    if hits.len() > limit {
        truncated = true;
        hits.truncate(limit);
    }

    // Same order as the roll: the thing you deleted a minute ago is the thing
    // you came to the Trash screen to get back.
    trash.sort_by(|a, b| {
        b.modified
            .unwrap_or(f64::MIN)
            .partial_cmp(&a.modified.unwrap_or(f64::MIN))
            .unwrap_or(std::cmp::Ordering::Equal)
    });

    Ok(MediaScan { hits, dirs_visited, truncated, trash })
}

/// Flat listing of one `.facet-trash` folder into `out`, up to `cap` total.
///
/// Every file is kept regardless of extension — a trashed spreadsheet must be
/// restorable even though the gallery would never have shown it — and nothing
/// is descended into, because deletes only ever put plain files here.
fn collect_trash(dir: &Path, out: &mut Vec<MediaHit>, cap: usize) {
    let Ok(read) = fs::read_dir(dir) else { return };
    for item in read.flatten() {
        if out.len() >= cap {
            return;
        }
        let Ok(ft) = item.file_type() else { continue };
        if !ft.is_file() {
            continue;
        }
        let Ok(meta) = item.metadata() else { continue };
        out.push(MediaHit {
            path: norm(&item.path()),
            name: item.file_name().to_string_lossy().into_owned(),
            size: meta.len(),
            modified: millis(&meta),
            folder: norm(dir),
            folder_name: ".facet-trash".to_string(),
        });
    }
}

/// Permanently dispose of files that are already in a `.facet-trash` folder.
///
/// This is the only command in the app that deletes anything, and the path
/// check is what keeps it that way: a caller bug that passes a live photo's
/// path gets an error, not a deletion. All-or-nothing up front — if any path
/// fails the check, nothing at all is removed, because "emptied most of your
/// trash and also one photo" is not a partial success anyone wants.
///
/// On Windows the files go to the OS Recycle Bin, not oblivion: the desktop
/// has a second-level undo and there is no reason to be the one app that
/// bypasses it. Android's storage has no such bin, so there it is a real
/// delete — which is what "Empty trash" says on the tin.
#[tauri::command]
pub async fn empty_trash(paths: Vec<String>) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        // Resolve first, then look for a real `.facet-trash` *component*: a
        // substring test would pass `x/.facet-trash/../secret` and `..`-laden
        // paths that never enter the bin.
        //
        // The resolved paths are kept and it is those that get deleted. Checking
        // `p` and then deleting `p` would mean the check and the delete follow
        // the symlinks separately: a link inside the bin that is re-pointed at a
        // live photo between the two loops passes the check as trash and is
        // removed as the photo. Deleting `real` closes that window -- whatever
        // was approved is exactly what goes.
        let mut real: Vec<std::path::PathBuf> = Vec::with_capacity(paths.len());
        for p in &paths {
            let full = fs::canonicalize(p).map_err(|e| format!("{p}: {e}"))?;
            let inside = full
                .components()
                .any(|c| c.as_os_str() == ".facet-trash");
            if !inside || !full.is_file() {
                return Err(format!("refusing to delete outside .facet-trash: {p}"));
            }
            real.push(full);
        }
        for f in &real {
            let shown = f.display();
            #[cfg(windows)]
            trash::delete(f).map_err(|e| format!("{shown}: {e}"))?;
            #[cfg(not(windows))]
            fs::remove_file(f).map_err(|e| format!("{shown}: {e}"))?;
        }
        crate::media::scan(&paths);
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// One cheap number that changes when any of these directories does.
///
/// The automatic-rescan primitive. Samsung's gallery gets push notifications
/// from Android's MediaStore; a WebView app gets nothing, and inotify does not
/// reliably cross the FUSE mount other apps write through. What does work is
/// the filesystem's own bookkeeping: a directory's mtime changes whenever a
/// file is created, deleted or renamed inside it. So the front end hands over
/// the few dozen folders where new files actually land, this stats each one,
/// and a changed stamp means "walk again". Thirty stats every few seconds is
/// nothing; the full walk only runs when something really happened.
#[tauri::command]
pub async fn watch_stamp(paths: Vec<String>) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut h: u64 = 0xcbf2_9ce4_8422_2325;
        let mut mix = |bytes: &[u8]| {
            for b in bytes {
                h ^= *b as u64;
                h = h.wrapping_mul(0x0000_0100_0000_01b3);
            }
        };
        for p in &paths {
            mix(p.as_bytes());
            match fs::metadata(p) {
                Ok(meta) => {
                    let mt = meta
                        .modified()
                        .ok()
                        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                        .map(|d| d.as_millis() as u64)
                        .unwrap_or(0);
                    mix(&mt.to_le_bytes());
                }
                // A folder that stopped existing is a change too.
                Err(_) => mix(b"gone"),
            }
        }
        Ok(format!("{h:016x}"))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Drive letters, probed rather than enumerated.
///
/// `GetLogicalDrives` would need a Win32 binding for a 26-iteration loop, and
/// a missing letter fails its metadata call immediately, so the probe is cheap
/// in the case that matters. Removable slots with no media are the slow path,
/// which is why this is called once at boot and cached, not per navigation.
#[tauri::command]
pub fn list_roots() -> Vec<RawPlace> {
    let mut out = Vec::new();

    #[cfg(windows)]
    for letter in b'A'..=b'Z' {
        let root = format!("{}:/", letter as char);
        if fs::metadata(&root).is_err() {
            continue;
        }
        out.push(RawPlace {
            id: format!("drive-{}", (letter as char).to_ascii_lowercase()),
            name: format!("{}:", letter as char),
            path: root,
            icon: "drive".into(),
            free: None,
            total: None,
        });
    }

    // Android has no drive letters and `/` is a wall of unreadable system
    // mounts. What a phone user means by "my storage" is the primary external
    // volume, plus whatever SD card is mounted beside it. Both are listed only
    // if they actually resolve, so a phone with no card shows one root, not a
    // dead tile. (Reading them still needs the storage permission — that is
    // requested from the Kotlin side, not here.)
    #[cfg(target_os = "android")]
    {
        for (id, name, path) in [
            ("internal", "Internal storage", "/storage/emulated/0"),
            ("sdcard", "SD card", "/storage/sdcard1"),
        ] {
            if Path::new(path).is_dir() {
                out.push(RawPlace {
                    id: id.into(),
                    name: name.into(),
                    path: path.into(),
                    icon: "drive".into(),
                    free: None,
                    total: None,
                });
            }
        }
        if out.is_empty() {
            out.push(RawPlace {
                id: "root".into(),
                name: "Device".into(),
                path: "/".into(),
                icon: "drive".into(),
                free: None,
                total: None,
            });
        }
    }

    #[cfg(not(any(windows, target_os = "android")))]
    out.push(RawPlace {
        id: "root".into(),
        name: "/".into(),
        path: "/".into(),
        icon: "drive".into(),
        free: None,
        total: None,
    });

    out
}

/// The shelf of places people actually start from.
///
/// Resolved off `USERPROFILE` rather than the shell's Known Folder API, so a
/// relocated Documents folder (OneDrive redirection) is missed. That is a
/// deliberate first-pass trade: the API needs COM, and any folder can still be
/// reached by typing or by favouriting it. Entries that do not exist are
/// dropped, so a machine without a Videos folder shows no dead tile.
///
/// On Android `HOME` points at the app's private sandbox, which contains
/// nothing the user has ever seen. Home there is the primary external volume,
/// and the standard folder names differ from Windows' (`DCIM`, `Download`,
/// `Movies`), so both the root and the folder list are chosen per platform.
#[tauri::command]
pub fn home_places() -> Vec<RawPlace> {
    #[cfg(target_os = "android")]
    let home = PathBuf::from("/storage/emulated/0");
    #[cfg(target_os = "android")]
    let folders: &[(&str, &str)] = &[
        ("DCIM", "image"),
        ("Pictures", "image"),
        ("Download", "clock"),
        ("Documents", "doc"),
        ("Movies", "video"),
        ("Music", "audio"),
    ];

    #[cfg(not(target_os = "android"))]
    let folders: &[(&str, &str)] = &[
        ("Desktop", "home"),
        ("Downloads", "clock"),
        ("Documents", "doc"),
        ("Pictures", "image"),
        ("Videos", "video"),
        ("Music", "audio"),
    ];
    #[cfg(not(target_os = "android"))]
    let Some(home) = std::env::var_os("USERPROFILE")
        .or_else(|| std::env::var_os("HOME"))
        .map(PathBuf::from)
    else {
        return Vec::new();
    };

    let mut out = vec![RawPlace {
        id: "home".into(),
        name: "Home".into(),
        path: norm(&home),
        icon: "home".into(),
        free: None,
        total: None,
    }];

    for &(folder, icon) in folders {
        let p = home.join(folder);
        if p.is_dir() {
            out.push(RawPlace {
                id: folder.to_ascii_lowercase(),
                name: folder.into(),
                path: norm(&p),
                icon: icon.into(),
                free: None,
                total: None,
            });
        }
    }

    out
}

/// Hand a file to whatever Windows already associates with it.
///
/// The stop-gap for every kind FACET cannot open yet. It shells out to
/// `explorer.exe`, which takes a path as a single argument — no `cmd /C start`,
/// whose quoting rules turn a filename containing `&` into a command injection.
///
/// Android has no process to shell out to — handing a file to another app there
/// means an `ACTION_VIEW` Intent with a FileProvider URI, which has to come from
/// the Kotlin side. Until that exists this returns a real error rather than
/// spawning a command that cannot be there, so the UI can say so instead of
/// looking like it silently ignored the tap.
#[tauri::command]
pub fn open_external(path: String) -> Result<(), String> {
    if !Path::new(&path).exists() {
        return Err(format!("{path}: not found"));
    }
    #[cfg(windows)]
    {
        std::process::Command::new("explorer")
            .arg(path.replace('/', "\\"))
            .spawn()
            .map(|_| ())
            .map_err(|e| e.to_string())
    }
    #[cfg(not(windows))]
    {
        Err("Opening in another app is not wired up on this platform yet".into())
    }
}

/// Run a program the user configured, with arguments the front end already split
/// (item 39).
///
/// **No shell, ever.** The argument vector arrives already split by
/// `splitArgs` in `src/core/explorer/actions.ts` and every `{token}` was
/// substituted *after* that split, so a filename containing a space, a quote, an
/// `&` or a newline occupies exactly one slot of `argv` and cannot become a
/// second command. Handing this line to `cmd /C` would undo all of that in one
/// step, which is why neither this function nor `open_external` above does.
///
/// Nothing is captured and nothing is waited for: this is "open it in that
/// program", not a job runner — the batch queue is the job runner, and it has
/// its own progress, cancellation and undo. Spawning detached means a user
/// action that opens a GUI does not pin a FACET thread for as long as the window
/// is up.
///
/// The failure that actually happens is a mistyped program name, and it happens
/// at `spawn`, so it comes back as an error the UI can show rather than as
/// silence.
///
/// What this is *not* is a sandbox, and it is worth being blunt about that
/// rather than leaving a reader to work it out: an action runs the program the
/// user configured, with that user's privileges, and FACET does not try to
/// second-guess which programs a person is allowed to run on their own machine.
/// The WebView is trusted here because it renders nothing but local files under
/// a `default-src 'self'` policy with no remote script and no `object-src`.
/// SECURITY.md states that boundary in full.
#[tauri::command]
pub fn run_program(program: String, args: Vec<String>, cwd: Option<String>) -> Result<(), String> {
    if program.trim().is_empty() {
        return Err("No program to run".into());
    }
    #[cfg(desktop)]
    {
        refuse_reparsing(&program)?;
        // A program written as a path has to be a file that is actually there.
        // A bare name is left to the OS to look up, which is the only reason to
        // write one -- and the reason a path is checked here and a name is not.
        if program.contains(['/', '\\']) && !Path::new(&program).is_file() {
            return Err(format!("{program}: not found"));
        }
        let mut cmd = std::process::Command::new(program.replace('/', std::path::MAIN_SEPARATOR_STR));
        cmd.args(&args);
        if let Some(dir) = cwd.as_deref() {
            if Path::new(dir).is_dir() {
                cmd.current_dir(dir);
            }
        }
        // No console window for a command-line tool run from a GUI — otherwise
        // every zip of a folder flashes a black rectangle across the screen.
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            const CREATE_NO_WINDOW: u32 = 0x0800_0000;
            cmd.creation_flags(CREATE_NO_WINDOW);
        }
        cmd.spawn().map(|_| ()).map_err(|e| format!("{program}: {e}"))
    }
    #[cfg(not(desktop))]
    {
        let _ = (args, cwd);
        Err("Running another program is not available on this platform".into())
    }
}

/// Refuse a program that would re-parse the argument vector behind our backs.
///
/// Everything `run_program` promises rests on one thing: a filename containing a
/// space, a quote, an `&` or a newline occupies exactly one slot of `argv` and
/// cannot turn into a second command. That promise is void the moment the
/// program *is* something whose job is to re-split its own arguments -- `cmd`,
/// `powershell`, `wscript` -- or, on Windows, a `.bat` or `.cmd`, which the
/// loader hands to `cmd` for you before your code ever runs. A file named
/// `holiday & format c.jpg` is not a hypothetical; cameras and messaging apps
/// produce names with every character in them.
///
/// A list of names is not a security boundary and is not offered as one. A user
/// who configures an interpreter has configured an interpreter deliberately, and
/// that is their call to make. What this stops is narrower and worth stopping on
/// its own: the argument vector being quietly re-split underneath a design that
/// says in writing that it will not be.
#[cfg(desktop)]
fn refuse_reparsing(program: &str) -> Result<(), String> {
    /// Matched against the file stem, so both `cmd` and `C:\...\cmd.exe` hit.
    const SHELLS: &[&str] = &[
        "cmd", "command", "powershell", "pwsh", "wscript", "cscript", "mshta", "rundll32",
        "regsvr32", "sh", "bash", "zsh", "dash", "ksh", "fish", "wsl", "env", "xargs",
    ];
    /// Extensions Windows runs through a shell no matter how they are spawned.
    const SCRIPTS: &[&str] = &[
        "bat", "cmd", "ps1", "psm1", "vbs", "vbe", "js", "jse", "wsf", "wsh", "hta", "scr", "pif",
        "lnk", "url",
    ];

    // Two ways the same file can be spelled so that neither list matches, both
    // of them Windows-only quirks of how a name is resolved:
    //
    // Trailing dots and spaces are dropped by the loader, so `cmd.exe.` runs
    // cmd.exe -- while `Path` reads it as the stem `cmd.exe` with an empty
    // extension, in neither list, and `is_file()` agrees the file is there.
    // `foo.bat.` and any number of trailing dots work the same way. Nothing is
    // legitimately spelled with that padding, so a name that changes when the
    // padding comes off is refused rather than tested twice.
    //
    // 8.3 short names are the other spelling: generation is on by default on
    // the system volume, so `powershell.exe` also answers to `POWERS~1.EXE`,
    // whose stem is `powers~1`. A written path is canonicalised below, which
    // expands it back; a bare name has no path to resolve, so a `~` in one is
    // refused outright.
    if cfg!(windows) {
        if program.trim_end_matches(['.', ' ']) != program {
            return Err(format!(
                "{program}: a program name may not end in a dot or a space -- Windows drops \
                 those when it resolves the name, which would hide what is really being run"
            ));
        }
        if !program.contains(['/', '\\']) && program.contains('~') {
            return Err(format!(
                "{program}: write the program's full name, not its shortened 8.3 form"
            ));
        }
    }

    // Resolving the path also follows symlinks, so a link pointing at a shell
    // is judged as the shell it opens rather than as the name it was given. A
    // bare name is left alone: there is nothing to resolve until the OS looks
    // it up on PATH.
    let file = if program.contains(['/', '\\']) {
        std::fs::canonicalize(program).unwrap_or_else(|_| PathBuf::from(program))
    } else {
        PathBuf::from(program)
    };
    let lower = |s: Option<&std::ffi::OsStr>| {
        s.and_then(|v| v.to_str()).unwrap_or("").to_ascii_lowercase()
    };
    let stem = lower(file.file_stem());
    let ext = lower(file.extension());
    if SHELLS.contains(&stem.as_str()) || SCRIPTS.contains(&ext.as_str()) {
        return Err(format!(
            "{program}: FACET will not run a shell or a script host -- name the program itself, \
             so that a file name can never be read as part of the command"
        ));
    }
    Ok(())
}

/// Open the containing folder with the item selected.
#[tauri::command]
pub fn reveal(path: String) -> Result<(), String> {
    #[cfg(windows)]
    {
        std::process::Command::new("explorer")
            .arg(format!("/select,{}", path.replace('/', "\\")))
            .spawn()
            .map(|_| ())
            .map_err(|e| e.to_string())
    }
    #[cfg(not(windows))]
    {
        let _ = path;
        Err("Reveal in file manager is not available on this platform".into())
    }
}

/// Bytes of an arbitrary file, for the hex inspector and metadata reader.
///
/// Capped so a stray double-click on a 40 GB disk image cannot pull the whole
/// thing through the IPC bridge and take the webview's heap with it.
#[tauri::command]
pub fn read_head(path: String, max: usize) -> Result<Vec<u8>, String> {
    use std::io::Read;
    let f = fs::File::open(&path).map_err(|e| format!("{path}: {e}"))?;
    let mut buf = Vec::new();
    f.take(max.min(16 * 1024 * 1024) as u64)
        .read_to_end(&mut buf)
        .map_err(|e| e.to_string())?;
    Ok(buf)
}

/// Bytes from an arbitrary offset — the other half of `read_head`.
///
/// Needed because plenty of formats keep the interesting part nowhere near the
/// start: a zip's central directory is at the end, and a RAW file's embedded
/// JPEG preview sits wherever the IFD chain happens to point, often megabytes
/// in. Seeking to it beats streaming the whole file through the IPC bridge.
///
/// A short read is not an error. Asking past EOF yields an empty vec, which is
/// what a caller probing a speculative offset actually wants.
#[tauri::command]
pub fn read_range(path: String, offset: u64, len: usize) -> Result<Vec<u8>, String> {
    use std::io::{Read, Seek, SeekFrom};
    let mut f = fs::File::open(&path).map_err(|e| format!("{path}: {e}"))?;
    let size = f.metadata().map_err(|e| e.to_string())?.len();
    if offset >= size {
        return Ok(Vec::new());
    }
    f.seek(SeekFrom::Start(offset)).map_err(|e| e.to_string())?;
    let want = (len.min(16 * 1024 * 1024) as u64).min(size - offset);
    let mut buf = Vec::with_capacity(want as usize);
    f.take(want).read_to_end(&mut buf).map_err(|e| e.to_string())?;
    Ok(buf)
}

/// The last `len` bytes of a file, plus the file's total size.
///
/// The size comes back with the bytes on purpose: a zip reader needs it to turn
/// the central-directory offset stored in the end-of-central-directory record
/// into a position it can actually seek to, and making that a second command
/// would mean two round trips and a window where the file could change size
/// between them.
#[tauri::command]
pub fn read_tail(path: String, len: usize) -> Result<(Vec<u8>, u64), String> {
    use std::io::{Read, Seek, SeekFrom};
    let mut f = fs::File::open(&path).map_err(|e| format!("{path}: {e}"))?;
    let size = f.metadata().map_err(|e| e.to_string())?.len();
    let want = (len.min(16 * 1024 * 1024) as u64).min(size);
    f.seek(SeekFrom::Start(size - want)).map_err(|e| e.to_string())?;
    let mut buf = Vec::with_capacity(want as usize);
    f.take(want).read_to_end(&mut buf).map_err(|e| e.to_string())?;
    Ok((buf, size))
}

/// Write bytes produced in the webview (an exported photo, a scrubbed copy).
///
/// Save-a-copy semantics: the parent directory is created, but an existing file
/// is only replaced when the caller says so. The editor never overwrites the
/// original unless the user picked "Save", which is the one path that passes
/// `overwrite`.
#[tauri::command]
pub fn write_file(path: String, bytes: Vec<u8>, overwrite: bool) -> Result<String, String> {
    let p = PathBuf::from(&path);
    if !overwrite && p.exists() {
        return Err(format!("{path}: already exists"));
    }
    if let Some(dir) = p.parent() {
        fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    fs::write(&p, bytes).map_err(|e| format!("{path}: {e}"))?;
    let out = norm(&p);
    crate::media::scan(std::slice::from_ref(&out));
    Ok(out)
}

/// Append bytes to a file, creating it if it is not there yet, and answer with
/// how long the file now is.
///
/// This exists for the recorder (item 29) and the reasoning is worth keeping.
/// `MediaRecorder` hands out a chunk every few seconds; the obvious thing is to
/// collect them and write once at stop. That has two failure modes and both are
/// certain rather than theoretical. **Memory**: an hour of screen capture at a
/// few megabits is over a gigabyte held in the webview, and the take is lost at
/// the moment the allocation fails — the end of the meeting. **Crashes**: a
/// power cut, an OOM kill or a bad driver at minute fifty-nine of an hour-long
/// recording leaves nothing at all, when almost all of it was recordable.
///
/// Appending each chunk as it arrives fixes both, and it is only correct
/// because of what WebM is: a sequence of clusters, header first, with no index
/// that has to be patched at the end. Concatenating the chunks in order gives
/// byte-for-byte what the single final blob would have been, and a file cut
/// short mid-recording is a *shorter valid recording* rather than a broken
/// file. Plain MP4 does not have that property — its `moov` atom is written
/// last — which is exactly why the recorder prefers WebM for this path and says
/// so rather than quietly producing a file no player will open.
///
/// No `overwrite` flag: the first chunk of a take goes through `write_file`,
/// which is where the "do not clobber" decision is made once. By the time this
/// is called the file is ours and every call after that is meant to extend it.
#[tauri::command]
pub fn append_file(path: String, bytes: Vec<u8>) -> Result<u64, String> {
    use std::io::Write;
    let p = PathBuf::from(&path);
    if let Some(dir) = p.parent() {
        fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let mut f = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&p)
        .map_err(|e| format!("{path}: {e}"))?;
    f.write_all(&bytes).map_err(|e| format!("{path}: {e}"))?;
    // Flushed, not synced. `flush` gets the bytes out of our buffer and into the
    // OS, which is what protects against this process dying — the case that
    // actually happens. A full `sync_all` per chunk would also protect against
    // the machine losing power, at the cost of a disk barrier every few seconds
    // for the whole recording, and a recorder that stutters is a worse recorder
    // than one that loses the last two seconds of an unplanned blackout.
    f.flush().map_err(|e| format!("{path}: {e}"))?;
    Ok(f.metadata().map_err(|e| e.to_string())?.len())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MoveResult {
    /// Where the file actually ended up — not necessarily where you asked, if
    /// the name was taken and the destination stepped to `-2`.
    path: String,
    /// True when this was a copy and the original is still sitting there.
    copied: bool,
}

/// Move or rename a file **or a folder**. Also the rename command — a rename
/// is a move whose destination is the same directory.
///
/// Two rules that are not negotiable:
///
/// **It never overwrites unless asked.** A taken destination steps to `-2`,
/// `-3`, and so on. A watch-folder rule can fire on forty files in a second;
/// silently landing them on top of each other would destroy thirty-nine.
///
/// **It never deletes the original.** `fs::rename` across volumes fails on
/// every platform, and the usual fix — copy, then delete the source — is a
/// permanent delete of a file the user still has, performed by a background
/// rule they set up weeks ago. So the cross-volume path copies the bytes and
/// **leaves the original alone**, reporting `copied: true` so the caller can
/// say what really happened. Removing the source afterwards is the user's
/// call to make in the file manager, where it goes to the Recycle Bin.
///
/// **A folder may not be dropped inside itself.** `swallows` catches both the
/// obvious case and the one that actually happens — dragging `Photos` onto
/// `Photos/2024` — which without the check would copy the tree into itself
/// until the disk filled.
#[tauri::command]
pub fn move_file(from: String, to: String, overwrite: bool) -> Result<MoveResult, String> {
    let src = PathBuf::from(&from);
    let dir_move = src.is_dir();
    if !src.is_file() && !dir_move {
        return Err(format!("{from}: no such file or folder"));
    }
    let want = PathBuf::from(&to);
    if dir_move && swallows(&src, &want) {
        return Err(format!("{from}: a folder cannot be moved inside itself"));
    }
    if let Some(dir) = want.parent() {
        fs::create_dir_all(dir).map_err(|e| format!("{}: {e}", dir.display()))?;
    }

    let dest = if overwrite { want } else { free_path(&want, dir_move)? };
    if dest == src {
        return Ok(MoveResult { path: norm(&src), copied: false });
    }

    let res = match fs::rename(&src, &dest) {
        Ok(()) => MoveResult { path: norm(&dest), copied: false },
        Err(e) => {
            // Cross-volume. Copy and stop; see the note above about not
            // deleting what we cannot put in the Recycle Bin.
            let copied = if dir_move { copy_tree(&src, &dest) } else { copy_one(&src, &dest) };
            copied.map_err(|c| format!("{from} -> {to}: {e}; copy also failed: {c}"))?;
            MoveResult { path: norm(&dest), copied: true }
        }
    };
    // The old path is gone (or still there, after a cross-volume copy) and the
    // new one exists: the indexer sorts out which is which.
    crate::media::scan(&[norm(&src), res.path.clone()]);
    Ok(res)
}

/// Copy a file or a whole folder. The other half of a drag: Ctrl held, or a
/// drop onto a different volume, where copying is what the OS would have done
/// anyway and pretending otherwise would mean deleting the original.
///
/// Same two rules as `move_file` — never overwrites unless asked, never
/// removes anything — plus the same refusal to put a folder inside itself.
/// `copied` is always true here; it is in the result only so a caller can
/// handle both commands with one code path.
/// Where the drag preview lives on disk.
///
/// `tauri-plugin-drag` wants a *path* to an image for the card under the
/// cursor, and FACET's icons are compiled into the executable rather than
/// sitting in a folder beside it — so the bundled one is written out once, to
/// the temp directory, and the same path is handed back for the rest of the
/// session. Cheap enough to do on the first drag rather than at startup, since
/// most runs of a file manager never drag anything out of it.
#[cfg(desktop)]
#[tauri::command]
pub fn drag_icon() -> Result<String, String> {
    const PNG: &[u8] = include_bytes!("../icons/128x128.png");
    let path = std::env::temp_dir().join("facet-drag.png");
    // Not `create_new`: a stale file from a previous run is the same file.
    if !path.is_file() {
        fs::write(&path, PNG).map_err(|e| format!("{}: {e}", path.display()))?;
    }
    // Native separators, not `norm`: this goes to a Win32 image loader, not
    // back into the web view.
    Ok(path.to_string_lossy().into_owned())
}

#[tauri::command]
pub fn copy_file(from: String, to: String, overwrite: bool) -> Result<MoveResult, String> {
    let src = PathBuf::from(&from);
    let dir_copy = src.is_dir();
    if !src.is_file() && !dir_copy {
        return Err(format!("{from}: no such file or folder"));
    }
    let want = PathBuf::from(&to);
    if dir_copy && swallows(&src, &want) {
        return Err(format!("{from}: a folder cannot be copied inside itself"));
    }
    if let Some(dir) = want.parent() {
        fs::create_dir_all(dir).map_err(|e| format!("{}: {e}", dir.display()))?;
    }

    // A copy onto its own path is the "duplicate this" gesture, so it steps to
    // `-2` rather than being the no-op that `move_file` correctly treats it as.
    let dest = if overwrite { want } else { free_path(&want, dir_copy)? };
    if dest == src {
        return Err(format!("{from}: cannot copy a file onto itself"));
    }

    if dir_copy {
        copy_tree(&src, &dest).map_err(|e| format!("{from} -> {to}: {e}"))?;
    } else {
        copy_one(&src, &dest).map_err(|e| format!("{from} -> {to}: {e}"))?;
    }
    let out = norm(&dest);
    crate::media::scan(std::slice::from_ref(&out));
    Ok(MoveResult { path: out, copied: true })
}

/// Would putting `src` at `dest` place a folder inside itself?
///
/// Canonicalised first, because `C:/Photos` and `C:\photos\..\Photos` are the
/// same folder and a textual prefix test says they are not. `dest` usually does
/// not exist yet, so its *parent* is what gets resolved. A path that will not
/// canonicalise falls back to itself, which can only make the check stricter —
/// the safe direction for a test whose false negative is an infinite copy.
fn swallows(src: &Path, dest: &Path) -> bool {
    let real = |p: &Path| fs::canonicalize(p).unwrap_or_else(|_| p.to_path_buf());
    let inner = match dest.parent() {
        Some(parent) if !dest.exists() => real(parent).join(dest.file_name().unwrap_or_default()),
        _ => real(dest),
    };
    inner.starts_with(real(src))
}

/// One file, with its timestamps left as the OS made them.
fn copy_one(src: &Path, dest: &Path) -> Result<(), String> {
    fs::copy(src, dest).map(|_| ()).map_err(|e| format!("{}: {e}", src.display()))
}

/// A folder and everything under it.
///
/// Iterative rather than recursive: a deep tree — a `node_modules`, a nested
/// backup — would otherwise be able to blow the stack, and the crash would land
/// halfway through a copy the user is watching.
///
/// Symlinks are copied as what they point at rather than followed structurally,
/// which is what `fs::copy` does anyway; a link loop is bounded by the
/// `swallows` check at the top plus the fact that a loop's entries are already
/// under `src`.
fn copy_tree(src: &Path, dest: &Path) -> Result<(), String> {
    fs::create_dir_all(dest).map_err(|e| format!("{}: {e}", dest.display()))?;
    let mut todo = vec![(src.to_path_buf(), dest.to_path_buf())];
    while let Some((from, to)) = todo.pop() {
        let listing = fs::read_dir(&from).map_err(|e| format!("{}: {e}", from.display()))?;
        for item in listing {
            let item = item.map_err(|e| format!("{}: {e}", from.display()))?;
            let child = to.join(item.file_name());
            let kind = item.file_type().map_err(|e| format!("{}: {e}", from.display()))?;
            if kind.is_dir() {
                fs::create_dir_all(&child).map_err(|e| format!("{}: {e}", child.display()))?;
                todo.push((item.path(), child));
            } else {
                copy_one(&item.path(), &child)?;
            }
        }
    }
    Ok(())
}

/// `name.ext`, then `name-2.ext`, `name-3.ext`… up to a point where the folder
/// is clearly not what the caller thought it was.
///
/// `is_dir` matters more than it looks: a folder called `my.photos` has a
/// `file_stem` of `my` and an `extension` of `photos`, so treating it as a file
/// would produce `my-2.photos` — a plausible-looking name that is not the one
/// the user dropped. Folders step on the whole name.
fn free_path(want: &Path, is_dir: bool) -> Result<PathBuf, String> {
    if !want.exists() {
        return Ok(want.to_path_buf());
    }
    let dir = want.parent().unwrap_or(Path::new("."));
    let (stem, ext) = if is_dir {
        (want.file_name().map(|s| s.to_string_lossy().to_string()).unwrap_or_default(), String::new())
    } else {
        (
            want.file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_default(),
            want.extension().map(|s| format!(".{}", s.to_string_lossy())).unwrap_or_default(),
        )
    };
    for n in 2..=999 {
        let candidate = dir.join(format!("{stem}-{n}{ext}"));
        if !candidate.exists() {
            return Ok(candidate);
        }
    }
    Err(format!("{}: 999 files already have that name", want.display()))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The names below are the ones that got past an earlier version of this
    /// check, which is the only reason they are worth a test: each is a way
    /// Windows lets one file answer to two spellings.
    #[cfg(desktop)]
    #[test]
    fn a_shell_cannot_be_spelled_around_the_check() {
        for name in ["cmd", "cmd.exe", r"C:\Windows\System32\cmd.exe", "wscript", "sh"] {
            assert!(refuse_reparsing(name).is_err(), "{name} should be refused");
        }
        for name in ["run.bat", "job.ps1", "x.CMD", "thing.Lnk"] {
            assert!(refuse_reparsing(name).is_err(), "{name} should be refused");
        }
        if cfg!(windows) {
            // Trailing dots and spaces are dropped when the name is resolved,
            // so these are the shells above wearing a hat.
            for name in ["cmd.exe.", "cmd.exe..", "cmd.exe ", "run.bat.", "job.ps1."] {
                assert!(refuse_reparsing(name).is_err(), "{name} should be refused");
            }
            // An 8.3 short name is the same file under another spelling.
            assert!(refuse_reparsing("POWERS~1.EXE").is_err());
        }
        // And the ordinary case still goes through.
        for name in ["ffmpeg", "ffmpeg.exe", "7z", "notepad.exe", "code"] {
            assert!(refuse_reparsing(name).is_ok(), "{name} should be allowed");
        }
    }

    /// A scratch directory under the OS temp dir, named for the test.
    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("facet-fsx-{name}"));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// The check that stands between a drag and a disk full of one folder.
    #[test]
    fn refuses_to_put_a_folder_inside_itself() {
        let dir = scratch("swallow");
        let photos = dir.join("Photos");
        fs::create_dir_all(photos.join("2024")).unwrap();
        fs::write(photos.join("a.txt"), b"x").unwrap();

        for target in ["Photos", "Photos/2024", "Photos/2024/July"] {
            let to = norm(&dir.join(target));
            assert!(
                move_file(norm(&photos), to.clone(), false).is_err(),
                "move into {to} should be refused"
            );
            assert!(
                copy_file(norm(&photos), to.clone(), false).is_err(),
                "copy into {to} should be refused"
            );
        }
        // And the original is untouched by the refusal.
        assert!(photos.join("a.txt").is_file());
    }

    /// A name that is a prefix of another name is not the same folder.
    #[test]
    fn a_sibling_with_a_longer_name_is_not_inside() {
        let dir = scratch("sibling");
        fs::create_dir_all(dir.join("Photos")).unwrap();
        fs::create_dir_all(dir.join("PhotosOld")).unwrap();
        let out = copy_file(
            norm(&dir.join("Photos")),
            norm(&dir.join("PhotosOld").join("Photos")),
            false,
        )
        .expect("a sibling is a legitimate destination");
        assert!(PathBuf::from(out.path.replace('/', "\\")).is_dir());
    }

    #[test]
    fn copies_a_tree_and_leaves_the_original() {
        let dir = scratch("tree");
        let src = dir.join("src");
        fs::create_dir_all(src.join("deep").join("deeper")).unwrap();
        fs::write(src.join("top.txt"), b"top").unwrap();
        fs::write(src.join("deep").join("mid.txt"), b"mid").unwrap();
        fs::write(src.join("deep").join("deeper").join("low.txt"), b"low").unwrap();

        let out = copy_file(norm(&src), norm(&dir.join("dest")), false).unwrap();
        assert!(out.copied);

        let dest = dir.join("dest");
        assert_eq!(fs::read(dest.join("top.txt")).unwrap(), b"top");
        assert_eq!(fs::read(dest.join("deep").join("mid.txt")).unwrap(), b"mid");
        assert_eq!(
            fs::read(dest.join("deep").join("deeper").join("low.txt")).unwrap(),
            b"low"
        );
        // Rule one: nothing was removed.
        assert!(src.join("top.txt").is_file());
    }

    /// A taken name steps rather than overwrites — for folders too, where the
    /// naive `file_stem` split would rename `my.photos` to `my-2.photos`.
    #[test]
    fn a_taken_folder_name_steps_on_the_whole_name() {
        let dir = scratch("step");
        let src = dir.join("my.photos");
        fs::create_dir_all(&src).unwrap();
        fs::write(src.join("a.txt"), b"a").unwrap();
        fs::create_dir_all(dir.join("out").join("my.photos")).unwrap();

        let out = copy_file(
            norm(&src),
            norm(&dir.join("out").join("my.photos")),
            false,
        )
        .unwrap();
        assert!(out.path.ends_with("my.photos-2"), "{}", out.path);
        assert!(dir.join("out").join("my.photos-2").join("a.txt").is_file());
    }

    #[test]
    fn a_taken_file_name_keeps_its_extension() {
        let dir = scratch("stepfile");
        fs::write(dir.join("a.txt"), b"one").unwrap();
        fs::create_dir_all(dir.join("out")).unwrap();
        fs::write(dir.join("out").join("a.txt"), b"already here").unwrap();

        let out = copy_file(norm(&dir.join("a.txt")), norm(&dir.join("out").join("a.txt")), false)
            .unwrap();
        assert!(out.path.ends_with("a-2.txt"), "{}", out.path);
        // The file that was already there is exactly as it was.
        assert_eq!(fs::read(dir.join("out").join("a.txt")).unwrap(), b"already here");
    }

    #[test]
    fn moves_a_folder_within_a_volume() {
        let dir = scratch("movedir");
        let src = dir.join("from");
        fs::create_dir_all(&src).unwrap();
        fs::write(src.join("a.txt"), b"a").unwrap();

        let out = move_file(norm(&src), norm(&dir.join("to")), false).unwrap();
        assert!(!out.copied);
        assert!(dir.join("to").join("a.txt").is_file());
        assert!(!src.exists());
    }

    #[test]
    fn moves_within_a_volume() {
        let dir = scratch("move");
        let src = dir.join("a.txt");
        fs::write(&src, b"hello").unwrap();
        let dest = dir.join("sub").join("b.txt");

        let r = move_file(src.to_string_lossy().into(), dest.to_string_lossy().into(), false).unwrap();

        assert!(!r.copied, "a same-volume move is a move, not a copy");
        assert!(!src.exists(), "the source is gone");
        assert_eq!(fs::read(&dest).unwrap(), b"hello");
        assert!(r.path.ends_with("b.txt"), "{}", r.path);
    }

    /// The one that matters for a watch folder firing on forty files at once:
    /// a taken name must step, never land on top of what is there.
    #[test]
    fn never_overwrites_unless_told_to() {
        let dir = scratch("collide");
        fs::write(dir.join("keep.txt"), b"original").unwrap();
        fs::write(dir.join("in.txt"), b"new").unwrap();

        let r = move_file(
            dir.join("in.txt").to_string_lossy().into(),
            dir.join("keep.txt").to_string_lossy().into(),
            false,
        )
        .unwrap();

        assert!(r.path.ends_with("keep-2.txt"), "{}", r.path);
        assert_eq!(fs::read(dir.join("keep.txt")).unwrap(), b"original");
        assert_eq!(fs::read(dir.join("keep-2.txt")).unwrap(), b"new");
    }

    #[test]
    fn overwrites_when_told_to() {
        let dir = scratch("overwrite");
        fs::write(dir.join("keep.txt"), b"original").unwrap();
        fs::write(dir.join("in.txt"), b"new").unwrap();

        move_file(
            dir.join("in.txt").to_string_lossy().into(),
            dir.join("keep.txt").to_string_lossy().into(),
            true,
        )
        .unwrap();

        assert_eq!(fs::read(dir.join("keep.txt")).unwrap(), b"new");
        assert!(!dir.join("keep-2.txt").exists());
    }

    #[test]
    fn a_move_onto_itself_is_not_a_deletion() {
        let dir = scratch("self");
        let p = dir.join("a.txt");
        fs::write(&p, b"hello").unwrap();

        let r = move_file(p.to_string_lossy().into(), p.to_string_lossy().into(), true).unwrap();

        assert!(!r.copied);
        assert_eq!(fs::read(&p).unwrap(), b"hello", "the file is still there and intact");
    }

    #[test]
    fn a_missing_source_is_an_error_not_a_panic() {
        let dir = scratch("missing");
        let e = move_file(
            dir.join("nope.txt").to_string_lossy().into(),
            dir.join("out.txt").to_string_lossy().into(),
            false,
        );
        assert!(e.is_err());
    }
}
