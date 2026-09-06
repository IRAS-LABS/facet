//! Thumbnails: the embedded one now, the good one from a cache.
//!
//! The gallery used to point every tile at an `asset://` URL for the original
//! file and let the WebView scale it. That is correct and it is unusable: one
//! screen of sixteen tiles is eighty megabytes of full-resolution JPEG streamed
//! through the protocol handler and decoded at forty-five megapixels to fill a
//! 128 px square, and it happens again on every launch because nothing is kept.
//! Measured on a reference phone with ten thousand photos on the card, the grid was
//! on screen at 7.8 s and still entirely black at 30 s.
//!
//! Two things fix it, and neither needs a decoder or a new crate:
//!
//! 1. **The photograph already contains a thumbnail.** Every camera JPEG carries
//!    one in its EXIF APP1 segment -- a few tens of kilobytes, at the front of
//!    the file. Reading it is a byte walk, not a decode. It is soft for a 384 px
//!    tile, but it is on screen in milliseconds, and soft-now beats sharp-in-
//!    thirty-seconds by a margin that does not need arguing.
//! 2. **The good one is worth keeping.** The front end already shrinks images
//!    properly in a worker; it just threw the result away. `thumb_store` writes
//!    that result under the cache key, `thumb_cached` hands it back, and the
//!    second launch skips every step above.
//!
//! So a tile goes: cached 384 px if we have made one, then the embedded EXIF
//! thumbnail if the file has one, then the old full-size path. Only the last of
//! those is slow, and only the first time, for the files that deserve it.

use std::fs;
use std::io::Read;
use std::path::PathBuf;

use tauri::Manager;

/// Where thumbnails live.
///
/// Resolved on the Rust side rather than passed in from the front end, so the
/// path API needs no capability grant and the two commands cannot disagree
/// about the directory -- a disagreement that would show up as a cache which
/// silently never hits.
fn cache_root(app: &tauri::AppHandle) -> Option<PathBuf> {
    Some(app.path().app_cache_dir().ok()?.join("thumbs"))
}

/// FNV-1a. A cache key needs to be stable and cheap, not cryptographic, and a
/// hash crate is a dependency -- which for sixteen lines it is not worth being.
///
/// The trailing `2` is a cache generation. Before orientation handling landed,
/// every EXIF thumbnail of a portrait photograph was written through to the
/// disk cache sideways and marked exact — permanently sideways, because an
/// exact hit stops anything else from running. There is no way to tell a
/// poisoned entry from a good one after the fact, so the generation bump
/// orphans them all and the warm pass rebuilds the cache upright.
fn key_of(path: &str, mtime: u64) -> String {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for b in path.as_bytes().iter().chain(&mtime.to_le_bytes()).chain(b"2") {
        h ^= *b as u64;
        h = h.wrapping_mul(0x0000_0100_0000_01b3);
    }
    format!("{h:016x}")
}

fn cache_path(dir: &PathBuf, key: &str) -> PathBuf {
    // Two hex characters of fan-out. Ten thousand files in one directory is
    // legal and is also the thing that makes every later read of it slow --
    // including the ones this cache exists to speed up.
    dir.join(&key[0..2]).join(format!("{key}.jpg"))
}

/// Header on every non-empty reply: one flag byte, the 16-character key, then
/// one EXIF orientation byte (1–8; 1 for anything already upright).
///
/// The reply is a raw `Response` rather than a serialised struct because a
/// serialised `Vec<u8>` crosses the IPC as a JSON array of decimal numbers --
/// roughly four bytes of text per byte of JPEG, built and parsed for every tile.
/// Raw bytes skip all of it, and the three fields that would have justified the
/// struct fit in eighteen bytes at the front.
///
/// The orientation byte exists because the thumbnail stored inside a camera
/// JPEG's EXIF block is a bare JPEG with no EXIF of its own: the browser
/// auto-rotates the full file but has nothing to go on for the raid, so every
/// portrait photograph's tile came out sideways. The front end bakes the
/// rotation in with a canvas and stores the upright result.
const HEAD: usize = 1 + 16 + 1;

/// The cached thumbnail, or the embedded EXIF one, or nothing.
///
/// `mtime` is part of the key rather than checked against it: an edited file is
/// a different key and simply misses, which is both correct and one stat call
/// cheaper than validating.
///
/// A reply of exactly `HEAD` bytes is a key with no picture attached: decode it
/// the slow way and post the result back. A reply shorter than that means the
/// file is not a candidate at all. Returning `Option` instead of an empty buffer
/// would serialise as `null`, which the raw response channel cannot carry.
#[tauri::command]
pub async fn thumb_cached(
    app: tauri::AppHandle,
    path: String,
    mtime: u64,
) -> tauri::ipc::Response {
    // Blocking pool, for the same reason `scan_media` is: a cache hit is a few
    // milliseconds but a miss reads 256 KB off the card, and forty of those on
    // the dispatch thread is forty tiles' worth of every other command waiting.
    let bytes = tauri::async_runtime::spawn_blocking(move || {
        cached_bytes(&app, &path, mtime).unwrap_or_default()
    })
    .await
    .unwrap_or_default();
    tauri::ipc::Response::new(bytes)
}

fn cached_bytes(app: &tauri::AppHandle, path: &str, mtime: u64) -> Option<Vec<u8>> {
    let key = key_of(path, mtime);
    let cache_dir = cache_root(app)?;

    let framed = |exact: bool, orient: u8, jpeg: Vec<u8>| -> Vec<u8> {
        let mut out = Vec::with_capacity(HEAD + jpeg.len());
        out.push(u8::from(exact));
        out.extend_from_slice(key.as_bytes());
        out.push(orient.clamp(1, 8));
        out.extend_from_slice(&jpeg);
        out
    };

    if let Ok(bytes) = fs::read(cache_path(&cache_dir, &key)) {
        if !bytes.is_empty() {
            // Everything in the cache was stored upright by whoever made it.
            return Some(framed(true, 1, bytes));
        }
    }

    let (thumb, orient) = embedded_jpeg(path);
    let Some(bytes) = thumb else {
        // No cache entry and no embedded thumbnail -- but the key is still worth
        // sending. The front end is about to decode this file the slow way, and
        // the key is what lets it hand the result back to `thumb_store` so that
        // this is the last launch that pays for it.
        return Some(framed(false, orient, Vec::new()));
    };
    if orient <= 1 {
        // Write through. Re-reading 256 KB of every photo on every launch to
        // find a 30 KB thumbnail is most of the win thrown away for one write.
        store_bytes(&cache_dir, &key, &bytes);
    }
    // A rotated one is NOT written through: the cache holds finished pictures,
    // and this one still needs its quarter turn. The front end rotates it on a
    // canvas and hands the upright version to `thumb_store` itself.
    Some(framed(false, orient, bytes))
}

/// Keep a thumbnail the front end has just made.
///
/// The JPEG travels as the raw request body and the key as a header, because
/// the previous `bytes: Vec<u8>` argument crossed the IPC as a JSON array of
/// decimal numbers -- a 30 KB thumbnail became 120 KB of text that the
/// webview built and the Rust side parsed, once per tile, on the very path
/// that was supposed to be the fast one.
#[tauri::command]
pub fn thumb_store(app: tauri::AppHandle, request: tauri::ipc::Request<'_>) -> bool {
    let key = request
        .headers()
        .get("x-thumb-key")
        .and_then(|v| v.to_str().ok())
        .map(str::to_owned);
    let (key, bytes): (Option<String>, Vec<u8>) = match request.body() {
        tauri::ipc::InvokeBody::Raw(b) => (key, b.clone()),
        // The old shape, still accepted so a stale front end cannot break the
        // cache: `{ key, bytes: [..] }`.
        tauri::ipc::InvokeBody::Json(v) => {
            let arr = v.get("bytes").and_then(|b| b.as_array());
            let Some(a) = arr else { return false };
            let k = key.or_else(|| v.get("key").and_then(|k| k.as_str()).map(str::to_owned));
            (k, a.iter().filter_map(|n| n.as_u64().map(|n| n as u8)).collect())
        }
    };
    let Some(key) = key.filter(|k| k.len() == 16 && k.bytes().all(|b| b.is_ascii_hexdigit())) else {
        return false;
    };
    if bytes.is_empty() {
        return false;
    }
    // A ~30 KB write to the cache directory; synchronous because the request
    // body is borrowed and cannot cross into a spawned task, and because the
    // IPC already runs commands off the main thread.
    let Some(cache_dir) = cache_root(&app) else { return false };
    store_bytes(&cache_dir, &key, &bytes)
}

/// How many tiles may be inside the platform decoder at once.
///
/// MediaStore cache hits are I/O and would happily go wider, but a miss is a
/// real decode -- an `ImageDecoder` at sample size or a video frame out of a
/// hardware codec -- and the phone has a small fixed number of those. Four
/// keeps a burst of misses from stalling the hits queued behind them without
/// asking for a fifth decoder that does not exist.
const NATIVE_WORKERS: usize = 4;

/// One request in a batch. `video` is the caller's kind, a hint for which
/// fallback decoder to reach for when MediaStore has no row for the file.
#[derive(serde::Deserialize)]
pub struct Want {
    pub path: String,
    pub mtime: u64,
    #[serde(default)]
    pub video: bool,
}

/// Thumbnails for a whole band of tiles in one IPC round trip.
///
/// The reply is a sequence of `u32` little-endian length prefixes, each
/// followed by that many bytes of the same framed record `thumb_cached`
/// returns (flag, key, orientation, JPEG). A zero length is a file that is not
/// a candidate at all. Order matches `wants`. With `bytes` false the JPEG is
/// left out and only the flag says whether a picture is now on disk -- that
/// is the warm pass, which wants the cache filled and nothing sent back.
///
/// Each item goes: disk cache, then the platform thumbnail (MediaStore on
/// Android, see `droid`), then the EXIF raid. The platform result is written
/// through, so it is paid for once, ever, and the next launch is a cache hit.
#[tauri::command]
pub async fn thumb_batch(
    app: tauri::AppHandle,
    wants: Vec<Want>,
    px: u32,
    bytes: bool,
) -> tauri::ipc::Response {
    let out = tauri::async_runtime::spawn_blocking(move || batch_bytes(&app, &wants, px, bytes))
        .await
        .unwrap_or_default();
    tauri::ipc::Response::new(out)
}

fn batch_bytes(app: &tauri::AppHandle, wants: &[Want], px: u32, want_bytes: bool) -> Vec<u8> {
    let n = wants.len();
    let replies: Vec<std::sync::Mutex<Vec<u8>>> = (0..n).map(|_| std::sync::Mutex::new(Vec::new())).collect();
    let next = std::sync::atomic::AtomicUsize::new(0);
    let workers = NATIVE_WORKERS.min(n.max(1));
    std::thread::scope(|s| {
        for _ in 0..workers {
            s.spawn(|| loop {
                let i = next.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                if i >= n {
                    break;
                }
                let w = &wants[i];
                let reply = one_thumb(app, &w.path, w.mtime, w.video, px, want_bytes).unwrap_or_default();
                if let Ok(mut slot) = replies[i].lock() {
                    *slot = reply;
                }
            });
        }
    });
    let total: usize = replies.iter().map(|r| 4 + r.lock().map(|v| v.len()).unwrap_or(0)).sum();
    let mut out = Vec::with_capacity(total);
    for r in replies {
        let v = r.into_inner().unwrap_or_default();
        out.extend_from_slice(&(v.len() as u32).to_le_bytes());
        out.extend_from_slice(&v);
    }
    out
}

/// The framed record for one file: cache, platform, EXIF, in that order.
fn one_thumb(
    app: &tauri::AppHandle,
    path: &str,
    mtime: u64,
    video: bool,
    px: u32,
    want_bytes: bool,
) -> Option<Vec<u8>> {
    let key = key_of(path, mtime);
    let cache_dir = cache_root(app)?;
    let framed = |exact: bool, orient: u8, jpeg: &[u8]| -> Vec<u8> {
        let body = if want_bytes { jpeg } else { &[] };
        let mut out = Vec::with_capacity(HEAD + body.len());
        out.push(u8::from(exact));
        out.extend_from_slice(key.as_bytes());
        out.push(orient.clamp(1, 8));
        out.extend_from_slice(body);
        out
    };

    if let Ok(bytes) = fs::read(cache_path(&cache_dir, &key)) {
        if !bytes.is_empty() {
            return Some(framed(true, 1, &bytes));
        }
    }

    if let Some(jpeg) = platform_thumb(path, px, video) {
        store_bytes(&cache_dir, &key, &jpeg);
        return Some(framed(true, 1, &jpeg));
    }

    if video {
        return Some(framed(false, 1, &[]));
    }
    let (thumb, orient) = embedded_jpeg(path);
    let Some(bytes) = thumb else {
        return Some(framed(false, orient, &[]));
    };
    if orient <= 1 {
        store_bytes(&cache_dir, &key, &bytes);
    }
    Some(framed(false, orient, &bytes))
}

/// The operating system's own thumbnail for a file, as JPEG bytes.
///
/// Android answers through `ThumbBridge.kt`; everywhere else there is no
/// platform thumbnail service worth the binding and the caller's own decoders
/// take over, exactly as before.
fn platform_thumb(path: &str, px: u32, video: bool) -> Option<Vec<u8>> {
    #[cfg(target_os = "android")]
    {
        return droid::load(path, px as i32, video);
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = (path, px, video);
        None
    }
}

#[cfg(target_os = "android")]
mod droid {
    //! The JNI fence between `thumb_batch` and `ThumbBridge.kt`.
    //!
    //! `share.rs` reaches Kotlin through `wry::prelude::dispatch`, which queues
    //! onto the activity's main thread and returns nothing. That is right for
    //! raising a share sheet and wrong for a thumbnail: the bytes have to come
    //! back, and decoding on the UI thread is the one thing a gallery must
    //! never do. So the dispatch is used exactly once, to borrow the VM, the
    //! activity and the `ThumbBridge` class (loaded through the activity's
    //! class loader -- a bare `FindClass` from a native thread only sees the
    //! system classes). After that every call attaches its own blocking-pool
    //! thread and calls the static method directly.

    use std::sync::{mpsc, OnceLock};
    use std::time::Duration;
    use wry::prelude::{dispatch, find_class};
    use jni::objects::{GlobalRef, JByteArray, JValue};
    use jni::JavaVM;

    struct Bridge {
        vm: JavaVM,
        cls: GlobalRef,
        ctx: GlobalRef,
    }

    static BRIDGE: OnceLock<Option<Bridge>> = OnceLock::new();

    fn bridge() -> Option<&'static Bridge> {
        BRIDGE
            .get_or_init(|| {
                let (tx, rx) = mpsc::channel::<Option<Bridge>>();
                dispatch(move |env, activity, _webview| {
                    let got = (|| -> Option<Bridge> {
                        let vm = env.get_java_vm().ok()?;
                        let cls = find_class(env, activity, "com/iraslabs/facet/ThumbBridge".into()).ok()?;
                        let cls = env.new_global_ref(&cls).ok()?;
                        let ctx = env.new_global_ref(activity).ok()?;
                        Some(Bridge { vm, cls, ctx })
                    })();
                    if got.is_none() {
                        let _ = env.exception_describe();
                        let _ = env.exception_clear();
                        eprintln!("[FACET] thumb bridge: ThumbBridge class not reachable");
                    }
                    let _ = tx.send(got);
                });
                // The main thread is busy laying out the very grid these
                // tiles belong to; a few seconds is generous, and a miss here
                // costs one launch the fast path, never a hang.
                rx.recv_timeout(Duration::from_secs(8)).ok().flatten()
            })
            .as_ref()
    }

    pub fn load(path: &str, px: i32, video: bool) -> Option<Vec<u8>> {
        let b = bridge()?;
        let mut env = b.vm.attach_current_thread().ok()?;
        let jpath = env.new_string(path).ok()?;
        let result = env.call_static_method(
            &b.cls,
            "load",
            "(Landroid/content/Context;Ljava/lang/String;IZ)[B",
            &[
                JValue::Object(b.ctx.as_obj()),
                JValue::Object(&jpath),
                JValue::Int(px),
                JValue::Bool(u8::from(video)),
            ],
        );
        let obj = match result.and_then(|v| v.l()) {
            Ok(o) => o,
            Err(_) => {
                // A pending exception left in place takes the process down on
                // the next JNI call from this thread.
                let _ = env.exception_describe();
                let _ = env.exception_clear();
                return None;
            }
        };
        if obj.is_null() {
            return None;
        }
        let arr = JByteArray::from(obj);
        let bytes = env.convert_byte_array(&arr).ok()?;
        if bytes.is_empty() { None } else { Some(bytes) }
    }
}

fn store_bytes(cache_dir: &PathBuf, key: &str, bytes: &[u8]) -> bool {
    let target = cache_path(cache_dir, key);
    let Some(parent) = target.parent() else { return false };
    if fs::create_dir_all(parent).is_err() {
        return false;
    }
    // A half-written thumbnail read back on the next launch is a broken tile
    // that never repairs itself, because the cache hit stops anything else from
    // running. Write beside it and rename, which on every filesystem this ships
    // to is the atomic step.
    let tmp = target.with_extension("part");
    if fs::write(&tmp, bytes).is_err() {
        return false;
    }
    fs::rename(&tmp, &target).is_ok()
}

/// The EXIF orientation of a JPEG on disk, 1 when absent or unreadable.
///
/// For ffmpeg's still-image path: the mjpeg decoder ignores EXIF outright, so
/// a poster pulled from a rotated photograph needs an explicit transpose, and
/// this is where the caller learns which one.
pub fn jpeg_orientation(path: &str) -> u8 {
    embedded_jpeg(path).1
}

/// The JPEG stored inside a JPEG's EXIF block, if there is one, and the file's
/// EXIF orientation (1 when unstated).
///
/// Only the head of the file is read. The APP1 segment sits within the first few
/// tens of kilobytes by construction -- it is a header -- so pulling 256 KB and
/// giving up covers every real camera file while putting a hard ceiling on what
/// a malformed one can cost.
fn embedded_jpeg(path: &str) -> (Option<Vec<u8>>, u8) {
    match jpeg_exif_scan(path) {
        Some(found) => found,
        None => (None, 1),
    }
}

fn jpeg_exif_scan(path: &str) -> Option<(Option<Vec<u8>>, u8)> {
    let mut file = fs::File::open(path).ok()?;

    // Two bytes before 256 KB. Only a JPEG can carry an EXIF thumbnail, and a
    // gallery full of clips used to read a quarter megabyte off the card for
    // every one of them purely to discover that the first byte was not 0xFF.
    let mut soi = [0u8; 2];
    file.read_exact(&mut soi).ok()?;
    if soi != [0xFF, 0xD8] {
        return None;
    }

    let mut head = vec![0u8; 256 * 1024];
    head[0] = 0xFF;
    head[1] = 0xD8;
    let mut filled = 2usize;
    while filled < head.len() {
        match file.read(&mut head[filled..]) {
            Ok(0) => break,
            Ok(n) => filled += n,
            Err(_) => return None,
        }
    }
    head.truncate(filled);
    if head.len() < 4 {
        return None;
    }

    // Walk the marker chain to APP1. Not a search for the "Exif" string: that
    // text can occur inside image data, and a false hit there is a garbage
    // offset used as a file position.
    let mut i = 2usize;
    while i + 4 <= head.len() {
        if head[i] != 0xFF {
            return None;
        }
        let marker = head[i + 1];
        // Standalone markers carry no length; SOS means the entropy-coded data
        // has begun and every header is behind us.
        if marker == 0xD8 || (0xD0..=0xD7).contains(&marker) || marker == 0x01 {
            i += 2;
            continue;
        }
        if marker == 0xDA || marker == 0xD9 {
            return None;
        }
        let len = u16::from_be_bytes([head[i + 2], head[i + 3]]) as usize;
        if len < 2 {
            return None;
        }
        let seg = head.get(i + 4..i + 2 + len)?;
        if marker == 0xE1 && seg.len() > 6 && &seg[0..6] == b"Exif\0\0" {
            return exif_scan(&seg[6..]);
        }
        i += 2 + len;
    }
    None
}

/// IFD0 of a TIFF header carries the orientation; IFD1 holds the thumbnail's
/// offset and length. One walk reads both.
fn exif_scan(tiff: &[u8]) -> Option<(Option<Vec<u8>>, u8)> {
    if tiff.len() < 8 {
        return None;
    }
    let big = match &tiff[0..2] {
        b"MM" => true,
        b"II" => false,
        _ => return None,
    };
    let u16at = |b: &[u8], o: usize| -> Option<u16> {
        let s = b.get(o..o + 2)?;
        Some(if big {
            u16::from_be_bytes([s[0], s[1]])
        } else {
            u16::from_le_bytes([s[0], s[1]])
        })
    };
    let u32at = |b: &[u8], o: usize| -> Option<u32> {
        let s = b.get(o..o + 4)?;
        Some(if big {
            u32::from_be_bytes([s[0], s[1], s[2], s[3]])
        } else {
            u32::from_le_bytes([s[0], s[1], s[2], s[3]])
        })
    };

    if u16at(tiff, 2)? != 42 {
        return None;
    }
    let ifd0 = u32at(tiff, 4)? as usize;
    let count0 = u16at(tiff, ifd0)? as usize;

    // Tag 0x0112 in IFD0 is the orientation of the *main* image -- and of the
    // embedded thumbnail too, in practice: cameras store both the same way and
    // rarely bother writing IFD1's own orientation tag.
    let mut orient: u8 = 1;
    for n in 0..count0 {
        let entry = ifd0 + 2 + n * 12;
        if u16at(tiff, entry)? == 0x0112 {
            // SHORT, count 1: the value sits in the first two bytes of the
            // entry's value field.
            let v = u16at(tiff, entry + 8)?;
            if (1..=8).contains(&v) {
                orient = v as u8;
            }
        }
    }

    // Each entry is 12 bytes; the pointer to the next IFD follows them.
    let ifd1 = u32at(tiff, ifd0 + 2 + count0 * 12)? as usize;
    if ifd1 == 0 || ifd1 >= tiff.len() {
        return Some((None, orient));
    }

    let count1 = u16at(tiff, ifd1)? as usize;
    let mut offset = None;
    let mut length = None;
    for n in 0..count1 {
        let entry = ifd1 + 2 + n * 12;
        match u16at(tiff, entry)? {
            0x0201 => offset = Some(u32at(tiff, entry + 8)? as usize),
            0x0202 => length = Some(u32at(tiff, entry + 8)? as usize),
            _ => {}
        }
    }

    let thumb = (|| {
        let (offset, length) = (offset?, length?);
        // A thumbnail smaller than this is a 160x120 postage stamp from a
        // decade-old camera; stretched over a 384 px tile it looks like a
        // mistake rather than a loading state, and the proper one is only a
        // moment behind it.
        if length < 4_000 {
            return None;
        }
        let bytes = tiff.get(offset..offset + length)?;
        if bytes.len() < 4 || bytes[0] != 0xFF || bytes[1] != 0xD8 {
            return None;
        }
        Some(bytes.to_vec())
    })();
    Some((thumb, orient))
}

/// Print a line the Android log can see.
///
/// `console.log` from the WebView does not reach `logcat` in a release build,
/// which is how three rounds of this were debugged from screenshots and got the
/// wrong answer twice. Rust's stdout does reach it, tagged `RustStdoutStderr`.
#[tauri::command]
pub fn mark(what: String) {
    println!("[FACET] {what}");
}
