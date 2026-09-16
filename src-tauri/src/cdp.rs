//! Talking to a window that is already open.
//!
//! The MCP server FACET ships is the same binary answering questions about
//! files. It could describe a video frame and it could not see its own app,
//! which made "test the thing you changed" mean "ask a person to look" — so
//! every UI bug shipped twice: once when it was written and once when it was
//! not noticed.
//!
//! Both of FACET's windows are web views, and a web view will let something
//! outside the process drive it over the Chrome DevTools Protocol: read the
//! DOM, take a picture, send a real mouse-down at a real coordinate. That is
//! the same protocol on WebView2 on Windows and on the Android System WebView
//! at the other end of `adb forward`, which is why this is the route rather
//! than a Windows-only screen grab plus synthetic clicks.
//!
//! CDP is JSON over a WebSocket, and this file is a WebSocket client in about
//! two hundred lines instead of a dependency. It is allowed to be that small
//! because of what it never has to do: the connection is to 127.0.0.1, so
//! there is no TLS; it speaks to one peer, so there is no negotiation; and it
//! asks a question and reads the answer, so there is no concurrency.
//!
//! **The port is off unless it is asked for.** A debugging port is a hole
//! straight into the window — anything that can reach it can read what is on
//! screen and run script in the page — so FACET only opens one when
//! `FACET_UI_PORT` is set in its environment, which is something this file's
//! `launch` does deliberately and a normal double-click never does. It is
//! bound to loopback by the web view itself; it is not reachable from the
//! network.

use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpStream, ToSocketAddrs};
use std::time::{Duration, Instant, SystemTime};

use serde_json::{json, Value};

/// How long any single read is allowed to sit there saying nothing.
const IO_TIMEOUT: Duration = Duration::from_secs(30);

/// One debuggable page, as `/json/list` describes it.
pub struct Target {
    pub id: String,
    pub title: String,
    pub url: String,
    pub ws: String,
}

fn addr(port: u16) -> String {
    format!("127.0.0.1:{port}")
}

fn connect(port: u16) -> Result<TcpStream, String> {
    let sock = addr(port)
        .to_socket_addrs()
        .map_err(|e| e.to_string())?
        .next()
        .ok_or("127.0.0.1 does not resolve, which should not be possible")?;
    // A short connect timeout on purpose: "nothing is listening" is the common
    // answer and it should come back in a moment, not in a minute.
    let s = TcpStream::connect_timeout(&sock, Duration::from_secs(2))
        .map_err(|_| format!("nothing is listening on 127.0.0.1:{port} — is FACET running with FACET_UI_PORT set? (facet_ui_open starts it)"))?;
    s.set_read_timeout(Some(IO_TIMEOUT)).ok();
    s.set_write_timeout(Some(IO_TIMEOUT)).ok();
    s.set_nodelay(true).ok();
    Ok(s)
}

/// A plain HTTP GET, because the only server being asked is the debugger's own
/// and the only thing it returns is a few kilobytes of JSON.
///
/// Read to the length it declares, not to end of stream. The debugger keeps
/// the socket open whatever `Connection: close` asks for, so reading until EOF
/// means reading until the timeout — the answer arrives in a millisecond and
/// then the call sits there for half a minute before failing.
fn http_get(port: u16, path: &str) -> Result<String, String> {
    let s = connect(port)?;
    let mut sock = &s;
    let req = format!("GET {path} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nConnection: close\r\n\r\n");
    sock.write_all(req.as_bytes()).map_err(|e| e.to_string())?;
    let mut r = BufReader::new(sock);
    let mut status = String::new();
    r.read_line(&mut status).map_err(|e| e.to_string())?;
    if !status.starts_with("HTTP/") {
        return Err("the debugger answered something that is not HTTP".into());
    }
    let mut length: Option<usize> = None;
    loop {
        let mut line = String::new();
        if r.read_line(&mut line).map_err(|e| e.to_string())? == 0 || line == "\r\n" {
            break;
        }
        if let Some((k, v)) = line.split_once(':') {
            if k.eq_ignore_ascii_case("content-length") {
                length = v.trim().parse().ok();
            }
        }
    }
    let mut body = Vec::new();
    match length {
        Some(n) => {
            body.resize(n, 0);
            r.read_exact(&mut body).map_err(|e| e.to_string())?;
        }
        None => {
            r.read_to_end(&mut body).map_err(|e| e.to_string())?;
        }
    }
    Ok(String::from_utf8_lossy(&body).into_owned())
}

/// Every page the web view is willing to be driven through.
pub fn targets(port: u16) -> Result<Vec<Target>, String> {
    let body = http_get(port, "/json/list")?;
    let list: Value = serde_json::from_str(body.trim()).map_err(|e| format!("unreadable target list: {e}"))?;
    let mut out = Vec::new();
    for t in list.as_array().unwrap_or(&Vec::new()) {
        let ws = t.get("webSocketDebuggerUrl").and_then(Value::as_str).unwrap_or("");
        if ws.is_empty() {
            continue;
        }
        out.push(Target {
            id: t.get("id").and_then(Value::as_str).unwrap_or("").to_owned(),
            title: t.get("title").and_then(Value::as_str).unwrap_or("").to_owned(),
            url: t.get("url").and_then(Value::as_str).unwrap_or("").to_owned(),
            ws: ws.to_owned(),
        });
    }
    Ok(out)
}

/// Pick the page to drive: the one asked for by id, else the first that looks
/// like FACET's own window rather than a devtools page or a blank tab.
pub fn pick(port: u16, want: Option<&str>) -> Result<Target, String> {
    let all = targets(port)?;
    if let Some(id) = want {
        return all
            .into_iter()
            .find(|t| t.id == id || t.url.contains(id) || t.title.contains(id))
            .ok_or_else(|| format!("no page here matching `{id}` — facet_ui_targets lists them"));
    }
    let mut pages: Vec<Target> = all
        .into_iter()
        .filter(|t| !t.url.starts_with("devtools://") && t.url != "about:blank")
        .collect();
    if pages.is_empty() {
        return Err("the debugger is listening but has no page open".into());
    }
    // The explorer is the window a caller means by "the app"; pop-outs are
    // extra. Nothing marks it in the protocol, so it is recognised by being
    // the one that is not a pop-out route.
    let main = pages.iter().position(|t| !t.url.contains("pip")).unwrap_or(0);
    Ok(pages.swap_remove(main))
}

// ------------------------------------------------------------- websocket

/// A key the server hashes back at us. It has to differ between connections;
/// it does not have to be unguessable, and on loopback there is nobody to
/// guess it. The clock is enough.
fn nonce() -> String {
    let n = SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(1);
    let mut bytes = [0u8; 16];
    for (i, b) in bytes.iter_mut().enumerate() {
        *b = ((n >> (i * 5)) & 0xff) as u8;
    }
    crate::mcp::base64(&bytes)
}

/// One open conversation with one page.
pub struct Session {
    stream: BufReader<TcpStream>,
    next_id: u64,
}

/// The readable half of a CDP `exceptionDetails`.
fn fault(ex: &Value) -> String {
    ex.get("exception")
        .and_then(|e| e.get("description"))
        .and_then(Value::as_str)
        .or_else(|| ex.get("text").and_then(Value::as_str))
        .unwrap_or("the page threw")
        .to_owned()
}

impl Session {
    pub fn open(ws_url: &str, port: u16) -> Result<Session, String> {
        let path = ws_url
            .find("://")
            .and_then(|i| ws_url[i + 3..].find('/').map(|j| &ws_url[i + 3 + j..]))
            .ok_or("that is not a websocket url")?;
        let mut s = connect(port)?;
        let req = format!(
            "GET {path} HTTP/1.1\r\n\
             Host: 127.0.0.1:{port}\r\n\
             Upgrade: websocket\r\n\
             Connection: Upgrade\r\n\
             Sec-WebSocket-Key: {}\r\n\
             Sec-WebSocket-Version: 13\r\n\r\n",
            nonce()
        );
        s.write_all(req.as_bytes()).map_err(|e| e.to_string())?;

        // Read the handshake through a buffered reader and then keep it: the
        // first frame can arrive in the same packet as the last header, and a
        // fresh reader would have thrown those bytes away.
        let mut r = BufReader::new(s);
        let mut status = String::new();
        r.read_line(&mut status).map_err(|e| e.to_string())?;
        if !status.contains(" 101") {
            return Err(format!("the page refused the connection: {}", status.trim()));
        }
        loop {
            let mut line = String::new();
            let n = r.read_line(&mut line).map_err(|e| e.to_string())?;
            if n == 0 || line == "\r\n" {
                break;
            }
        }
        Ok(Session { stream: r, next_id: 1 })
    }

    fn write_frame(&mut self, payload: &[u8]) -> Result<(), String> {
        let mut head: Vec<u8> = vec![0x81]; // FIN + text
        let n = payload.len();
        // Client frames are masked, always, even on loopback — an unmasked one
        // is a protocol error and the page closes the socket on it.
        if n < 126 {
            head.push(0x80 | n as u8);
        } else if n <= u16::MAX as usize {
            head.push(0x80 | 126);
            head.extend_from_slice(&(n as u16).to_be_bytes());
        } else {
            head.push(0x80 | 127);
            head.extend_from_slice(&(n as u64).to_be_bytes());
        }
        let mask = nonce().as_bytes()[..4].to_vec();
        head.extend_from_slice(&mask);
        let mut body = payload.to_vec();
        for (i, b) in body.iter_mut().enumerate() {
            *b ^= mask[i % 4];
        }
        let sock = self.stream.get_mut();
        sock.write_all(&head).map_err(|e| e.to_string())?;
        sock.write_all(&body).map_err(|e| e.to_string())?;
        sock.flush().map_err(|e| e.to_string())
    }

    /// One whole message, joining continuation frames and answering pings.
    fn read_message(&mut self) -> Result<String, String> {
        let mut message: Vec<u8> = Vec::new();
        loop {
            let mut head = [0u8; 2];
            self.stream.read_exact(&mut head).map_err(|e| format!("the page stopped answering: {e}"))?;
            let fin = head[0] & 0x80 != 0;
            let opcode = head[0] & 0x0f;
            let mut len = (head[1] & 0x7f) as usize;
            if len == 126 {
                let mut b = [0u8; 2];
                self.stream.read_exact(&mut b).map_err(|e| e.to_string())?;
                len = u16::from_be_bytes(b) as usize;
            } else if len == 127 {
                let mut b = [0u8; 8];
                self.stream.read_exact(&mut b).map_err(|e| e.to_string())?;
                len = u64::from_be_bytes(b) as usize;
            }
            let mut body = vec![0u8; len];
            self.stream.read_exact(&mut body).map_err(|e| e.to_string())?;
            match opcode {
                0x8 => return Err("the page closed the connection".into()),
                0x9 => {
                    // Pong, or the page eventually gives up on us. Screenshots
                    // of a busy window take long enough for this to matter.
                    let mut pong: Vec<u8> = vec![0x8a, 0x80 | body.len() as u8];
                    let mask = nonce().as_bytes()[..4].to_vec();
                    pong.extend_from_slice(&mask);
                    for (i, b) in body.iter().enumerate() {
                        pong.push(b ^ mask[i % 4]);
                    }
                    let sock = self.stream.get_mut();
                    sock.write_all(&pong).and_then(|_| sock.flush()).map_err(|e| e.to_string())?;
                }
                0xa => {}
                _ => {
                    message.extend_from_slice(&body);
                    if fin {
                        return String::from_utf8(message).map_err(|e| e.to_string());
                    }
                }
            }
        }
    }

    /// Ask, then read past everything that is not the answer.
    ///
    /// A live page talks constantly — console output, network, frame events —
    /// and all of it arrives on this socket. Matching on the id is what keeps a
    /// screenshot from being answered with somebody's `console.log`.
    pub fn send(&mut self, method: &str, params: Value) -> Result<Value, String> {
        let id = self.next_id;
        self.next_id += 1;
        let msg = json!({ "id": id, "method": method, "params": params });
        self.write_frame(msg.to_string().as_bytes())?;
        let deadline = Instant::now() + IO_TIMEOUT;
        loop {
            if Instant::now() > deadline {
                return Err(format!("`{method}` never answered"));
            }
            let text = self.read_message()?;
            let v: Value = match serde_json::from_str(&text) {
                Ok(v) => v,
                Err(_) => continue,
            };
            if v.get("id").and_then(Value::as_u64) != Some(id) {
                continue;
            }
            if let Some(e) = v.get("error") {
                let why = e.get("message").and_then(Value::as_str).unwrap_or("refused");
                return Err(format!("{method}: {why}"));
            }
            return Ok(v.get("result").cloned().unwrap_or(Value::Null));
        }
    }

    /// Run an expression in the page and bring the value back.
    ///
    /// `returnByValue` on purpose: the alternative is a handle into the page's
    /// heap that has to be released, and nothing here wants to hold one. The
    /// cost is that the expression has to end in something JSON can carry,
    /// which every caller in `mcp.rs` does deliberately.
    pub fn eval(&mut self, js: &str) -> Result<Value, String> {
        let r = self.send(
            "Runtime.evaluate",
            json!({
                "expression": js,
                "returnByValue": true,
                "awaitPromise": true,
                "userGesture": true,
            }),
        )?;
        if let Some(ex) = r.get("exceptionDetails") {
            return Err(fault(ex));
        }
        let res = r.get("result").cloned().unwrap_or(Value::Null);
        // `awaitPromise` is honoured by Chrome but not by every WebView2 build,
        // and an unawaited promise serialises as `{}`, which reads as "the page
        // returned nothing" and is the most confusing possible answer. When one
        // comes back, wait for it by hand.
        if res.get("subtype").and_then(Value::as_str) == Some("promise") {
            if let Some(id) = res.get("objectId").and_then(Value::as_str) {
                let done = self.send("Runtime.awaitPromise", json!({ "promiseObjectId": id, "returnByValue": true }))?;
                if let Some(ex) = done.get("exceptionDetails") {
                    return Err(fault(ex));
                }
                return Ok(done.get("result").and_then(|r| r.get("value")).cloned().unwrap_or(Value::Null));
            }
        }
        Ok(res.get("value").cloned().unwrap_or(Value::Null))
    }
}
