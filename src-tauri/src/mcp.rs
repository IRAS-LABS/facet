//! FACET as an MCP server: `facet mcp`.
//!
//! The same engine the window drives, exposed to a model over stdio instead of
//! over Tauri's IPC. It is the *same binary* — not a sidecar, not a Node
//! wrapper — for three reasons that all turned out to be the same reason.
//!
//! An installed FACET already carries a working ffmpeg and ffprobe next to it
//! (`<install dir>\ffmpeg\`), which `ffmpeg.rs` finds before it falls back to
//! PATH. A separate MCP package would either ship a second 200 MB copy or
//! demand the user install one. It already carries the file rules — the
//! taken-name dance, the never-overwrite-unless-told default, the Recycle Bin
//! instead of an unlink — and a reimplementation is a second place for those
//! to drift, which is exactly the class of bug the originals exist to prevent.
//! And a model that can list a folder but not encode what it found there is a
//! worse tool than no tool at all.
//!
//! No window is created and no Tauri builder is touched: `run()` hands off
//! here before any of that, so `facet mcp` never flashes an explorer up, never
//! collides with the single-instance plugin, and costs nothing to start.
//!
//! ## Protocol
//!
//! JSON-RPC 2.0 in newline-delimited JSON, one message per line, as the MCP
//! stdio transport specifies. `initialize`, `tools/list`, `tools/call` and
//! `ping` are answered; notifications are accepted and ignored, which is all a
//! server is obliged to do with them.
//!
//! Nothing but protocol ever reaches stdout. Diagnostics go to stderr, because
//! one stray `println!` in this file corrupts the stream for the whole session
//! and the client's error will point at its parser, not at the print.
//!
//! ## What a caller can do with it
//!
//! Read a folder, look inside a media file, pull a still or a waveform out of
//! one, and copy, move, recycle or encode. Deliberately *not* here: anything
//! that needs a window — the signing panel, the pop-out player, the share
//! sheet. Those are gestures, not questions, and a model cannot supply the
//! hand that makes them.

use std::io::{BufRead, Write};

use serde_json::{json, Map, Value};

/// The revision of the MCP spec this server was written against.
const LATEST: &str = "2025-06-18";

/// Revisions this server will answer in, newest first.
///
/// A client that asked for one it still supports is better served by hearing
/// its own number back than by being told to upgrade; anything else gets
/// `LATEST`, which is the spec's rule.
const SPOKEN: [&str; 3] = ["2025-06-18", "2025-03-26", "2024-11-05"];

// --------------------------------------------------------------- base64
//
// Sixteen lines rather than a dependency. The only thing that needs encoding
// is the JPEG from `facet_frame` — images are the one MCP content type that is
// not text — and pulling in a crate, plus its version, its line in
// THIRD-PARTY-NOTICES.md and its place in the audit, to spell out a
// four-decade-old alphabet is not a trade worth making.

const B64: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

pub(crate) fn base64(raw: &[u8]) -> String {
    let mut out = String::with_capacity(raw.len().div_ceil(3) * 4);
    for chunk in raw.chunks(3) {
        let b = [chunk[0], *chunk.get(1).unwrap_or(&0), *chunk.get(2).unwrap_or(&0)];
        let n = ((b[0] as u32) << 16) | ((b[1] as u32) << 8) | (b[2] as u32);
        out.push(B64[(n >> 18 & 63) as usize] as char);
        out.push(B64[(n >> 12 & 63) as usize] as char);
        out.push(if chunk.len() > 1 { B64[(n >> 6 & 63) as usize] as char } else { '=' });
        out.push(if chunk.len() > 2 { B64[(n & 63) as usize] as char } else { '=' });
    }
    out
}

// ----------------------------------------------------------- argument help
//
// A model gets an argument wrong the way a person does: a missing field, a
// number sent as a string, a path with the wrong slashes. The useful answer
// names the field and says what was expected — a bare "Invalid params" costs a
// whole round trip to learn nothing.

fn arg<'a>(args: &'a Map<String, Value>, key: &str) -> Result<&'a Value, String> {
    args.get(key).ok_or_else(|| format!("missing required argument `{key}`"))
}

fn text_arg(args: &Map<String, Value>, key: &str) -> Result<String, String> {
    arg(args, key)?
        .as_str()
        .map(str::to_owned)
        .ok_or_else(|| format!("`{key}` has to be a string"))
}

fn num_arg(args: &Map<String, Value>, key: &str, fallback: f64) -> Result<f64, String> {
    match args.get(key) {
        None | Some(Value::Null) => Ok(fallback),
        Some(v) => v.as_f64().ok_or_else(|| format!("`{key}` has to be a number")),
    }
}

fn flag(args: &Map<String, Value>, key: &str) -> bool {
    args.get(key).and_then(Value::as_bool).unwrap_or(false)
}

fn paths_arg(args: &Map<String, Value>, key: &str) -> Result<Vec<String>, String> {
    let list = arg(args, key)?
        .as_array()
        .ok_or_else(|| format!("`{key}` has to be an array of paths"))?;
    list.iter()
        .map(|v| {
            v.as_str()
                .map(str::to_owned)
                .ok_or_else(|| format!("every entry in `{key}` has to be a string"))
        })
        .collect()
}

// ------------------------------------------------------------------ tools

/// The `tools/list` answer.
///
/// Written out longhand rather than derived from the Rust signatures: a
/// description is the only thing a model reads before deciding whether to call
/// a tool, and it is worth more care than a macro would give it.
fn catalogue() -> Value {
    // These two mirror `ffmpeg::Span` and `ffmpeg::Crop` exactly, field name for
    // field name. The convert job is deserialised straight into `ffmpeg::Job`
    // by serde, which ignores anything it does not recognise — so a schema that
    // says `from`/`to` where the struct says `start`/`end` does not fail
    // loudly, it silently exports the whole file. `a_fully_specified_job_lands`
    // below is the test that keeps the two honest.
    let span = json!({
        "type": "object",
        "properties": {
            "start": { "type": "number", "description": "Seconds from the beginning of the input." },
            "end": { "type": "number", "description": "Seconds from the beginning of the input." }
        },
        "required": ["start", "end"]
    });
    let crop = json!({
        "type": "object",
        "description": "Pixels, measured on the source before any rotation or scaling.",
        "properties": {
            "x": { "type": "integer" }, "y": { "type": "integer" },
            "w": { "type": "integer" }, "h": { "type": "integer" }
        },
        "required": ["x", "y", "w", "h"]
    });

    let mut tools = json!([
        {
            "name": "facet_places",
            "description": "The starting points on this machine: every mounted drive, plus the user's Desktop, Documents, Downloads, Pictures, Music and Videos, each with the path to hand to facet_list_dir. Call this first when you do not know where to look.",
            "inputSchema": { "type": "object", "properties": {} }
        },
        {
            "name": "facet_list_dir",
            "description": "List one folder: every entry with its name, full path, whether it is a directory, size in bytes, last-modified time, and whether the OS marks it hidden. Does not recurse.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "path": { "type": "string", "description": "Absolute path of the folder. Forward slashes work on Windows." }
                },
                "required": ["path"]
            }
        },
        {
            "name": "facet_probe",
            "description": "Inspect a media file with ffprobe: duration in seconds, bitrate, container format, display width and height after rotation, and every audio, video and subtitle track. Works on anything ffmpeg can open.",
            "inputSchema": {
                "type": "object",
                "properties": { "path": { "type": "string" } },
                "required": ["path"]
            }
        },
        {
            "name": "facet_frame",
            "description": "Pull a single still out of a video or a photo and return it as an image, scaled to the requested width. Use it to see what a file actually contains.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "path": { "type": "string" },
                    "at": { "type": "number", "description": "Seconds into the file. Defaults to 1. Ignored for stills." },
                    "width": { "type": "integer", "description": "Pixels wide; height follows the aspect ratio. Defaults to 640." }
                },
                "required": ["path"]
            }
        },
        {
            "name": "facet_keyframes",
            "description": "The timestamps of the keyframes between two points in a video. A cut on a keyframe can be made by copying the stream instead of re-encoding, which is instant and lossless.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "path": { "type": "string" },
                    "from": { "type": "number", "description": "Seconds. Defaults to 0." },
                    "to": { "type": "number", "description": "Seconds. Defaults to the end of the file." }
                },
                "required": ["path"]
            }
        },
        {
            "name": "facet_waveform",
            "description": "Loudness of an audio or video file sampled into evenly spaced buckets, each 0 to 1. Use it to find silence, gaps between speakers, or where the music starts, without moving the audio anywhere.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "path": { "type": "string" },
                    "buckets": { "type": "integer", "description": "How many samples to return, 16 to 8192. Defaults to 400." }
                },
                "required": ["path"]
            }
        },
        {
            "name": "facet_read_text",
            "description": "Read the beginning of a file as UTF-8 text. Bounded on purpose: this is for looking at a file, not for loading one.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "path": { "type": "string" },
                    "maxBytes": { "type": "integer", "description": "How much to read, up to 1048576. Defaults to 65536." }
                },
                "required": ["path"]
            }
        },
        {
            "name": "facet_copy",
            "description": "Copy a file or a whole folder. Refuses to overwrite unless told to; without overwrite, a clash is resolved by taking the next free name while keeping the extension, and the name actually used comes back in the result.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "from": { "type": "string" },
                    "to": { "type": "string", "description": "Full destination path, including the new name." },
                    "overwrite": { "type": "boolean", "description": "Default false." }
                },
                "required": ["from", "to"]
            }
        },
        {
            "name": "facet_move",
            "description": "Move or rename a file or folder, across volumes if needed. Same never-overwrite-by-default rule as facet_copy, and it refuses to put a folder inside itself.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "from": { "type": "string" },
                    "to": { "type": "string" },
                    "overwrite": { "type": "boolean", "description": "Default false." }
                },
                "required": ["from", "to"]
            }
        },
        {
            "name": "facet_recycle",
            "description": "Send files to the Recycle Bin. This is never a permanent delete: everything stays recoverable until the user empties the bin themselves. There is deliberately no tool here that deletes outright.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "paths": { "type": "array", "items": { "type": "string" } }
                },
                "required": ["paths"]
            }
        },
        {
            "name": "facet_convert",
            "description": "Encode with ffmpeg and wait for it to finish. Trim to spans, crop, rotate, flip, scale, change speed, fade, set quality or frame rate, mute. When the requested edit is only a cut on keyframe boundaries the streams are copied rather than re-encoded, which is instant and lossless. Writes to a temporary name and renames into place only on success, so a failed encode never leaves a half-written file where the real one should be.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "inputs": {
                        "type": "array",
                        "items": { "type": "string" },
                        "description": "One input to export, several to join them in order."
                    },
                    "output": { "type": "string", "description": "Full path to write. The extension picks the container." },
                    "spans": {
                        "type": "array",
                        "items": span,
                        "description": "Parts to keep, each {start, end} in seconds. Omit for the whole file; several spans are joined in order."
                    },
                    "crop": crop,
                    "rotate": { "type": "integer", "description": "0, 90, 180 or 270, clockwise." },
                    "flipH": { "type": "boolean" },
                    "flipV": { "type": "boolean" },
                    "speed": { "type": "number", "description": "1 leaves timing alone. 20 is a timelapse, 0.5 is slow motion." },
                    "smooth": { "type": "boolean", "description": "Synthesise the in-between frames when slowing down. Expensive; off by default." },
                    "scale": { "type": "array", "items": { "type": "integer" }, "description": "[width, height]." },
                    "mute": { "type": "boolean" },
                    "fadeIn": { "type": "number", "description": "Seconds." },
                    "fadeOut": { "type": "number", "description": "Seconds." },
                    "quality": { "type": "integer", "description": "x264 CRF. 18 is visually lossless, 23 the default, 28 small." },
                    "fps": { "type": "number", "description": "Omit to keep the source rate." },
                    "precise": { "type": "boolean", "description": "Force a re-encode even where a stream copy would have worked, for a frame-exact cut." }
                },
                "required": ["inputs", "output"]
            }
        }
    ]);
    // The tools that drive FACET's own window rather than files on disk. They
    // live in their own module because they are a different kind of thing: a
    // file tool answers from disk, a UI tool needs a window to be open and a
    // debugging port to have been asked for.
    if let Some(list) = tools.as_array_mut() {
        list.extend(crate::ui::catalogue());
    }
    tools
}

/// The result of one `tools/call`, before it is wrapped for the wire.
pub(crate) enum Answer {
    /// Anything describable. Serialised as pretty JSON, which is what a model
    /// reads best and what a person debugging the session reads at all.
    Json(Value),
    Jpeg(Vec<u8>),
    /// An image that arrived already encoded — a screenshot comes off the wire
    /// as base64 and decoding it here only to encode it again would be work
    /// done twice to arrive at the same string.
    Image { b64: String, mime: &'static str },
}

fn call(name: &str, args: &Map<String, Value>) -> Result<Answer, String> {
    // `facet_ui_*` first, and by prefix rather than by name, so adding a tool
    // over there never needs an edit over here.
    if let Some(answer) = crate::ui::call(name, args) {
        return answer;
    }
    match name {
        "facet_places" => Ok(Answer::Json(json!({
            "drives": crate::fsx::list_roots(),
            "folders": crate::fsx::home_places(),
        }))),

        "facet_list_dir" => {
            let listing = crate::fsx::list_dir(text_arg(args, "path")?)?;
            Ok(Answer::Json(serde_json::to_value(listing).map_err(|e| e.to_string())?))
        }

        "facet_probe" => {
            let media = crate::ffmpeg::probe_media(text_arg(args, "path")?)?;
            Ok(Answer::Json(serde_json::to_value(media).map_err(|e| e.to_string())?))
        }

        "facet_frame" => {
            let path = text_arg(args, "path")?;
            let at = num_arg(args, "at", 1.0)?;
            // Clamped rather than rejected: a caller that asks for a 20000px
            // still has made a units mistake, and the useful response is the
            // picture, not a lecture.
            let width = num_arg(args, "width", 640.0)?.clamp(16.0, 4096.0) as u32;
            Ok(Answer::Jpeg(crate::ffmpeg::frame_bytes(path, at, width)?))
        }

        "facet_keyframes" => {
            let path = text_arg(args, "path")?;
            let from = num_arg(args, "from", 0.0)?;
            // `to` defaults to the end, which means asking the file how long it
            // is. The caller should not have to probe first just to say "all of
            // it".
            let to = match args.get("to").and_then(Value::as_f64) {
                Some(v) => v,
                None => crate::ffmpeg::probe_media(path.clone()).map(|m| m.duration).unwrap_or(0.0),
            };
            let at = crate::ffmpeg::keyframes(path, from, to)?;
            Ok(Answer::Json(json!({ "count": at.len(), "seconds": at })))
        }

        "facet_waveform" => {
            let buckets = num_arg(args, "buckets", 400.0)?.clamp(16.0, 8192.0) as u32;
            let peaks = crate::ffmpeg::peaks(text_arg(args, "path")?, buckets)?;
            Ok(Answer::Json(json!({ "buckets": peaks.len(), "levels": peaks })))
        }

        "facet_read_text" => {
            let max = num_arg(args, "maxBytes", 65536.0)?.clamp(1.0, 1_048_576.0) as usize;
            let raw = crate::fsx::read_head(text_arg(args, "path")?, max)?;
            let read = raw.len();
            // Lossy on purpose: a caller asking to read a file wants to see
            // what is in it, and refusing the whole thing over one bad byte in
            // a log is the less useful answer.
            Ok(Answer::Json(json!({
                "bytesRead": read,
                "truncated": read == max,
                "text": String::from_utf8_lossy(&raw),
            })))
        }

        "facet_copy" => {
            let r = crate::fsx::copy_file(
                text_arg(args, "from")?,
                text_arg(args, "to")?,
                flag(args, "overwrite"),
            )?;
            Ok(Answer::Json(serde_json::to_value(r).map_err(|e| e.to_string())?))
        }

        "facet_move" => {
            let r = crate::fsx::move_file(
                text_arg(args, "from")?,
                text_arg(args, "to")?,
                flag(args, "overwrite"),
            )?;
            Ok(Answer::Json(serde_json::to_value(r).map_err(|e| e.to_string())?))
        }

        "facet_recycle" => {
            let paths = paths_arg(args, "paths")?;
            if paths.is_empty() {
                return Err("nothing to recycle".into());
            }
            recycle(&paths)?;
            Ok(Answer::Json(json!({
                "recycled": paths,
                "note": "In the Recycle Bin, not deleted. Restore from there if this was wrong.",
            })))
        }

        "facet_convert" => {
            // The job shape is the one the window sends, so the schema above
            // and `Job` cannot drift apart: this is the same deserialiser.
            let job: crate::ffmpeg::Job = serde_json::from_value(Value::Object(args.clone()))
                .map_err(|e| format!("that job does not make sense: {e}"))?;
            let out = crate::ffmpeg::run_job_blocking(job)?;
            Ok(Answer::Json(json!({ "ok": true, "output": out })))
        }

        other => Err(format!("no such tool: {other}")),
    }
}

/// Send paths to the OS Recycle Bin.
///
/// The whole list is checked before anything moves. "Recycled four of your five
/// files and then hit a permission error" leaves the caller with no idea what
/// state it is in, and the check is a stat.
#[cfg(windows)]
fn recycle(paths: &[String]) -> Result<(), String> {
    for p in paths {
        if !std::path::Path::new(p).exists() {
            return Err(format!("nothing at {p} — nothing was recycled"));
        }
    }
    for p in paths {
        trash::delete(p).map_err(|e| format!("{p}: {e}"))?;
    }
    Ok(())
}

/// Elsewhere, refuse rather than delete.
///
/// `trash` is a Windows-only dependency in Cargo.toml, and the one thing this
/// server must never do is turn a request to recycle into a permanent unlink
/// because the bin was not available.
#[cfg(not(windows))]
fn recycle(_paths: &[String]) -> Result<(), String> {
    Err("the Recycle Bin is only wired up on Windows".into())
}

// ------------------------------------------------------------------- wire

fn ok(id: Value, result: Value) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "result": result })
}

fn fail(id: Value, code: i32, message: &str) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": message } })
}

/// A tool that failed is *not* a JSON-RPC error.
///
/// The distinction matters and is easy to get backwards. A protocol error means
/// the server broke and the client should give up; `isError` means the tool ran
/// and the answer is bad news the caller is expected to read and work around —
/// a missing file, an unencodable input. Reporting "no such file" as a protocol
/// error is how a model ends up unable to retry with a better path.
fn tool_error(id: Value, why: &str) -> Value {
    ok(id, json!({ "content": [{ "type": "text", "text": why }], "isError": true }))
}

fn respond(msg: &Value) -> Option<Value> {
    let method = msg.get("method").and_then(Value::as_str).unwrap_or("");
    // No id means a notification: acknowledged by saying nothing, which is what
    // the spec asks and what keeps `notifications/initialized` from becoming an
    // error the client logs on every startup.
    let id = msg.get("id").cloned()?;
    let empty = Map::new();
    let params = msg.get("params").and_then(Value::as_object).unwrap_or(&empty);

    match method {
        "initialize" => {
            let asked = params.get("protocolVersion").and_then(Value::as_str).unwrap_or(LATEST);
            let version = if SPOKEN.contains(&asked) { asked } else { LATEST };
            Some(ok(
                id,
                json!({
                    "protocolVersion": version,
                    "capabilities": { "tools": { "listChanged": false } },
                    "serverInfo": { "name": "facet", "version": env!("CARGO_PKG_VERSION") },
                    "instructions": "FACET's file and media engine. facet_places finds the drives and home folders, facet_list_dir reads one folder, facet_probe and facet_frame look inside a media file, and facet_convert encodes. Deleting is always to the Recycle Bin, and copies never overwrite unless you pass overwrite: true.",
                }),
            ))
        }

        "ping" => Some(ok(id, json!({}))),

        "tools/list" => Some(ok(id, json!({ "tools": catalogue() }))),

        "tools/call" => {
            let Some(name) = params.get("name").and_then(Value::as_str) else {
                return Some(fail(id, -32602, "tools/call needs a `name`"));
            };
            let args = params.get("arguments").and_then(Value::as_object).unwrap_or(&empty).clone();
            match call(name, &args) {
                Err(why) => Some(tool_error(id, &why)),
                Ok(Answer::Json(v)) => {
                    let pretty = serde_json::to_string_pretty(&v).unwrap_or_else(|_| v.to_string());
                    Some(ok(
                        id,
                        // `structuredContent` alongside the text, so a client
                        // that can use the real shape does and one that only
                        // reads text still sees everything.
                        json!({
                            "content": [{ "type": "text", "text": pretty }],
                            "structuredContent": v,
                        }),
                    ))
                }
                Ok(Answer::Jpeg(bytes)) => Some(ok(
                    id,
                    json!({ "content": [{
                        "type": "image",
                        "data": base64(&bytes),
                        "mimeType": "image/jpeg",
                    }] }),
                )),
                Ok(Answer::Image { b64, mime }) => Some(ok(
                    id,
                    json!({ "content": [{ "type": "image", "data": b64, "mimeType": mime }] }),
                )),
            }
        }

        // Answered rather than dropped: a client waiting on an id it will never
        // hear about hangs, and a hung MCP server looks like a hung model.
        other => Some(fail(id, -32601, &format!("this server does not implement {other}"))),
    }
}

/// Read stdin to end of file, answering as we go. Returns a process exit code.
pub fn serve() -> i32 {
    let stdin = std::io::stdin();
    let mut stdout = std::io::stdout();

    for line in stdin.lock().lines() {
        let line = match line {
            Ok(l) => l,
            // The client went away mid-line. Nothing to report to, and nothing
            // left to do.
            Err(_) => return 0,
        };
        if line.trim().is_empty() {
            continue;
        }

        let reply = match serde_json::from_str::<Value>(&line) {
            Ok(msg) => respond(&msg),
            // The id is unknown, because the thing carrying it did not parse.
            // Null is what JSON-RPC says to use, and it beats silence: the
            // client at least learns the stream is alive and its message was
            // the problem.
            Err(e) => Some(fail(Value::Null, -32700, &format!("that was not JSON: {e}"))),
        };

        if let Some(reply) = reply {
            // One line, then flushed. Without the flush the client waits on a
            // buffer that only empties at exit, which presents as a server that
            // accepts everything and answers nothing.
            if writeln!(stdout, "{reply}").is_err() || stdout.flush().is_err() {
                return 0;
            }
        }
    }
    0
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ask(msg: Value) -> Value {
        respond(&msg).expect("a request with an id must be answered")
    }

    #[test]
    fn a_notification_is_answered_with_silence() {
        // No id, so no reply — the rule that keeps every client's startup log
        // clean of a spurious "method not found" for notifications/initialized.
        assert!(respond(&json!({ "jsonrpc": "2.0", "method": "notifications/initialized" })).is_none());
    }

    #[test]
    fn initialize_agrees_on_a_version_the_client_speaks() {
        let r = ask(json!({
            "jsonrpc": "2.0", "id": 1, "method": "initialize",
            "params": { "protocolVersion": "2024-11-05" }
        }));
        assert_eq!(r["result"]["protocolVersion"], "2024-11-05");
        assert_eq!(r["result"]["serverInfo"]["name"], "facet");
    }

    #[test]
    fn an_unknown_version_gets_the_newest_one_rather_than_a_refusal() {
        let r = ask(json!({
            "jsonrpc": "2.0", "id": 1, "method": "initialize",
            "params": { "protocolVersion": "1999-01-01" }
        }));
        assert_eq!(r["result"]["protocolVersion"], LATEST);
    }

    #[test]
    fn every_tool_has_a_description_and_a_schema() {
        // The catalogue is hand-written, which is the point; this is the check
        // that a hand-written entry cannot go out half-finished.
        let tools = catalogue();
        let tools = tools.as_array().expect("an array");
        assert!(tools.len() >= 11);
        for t in tools {
            let name = t["name"].as_str().expect("a name");
            assert!(name.starts_with("facet_"), "{name} is not namespaced");
            assert!(t["description"].as_str().is_some_and(|d| d.len() > 40), "{name} needs a real description");
            assert_eq!(t["inputSchema"]["type"], "object", "{name} needs an object schema");
            // Anything a tool requires has to be described, or the model is
            // guessing at the field it is obliged to send.
            if let Some(req) = t["inputSchema"]["required"].as_array() {
                for field in req {
                    let field = field.as_str().expect("a field name");
                    assert!(
                        !t["inputSchema"]["properties"][field].is_null(),
                        "{name} requires {field} but never describes it"
                    );
                }
            }
        }
    }

    #[test]
    fn a_fully_specified_job_lands() {
        // Every field the facet_convert schema advertises, sent as the schema
        // describes it, and then checked for having *arrived*. Serde ignores
        // fields it does not know, so a name that is wrong in the schema — the
        // original `spans: [{from, to}]` against a struct that wanted
        // `{start, end}` — produces no error at all. It produces an export of
        // the whole file when the caller asked for two seconds of it, which is
        // the worst kind of wrong: a success.
        let sent = json!({
            "inputs": ["in.mp4"], "output": "out.mp4",
            "spans": [{ "start": 1.0, "end": 3.0 }],
            "crop": { "x": 1, "y": 2, "w": 3, "h": 4 },
            "rotate": 90, "flipH": true, "flipV": true,
            "speed": 0.5, "smooth": true,
            "scale": [320, 240], "mute": true,
            "fadeIn": 0.25, "fadeOut": 0.75,
            "quality": 18, "fps": 60.0, "precise": true,
        });
        let job: crate::ffmpeg::Job = serde_json::from_value(sent.clone()).expect("a valid job");

        assert_eq!(job.spans.len(), 1);
        assert_eq!(job.spans[0].start, 1.0);
        assert_eq!(job.spans[0].end, 3.0);
        let crop = job.crop.expect("crop");
        assert_eq!((crop.x, crop.y, crop.w, crop.h), (1, 2, 3, 4));
        assert_eq!(job.rotate, 90);
        assert!(job.flip_h && job.flip_v && job.mute && job.smooth && job.precise);
        assert_eq!(job.speed, 0.5);
        assert_eq!(job.scale, Some((320, 240)));
        assert_eq!(job.fade_in, 0.25);
        assert_eq!(job.fade_out, 0.75);
        assert_eq!(job.quality, 18);
        assert_eq!(job.fps, Some(60.0));

        // And the other direction: nothing is advertised that the job would
        // throw away, so a caller reading the schema is never told about a
        // knob that does nothing.
        let tools = catalogue();
        let convert = tools
            .as_array()
            .unwrap()
            .iter()
            .find(|t| t["name"] == "facet_convert")
            .expect("facet_convert");
        for field in convert["inputSchema"]["properties"].as_object().unwrap().keys() {
            assert!(
                sent.get(field).is_some(),
                "facet_convert advertises `{field}` but this test never proved it lands — \
                 add it to `sent` above and assert it arrived"
            );
        }
    }

    #[test]
    fn a_missing_file_is_a_tool_error_not_a_protocol_error() {
        // The distinction a model needs: this one it can recover from by
        // trying a better path, and it only learns that if the reply is a
        // result rather than an error.
        let r = ask(json!({
            "jsonrpc": "2.0", "id": 7, "method": "tools/call",
            "params": { "name": "facet_list_dir", "arguments": { "path": "Z:/no/such/place/at/all" } }
        }));
        assert!(r.get("error").is_none(), "must not be a JSON-RPC error");
        assert_eq!(r["result"]["isError"], true);
    }

    #[test]
    fn an_unknown_tool_says_so_by_name() {
        let r = ask(json!({
            "jsonrpc": "2.0", "id": 8, "method": "tools/call",
            "params": { "name": "facet_make_coffee", "arguments": {} }
        }));
        assert_eq!(r["result"]["isError"], true);
        assert!(r["result"]["content"][0]["text"].as_str().unwrap().contains("facet_make_coffee"));
    }

    #[test]
    fn a_missing_argument_names_the_argument() {
        let r = ask(json!({
            "jsonrpc": "2.0", "id": 9, "method": "tools/call",
            "params": { "name": "facet_probe", "arguments": {} }
        }));
        assert!(r["result"]["content"][0]["text"].as_str().unwrap().contains("`path`"));
    }

    #[test]
    fn recycling_nothing_is_refused_rather_than_quietly_succeeding() {
        let r = ask(json!({
            "jsonrpc": "2.0", "id": 10, "method": "tools/call",
            "params": { "name": "facet_recycle", "arguments": { "paths": [] } }
        }));
        assert_eq!(r["result"]["isError"], true);
    }

    #[test]
    fn recycling_checks_the_whole_list_before_moving_anything() {
        // One bad path and nothing goes, so a caller never has to work out
        // which half of its list went to the bin.
        let r = ask(json!({
            "jsonrpc": "2.0", "id": 11, "method": "tools/call",
            "params": { "name": "facet_recycle", "arguments": { "paths": ["Z:/nope.txt"] } }
        }));
        assert_eq!(r["result"]["isError"], true);
        assert!(r["result"]["content"][0]["text"].as_str().unwrap().contains("nothing was recycled"));
    }

    #[test]
    fn an_unknown_method_is_refused_rather_than_ignored() {
        let r = ask(json!({ "jsonrpc": "2.0", "id": 12, "method": "resources/list" }));
        assert_eq!(r["error"]["code"], -32601);
    }

    #[test]
    fn base64_matches_the_worked_examples_from_the_rfc() {
        assert_eq!(base64(b""), "");
        assert_eq!(base64(b"f"), "Zg==");
        assert_eq!(base64(b"fo"), "Zm8=");
        assert_eq!(base64(b"foo"), "Zm9v");
        assert_eq!(base64(b"foob"), "Zm9vYg==");
        assert_eq!(base64(b"fooba"), "Zm9vYmE=");
        assert_eq!(base64(b"foobar"), "Zm9vYmFy");
        // High bytes, because a JPEG is mostly those and an `as char` cast on
        // the wrong side of the table would still pass every ASCII case above.
        assert_eq!(base64(&[0xff, 0xff, 0xff]), "////");
        assert_eq!(base64(&[0x00, 0x00, 0x00]), "AAAA");
    }
}
