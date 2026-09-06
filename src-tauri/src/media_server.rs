//! Loopback media server — Android only.
//!
//! The asset protocol cannot stream video on Android, and the reason is below
//! the app: a response returned from `shouldInterceptRequest` goes through
//! Chromium's stream-reader job, which applies the request's `Range` offset to
//! the returned InputStream *itself* — that is the WebViewAssetLoader contract,
//! where the app always hands back the whole file. Tauri's asset handler has
//! already sliced the body to the requested range, so the skip lands a second
//! time: `bytes=0-N` survives (skip of zero), any nonzero start seeks past the
//! end of its own slice and the fetch dies. A video plays exactly as far as the
//! demuxer's first from-zero read and then hits `PIPELINE_ERROR_DECODE`.
//!
//! So on Android, `<video>`/`<audio>` sources come from here instead: a real
//! TCP listener on 127.0.0.1 speaking just enough HTTP to serve `GET`/`HEAD`
//! with correct `Range` semantics, streaming from disk in chunks — never the
//! whole file in memory, which the asset protocol also gets wrong for a
//! full-file read. Images stay on the asset protocol; they are fetched whole,
//! which is the one case it handles.
//!
//! Any app on the phone can dial 127.0.0.1, and FACET holds all-files access,
//! so the port is fenced twice over. Every URL carries a per-launch random
//! token, and separately the server will only open a path that `media_url`
//! actually handed out during this launch. The second fence is the one that
//! matters: a token that leaks -- into a log, a crash report, a screenshot of a
//! devtools network tab -- would otherwise turn the port into a read-everything
//! oracle for the whole device. With the allowlist, the worst a leaked token
//! buys is the handful of files the user already opened in FACET.

#![cfg(target_os = "android")]

use std::collections::hash_map::RandomState;
use std::collections::{HashSet, VecDeque};
use std::hash::{BuildHasher, Hasher};
use std::io::{BufRead, BufReader, Read, Seek, SeekFrom, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Mutex, OnceLock};

/// `None` when the bind failed — remembered so a broken server is not retried
/// on every keystroke, and the caller falls back to the asset protocol.
static SERVER: OnceLock<Option<(u16, String)>> = OnceLock::new();

/// Connections being served right now, and the ceiling on them.
static LIVE: AtomicUsize = AtomicUsize::new(0);
const CONN_MAX: usize = 32;

/// Every path `media_url` has resolved this launch: the set `serve` is allowed
/// to open. `None` until the first URL is minted.
static HANDED: Mutex<Option<Handed>> = Mutex::new(None);

/// Oldest handed-out paths are forgotten first. A long scroll through a folder
/// of video mints a URL per file and the set would otherwise grow for the
/// lifetime of the process. The cap is far above anything the player holds open
/// at once, and `media_url` runs again on every open, so a path falling out
/// costs nothing -- it is re-admitted the moment the file is opened again.
const HANDED_MAX: usize = 4096;

#[derive(Default)]
struct Handed {
    set: HashSet<String>,
    order: VecDeque<String>,
}

#[tauri::command]
pub fn media_url(path: String) -> Result<String, String> {
    let (port, token) = SERVER
        .get_or_init(start)
        .as_ref()
        .ok_or("media server failed to start")?;
    // Resolve here and put the *resolved* path in the URL, so the string the
    // server later approves and the string it later opens are the same one.
    // Approving the spelling the caller gave would let `a/../b`, or a symlink
    // re-pointed in between, be checked as one file and opened as another.
    let real = std::fs::canonicalize(&path).map_err(|e| format!("{path}: {e}"))?;
    let real = real.to_string_lossy().into_owned();
    remember(&real);
    Ok(format!("http://127.0.0.1:{port}/{token}/{}", encode(&real)))
}

fn remember(path: &str) {
    // A panic in one connection thread must not poison this gate shut for the
    // rest of the launch; the set holds no invariant a panic could break.
    let mut guard = HANDED.lock().unwrap_or_else(|e| e.into_inner());
    let handed = guard.get_or_insert_with(Handed::default);
    if !handed.set.insert(path.to_string()) {
        return;
    }
    handed.order.push_back(path.to_string());
    while handed.order.len() > HANDED_MAX {
        if let Some(old) = handed.order.pop_front() {
            handed.set.remove(&old);
        }
    }
}

fn was_handed(path: &str) -> bool {
    let guard = HANDED.lock().unwrap_or_else(|e| e.into_inner());
    guard.as_ref().is_some_and(|h| h.set.contains(path))
}

fn start() -> Option<(u16, String)> {
    // Port 0: the OS picks a free ephemeral port, so nothing is reserved and
    // nothing can collide with another app's listener.
    let listener = match TcpListener::bind(("127.0.0.1", 0)) {
        Ok(l) => l,
        Err(e) => {
            eprintln!("[FACET] media server bind failed: {e}");
            return None;
        }
    };
    let port = listener.local_addr().ok()?.port();
    let token = fresh_token();
    let check = token.clone();
    std::thread::spawn(move || {
        for conn in listener.incoming() {
            let Ok(stream) = conn else { continue };
            let token = check.clone();
            // Thread per connection, but a bounded number of them. The only
            // legitimate client is the WebView one process over and it keeps a
            // handful open; any app on the device can also dial this port, and
            // a thread each for ten thousand connections that never say
            // anything is a way to take the app down from outside it.
            if LIVE.fetch_add(1, Ordering::Relaxed) >= CONN_MAX {
                LIVE.fetch_sub(1, Ordering::Relaxed);
                continue;
            }
            std::thread::spawn(move || {
                // A client that connects and never sends a request line would
                // otherwise pin a thread forever.
                let _ = stream.set_read_timeout(Some(std::time::Duration::from_secs(10)));
                let _ = stream.set_write_timeout(Some(std::time::Duration::from_secs(60)));
                let _ = serve(stream, &token, port);
                LIVE.fetch_sub(1, Ordering::Relaxed);
            });
        }
    });
    #[cfg(debug_assertions)]
    eprintln!("[FACET] media server on 127.0.0.1:{port}");
    Some((port, token))
}

/// 256 bits nobody outside this process can predict.
///
/// Straight from the kernel's CSPRNG. The obvious std-only trick — hashing a
/// counter under `RandomState`'s keys — looks like 256 bits and is not: the
/// keys come from one per-thread seed that std only increments between calls,
/// so the four words are a *derivation* of a single secret rather than four
/// independent draws, and nothing in std's contract promises that secret is
/// cryptographically strong. This token is the only thing standing between
/// every other app on the phone and a read-anything oracle, so it is worth
/// the twelve lines.
///
/// The fallback exists because a failure here must not take the media server
/// down with it; `/dev/urandom` is always present on Android, and if it ever
/// is not, a weak token still beats no video at all.
fn fresh_token() -> String {
    let mut bytes = [0u8; 32];
    if read_urandom(&mut bytes).is_ok() {
        let mut out = String::with_capacity(64);
        for b in bytes {
            out.push_str(&format!("{b:02x}"));
        }
        return out;
    }
    let mut out = String::with_capacity(64);
    for i in 0..4u64 {
        let mut h = RandomState::new().build_hasher();
        h.write_u64(i);
        out.push_str(&format!("{:016x}", h.finish()));
    }
    out
}

fn read_urandom(buf: &mut [u8]) -> std::io::Result<()> {
    let mut f = std::fs::File::open("/dev/urandom")?;
    f.read_exact(buf)
}

/// Compare in time that does not depend on how many leading bytes matched.
///
/// A neighbour app can time this over loopback, and a comparison that returns
/// on the first wrong byte leaks the token one byte at a time.
fn token_eq(a: &str, b: &str) -> bool {
    let (a, b) = (a.as_bytes(), b.as_bytes());
    if a.len() != b.len() {
        return false;
    }
    let mut diff = 0u8;
    for i in 0..a.len() {
        diff |= a[i] ^ b[i];
    }
    diff == 0
}

/// Longest request line or header line this will read. A path plus a token is
/// a few hundred bytes; anything past this is a client trying to make the
/// server hold memory for it, and `read_line` on its own has no ceiling.
const LINE_MAX: u64 = 8 * 1024;
/// Headers a well-formed request from the WebView needs: a handful. The cap is
/// generous and still stops an endless header stream from looping forever
/// inside the read timeout.
const HEADER_MAX: usize = 64;

fn serve(mut stream: TcpStream, token: &str, port: u16) -> std::io::Result<()> {
    let mut reader = BufReader::new(stream.try_clone()?);
    let mut line = String::new();
    (&mut reader).take(LINE_MAX).read_line(&mut line)?;
    let mut parts = line.split_whitespace();
    let method = parts.next().unwrap_or("");
    let target = parts.next().unwrap_or("");

    let mut range: Option<String> = None;
    let mut host: Option<String> = None;
    let mut origin: Option<String> = None;
    for _ in 0..HEADER_MAX {
        let mut header = String::new();
        if (&mut reader).take(LINE_MAX).read_line(&mut header)? == 0 {
            break;
        }
        let header = header.trim_end();
        if header.is_empty() {
            break;
        }
        let Some((name, value)) = header.split_once(':') else {
            continue;
        };
        // Names are case-insensitive; the values keep their case.
        match name.to_ascii_lowercase().as_str() {
            "range" => range = Some(value.trim().to_string()),
            "host" => host = Some(value.trim().to_string()),
            "origin" => origin = Some(value.trim().to_string()),
            _ => {}
        }
    }
    let origin = origin.as_deref();

    if method != "GET" && method != "HEAD" {
        return refuse(&mut stream, "405 Method Not Allowed", origin);
    }
    // A `Host` that is not the address this server bound means the request
    // arrived under some other name -- the shape of a DNS rebinding page, which
    // points a domain it controls at 127.0.0.1 so the browser treats what comes
    // back as same-origin with the attacker's site. The WebView always sends
    // the literal, so this costs nothing legitimate.
    if host.as_deref() != Some(format!("127.0.0.1:{port}").as_str()) {
        return refuse(&mut stream, "404 Not Found", origin);
    }
    let Some(rest) = target
        .strip_prefix('/')
        .and_then(|t| t.split_once('/'))
        .and_then(|(given, rest)| token_eq(given, token).then_some(rest))
    else {
        // Wrong or missing token. 404, not 403: no need to confirm to a
        // port-scanning neighbour that there is something here to unlock.
        return refuse(&mut stream, "404 Not Found", origin);
    };

    // The token gets a request this far; the allowlist decides whether there is
    // a file at the end of it. Resolve, check the resolved path, then open that
    // same resolved path -- see `media_url` for why the check and the open must
    // not be given two different strings.
    let Ok(real) = std::fs::canonicalize(decode(rest)) else {
        return refuse(&mut stream, "404 Not Found", origin);
    };
    let path = real.to_string_lossy().into_owned();
    if !was_handed(&path) {
        return refuse(&mut stream, "404 Not Found", origin);
    }

    let mut file = match std::fs::File::open(&real) {
        Ok(f) => f,
        Err(_) => return refuse(&mut stream, "404 Not Found", origin),
    };
    let len = file.metadata()?.len();
    let mime = mime_for(&path);

    // One range only — Chromium's media stack never sends multipart ranges.
    let parsed = match range.as_deref().map(|r| parse_range(r, len)) {
        None => None,
        Some(Ok(r)) => Some(r),
        Some(Err(())) => {
            // The CORS line rides along even on errors: without it a JS fetch
            // sees a network failure instead of the 416.
            let cors = cors(origin);
            let head = format!(
                "HTTP/1.1 416 Range Not Satisfiable\r\nContent-Range: bytes */{len}\r\n{cors}Connection: close\r\n\r\n"
            );
            stream.write_all(head.as_bytes())?;
            return Ok(());
        }
    };

    let (status, start, end) = match parsed {
        Some((s, e)) => ("206 Partial Content", s, e),
        None => ("200 OK", 0, len.saturating_sub(1)),
    };
    let body_len = if len == 0 { 0 } else { end - start + 1 };

    let cors = cors(origin);
    let mut head = format!(
        "HTTP/1.1 {status}\r\nContent-Type: {mime}\r\nContent-Length: {body_len}\r\nAccept-Ranges: bytes\r\n{cors}Connection: close\r\n"
    );
    if parsed.is_some() {
        head.push_str(&format!("Content-Range: bytes {start}-{end}/{len}\r\n"));
    }
    head.push_str("\r\n");
    stream.write_all(head.as_bytes())?;

    if method == "HEAD" || body_len == 0 {
        return Ok(());
    }

    file.seek(SeekFrom::Start(start))?;
    let mut left = body_len;
    let mut buf = vec![0u8; 256 * 1024];
    while left > 0 {
        let want = buf.len().min(left as usize);
        let got = file.read(&mut buf[..want])?;
        if got == 0 {
            break; // file shrank underneath us; the short body ends the stream
        }
        stream.write_all(&buf[..got])?;
        left -= got as u64;
    }
    Ok(())
}

fn refuse(stream: &mut TcpStream, status: &str, origin: Option<&str>) -> std::io::Result<()> {
    let cors = cors(origin);
    let head =
        format!("HTTP/1.1 {status}\r\nContent-Length: 0\r\n{cors}Connection: close\r\n\r\n");
    stream.write_all(head.as_bytes())
}

/// The `Access-Control-Allow-Origin` line for a request, if it earns one.
///
/// `*` would let a page on any site the user happens to have open read these
/// responses, given the port and the token. `<video>` and `<audio>` never need
/// the header -- they fetch no-cors -- so the only callers that do are FACET's
/// own `fetch()`es, and those come from FACET's own origin. Echo it back for
/// those and for nobody else.
fn cors(origin: Option<&str>) -> String {
    match origin.filter(|o| own_origin(o)) {
        // `Vary` because the answer differs per origin, and a shared cache that
        // missed that would hand one site another site's permission.
        Some(o) => format!("Access-Control-Allow-Origin: {o}\r\nVary: Origin\r\n"),
        None => "Vary: Origin\r\n".to_string(),
    }
}

/// The origins the app's own WebView loads under: `tauri.localhost` in a built
/// app, the dev server on loopback while developing.
fn own_origin(origin: &str) -> bool {
    let Some((scheme, rest)) = origin.split_once("://") else {
        return false;
    };
    if scheme != "http" && scheme != "https" {
        return false;
    }
    let (host, port) = rest.split_once(':').map_or((rest, ""), |(h, p)| (h, p));
    // The value is echoed straight back into a response header, so nothing but
    // a hostname and a numeric port may pass.
    if !port.is_empty() && !port.bytes().all(|b| b.is_ascii_digit()) {
        return false;
    }
    // A shipped app only ever loads from `tauri.localhost`. The other two are
    // where `tauri dev` serves from, and they pass only in a debug build, so a
    // release binary cannot be talked to by whatever else the person happens to
    // be running on their own loopback.
    if !cfg!(debug_assertions) {
        return host == "tauri.localhost";
    }
    matches!(host, "tauri.localhost" | "localhost" | "127.0.0.1")
}

/// `bytes=a-b` | `bytes=a-` | `bytes=-suffix` → inclusive (start, end).
fn parse_range(raw: &str, len: u64) -> Result<(u64, u64), ()> {
    let spec = raw.strip_prefix("bytes=").ok_or(())?.trim();
    let spec = spec.split(',').next().ok_or(())?.trim();
    let (a, b) = spec.split_once('-').ok_or(())?;
    if len == 0 {
        return Err(());
    }
    if a.is_empty() {
        // suffix form: last N bytes
        let n: u64 = b.parse().map_err(|_| ())?;
        if n == 0 {
            return Err(());
        }
        return Ok((len.saturating_sub(n), len - 1));
    }
    let start: u64 = a.parse().map_err(|_| ())?;
    if start >= len {
        return Err(());
    }
    let end = if b.is_empty() {
        len - 1
    } else {
        b.parse::<u64>().map_err(|_| ())?.min(len - 1)
    };
    if end < start {
        return Err(());
    }
    Ok((start, end))
}

fn mime_for(path: &str) -> &'static str {
    let ext = path.rsplit('.').next().unwrap_or("").to_ascii_lowercase();
    match ext.as_str() {
        "mp4" | "m4v" => "video/mp4",
        "mov" => "video/quicktime",
        "webm" => "video/webm",
        "mkv" => "video/x-matroska",
        "3gp" => "video/3gpp",
        "ogv" => "video/ogg",
        "mp3" => "audio/mpeg",
        "m4a" => "audio/mp4",
        "aac" => "audio/aac",
        "ogg" | "oga" | "opus" => "audio/ogg",
        "flac" => "audio/flac",
        "wav" => "audio/wav",
        _ => "application/octet-stream",
    }
}

/// Percent-encode everything but the unreserved set, path separators included —
/// the whole path is one opaque segment as far as this server cares.
fn encode(path: &str) -> String {
    let mut out = String::with_capacity(path.len());
    for b in path.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' | b'/' => {
                out.push(b as char)
            }
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

fn decode(raw: &str) -> String {
    let bytes = raw.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let Ok(b) = u8::from_str_radix(&raw[i + 1..i + 3], 16) {
                out.push(b);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}
