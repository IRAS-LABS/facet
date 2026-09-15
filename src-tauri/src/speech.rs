//! The phone's own voices, for read-aloud.
//!
//! The fence in front of `SpeechBridge.kt`. It exists because Android's WebView
//! does not implement the Web Speech API's synthesis side: `speechSynthesis` is
//! present, `getVoices()` is empty forever and `speak()` is silent. The reader's
//! system-voice engine therefore finds nothing on the one platform whose
//! built-in voices are actually good, and this is the way back to them.
//!
//! Four commands, and a thread.
//!
//! `speech_voices` and `speech_speak` are ordinary request/response. Progress
//! is not: the word highlight needs a character offset several times a second
//! for as long as a sentence lasts, and asking for it from the frontend would
//! be thirty IPC round trips a second for the length of a forty-minute paper.
//! So a speak spawns one short-lived thread that drains Kotlin's queue and
//! re-emits it as a `speech` Tauri event, and that thread ends with the
//! utterance. Nothing polls while nothing is speaking.
//!
//! On every other platform these commands answer "no engine here" and the
//! frontend uses the browser's own synthesiser, which works properly there.

use serde::Serialize;

/// One thing that happened to an utterance, on its way to the reader.
#[derive(Clone, Serialize)]
pub struct SpeechEvent {
    /// The utterance id `speech_speak` returned.
    pub id: String,
    /// "start", "word", "end", "error" or "stop".
    pub kind: String,
    /// Character offsets into the utterance's text. Only on "word".
    pub from: i64,
    pub to: i64,
}

/// The voices this device can speak with, as the JSON Kotlin built.
///
/// `{"state":2,"voices":[{id,name,lang,network,quality}, ...]}`. State 1 means
/// the engine is still binding and the caller should ask again shortly; -1
/// means it refused and there is nothing here to use.
#[tauri::command]
pub async fn speech_voices() -> Result<String, String> {
    #[cfg(target_os = "android")]
    {
        Ok(droid::voices().unwrap_or_else(|| r#"{"state":-1,"voices":[]}"#.to_string()))
    }
    #[cfg(not(target_os = "android"))]
    {
        // Not an error: the browser engine is the right one everywhere else,
        // and an error here would put a failure notice on a screen where
        // nothing has failed.
        Ok(r#"{"state":0,"voices":[]}"#.to_string())
    }
}

/// Speak. Returns the utterance id, or an empty string when nothing was said.
#[tauri::command]
pub async fn speech_speak(
    #[allow(unused_variables)] app: tauri::AppHandle,
    #[allow(unused_variables)] text: String,
    #[allow(unused_variables)] voice: String,
    #[allow(unused_variables)] rate: f32,
    #[allow(unused_variables)] pitch: f32,
    #[allow(unused_variables)] volume: f32,
) -> Result<String, String> {
    #[cfg(target_os = "android")]
    {
        let id = droid::speak(&text, &voice, rate, pitch, volume).unwrap_or_default();
        if !id.is_empty() {
            droid::watch(app, id.clone());
        }
        Ok(id)
    }
    #[cfg(not(target_os = "android"))]
    {
        Ok(String::new())
    }
}

/// Stop whatever is speaking. Safe when nothing is.
#[tauri::command]
pub async fn speech_stop() -> Result<(), String> {
    #[cfg(target_os = "android")]
    {
        droid::stop();
    }
    Ok(())
}

/// Parse Kotlin's event array into the events the frontend is emitted.
///
/// Anything unparseable is dropped rather than passed on: these drive a
/// highlight, and a malformed offset would move it somewhere the text is not.
/// Only Android calls this, so a desktop build sees it as dead — but the tests
/// below run everywhere, which is the point, since the parser is the part worth
/// testing and it should not need a phone.
#[cfg_attr(not(target_os = "android"), allow(dead_code))]
fn parse_events(raw: &str) -> Vec<SpeechEvent> {
    let v: serde_json::Value = match serde_json::from_str(raw) {
        Ok(v) => v,
        Err(_) => return Vec::new(),
    };
    let Some(arr) = v.as_array() else {
        return Vec::new();
    };
    arr.iter()
        .filter_map(|e| {
            let id = e.get("id")?.as_str()?.to_owned();
            let kind = e.get("type")?.as_str()?.to_owned();
            if id.is_empty() || kind.is_empty() {
                return None;
            }
            let from = e.get("from").and_then(serde_json::Value::as_i64).unwrap_or(-1);
            let to = e.get("to").and_then(serde_json::Value::as_i64).unwrap_or(-1);
            // A word event with no range cannot move a highlight anywhere.
            if kind == "word" && (from < 0 || to < from) {
                return None;
            }
            Some(SpeechEvent { id, kind, from, to })
        })
        .collect()
}

/// Does this event mean the utterance is over, so the watcher can stop?
#[cfg_attr(not(target_os = "android"), allow(dead_code))]
fn is_last(kind: &str) -> bool {
    matches!(kind, "end" | "error" | "stop")
}

#[cfg(target_os = "android")]
mod droid {
    //! JNI fence to `SpeechBridge.kt`, the same shape as `openwith.rs::droid`:
    //! one dispatch onto the main thread to borrow the VM, the class and the
    //! activity, then every call attaches its own thread and calls a static.

    use super::{is_last, parse_events};
    use jni::objects::{GlobalRef, JString, JValue, JValueOwned};
    use jni::JavaVM;
    use std::sync::{mpsc, OnceLock};
    use std::time::{Duration, Instant};
    use tauri::Emitter;
    use wry::prelude::{dispatch, find_class};

    struct Bridge {
        vm: JavaVM,
        cls: GlobalRef,
        /// The activity, which is the Context the TTS engine binds against.
        ctx: GlobalRef,
    }

    static BRIDGE: OnceLock<Option<Bridge>> = OnceLock::new();

    /// How often the watcher asks Kotlin what has happened.
    ///
    /// 25 ms is under one frame, so the word highlight is never late by
    /// something a person can see, and the thread only exists while a sentence
    /// is actually being spoken.
    const TICK: Duration = Duration::from_millis(25);

    /// Give up on an utterance that never reports anything at all.
    ///
    /// An engine that dies mid-sentence delivers no `onDone`, and without this
    /// the thread would poll until the process ended.
    const SILENCE_CAP: Duration = Duration::from_secs(120);

    fn bridge() -> Option<&'static Bridge> {
        BRIDGE
            .get_or_init(|| {
                let (tx, rx) = mpsc::channel::<Option<Bridge>>();
                dispatch(move |env, activity, _webview| {
                    let got = (|| -> Option<Bridge> {
                        let vm = env.get_java_vm().ok()?;
                        let cls =
                            find_class(env, activity, "com/iraslabs/facet/SpeechBridge".into())
                                .ok()?;
                        let cls = env.new_global_ref(&cls).ok()?;
                        let ctx = env.new_global_ref(activity).ok()?;
                        Some(Bridge { vm, cls, ctx })
                    })();
                    if got.is_none() {
                        let _ = env.exception_describe();
                        let _ = env.exception_clear();
                        eprintln!("[FACET] speech bridge: SpeechBridge class not reachable");
                    }
                    let _ = tx.send(got);
                });
                rx.recv_timeout(Duration::from_secs(8)).ok().flatten()
            })
            .as_ref()
    }

    fn take_string<'l>(
        env: &mut jni::JNIEnv<'l>,
        result: jni::errors::Result<JValueOwned<'l>>,
    ) -> Option<String> {
        let obj = match result.and_then(|v| v.l()) {
            Ok(o) => o,
            Err(_) => {
                let _ = env.exception_describe();
                let _ = env.exception_clear();
                return None;
            }
        };
        if obj.is_null() {
            return None;
        }
        let js = JString::from(obj);
        let s: String = env.get_string(&js).ok()?.into();
        Some(s)
    }

    pub fn voices() -> Option<String> {
        let b = bridge()?;
        let mut env = b.vm.attach_current_thread().ok()?;
        let ctx = b.ctx.as_obj();
        let result = env.call_static_method(
            &b.cls,
            "voices",
            "(Landroid/content/Context;)Ljava/lang/String;",
            &[JValue::Object(ctx)],
        );
        take_string(&mut env, result)
    }

    pub fn speak(text: &str, voice: &str, rate: f32, pitch: f32, volume: f32) -> Option<String> {
        let b = bridge()?;
        let mut env = b.vm.attach_current_thread().ok()?;
        let jtext = env.new_string(text).ok()?;
        let jvoice = env.new_string(voice).ok()?;
        let ctx = b.ctx.as_obj();
        let result = env.call_static_method(
            &b.cls,
            "speak",
            "(Landroid/content/Context;Ljava/lang/String;Ljava/lang/String;FFF)Ljava/lang/String;",
            &[
                JValue::Object(ctx),
                JValue::Object(&jtext),
                JValue::Object(&jvoice),
                JValue::Float(rate),
                JValue::Float(pitch),
                JValue::Float(volume),
            ],
        );
        take_string(&mut env, result)
    }

    pub fn stop() {
        let Some(b) = bridge() else { return };
        let Ok(mut env) = b.vm.attach_current_thread() else {
            return;
        };
        if env.call_static_method(&b.cls, "stop", "()V", &[]).is_err() {
            let _ = env.exception_describe();
            let _ = env.exception_clear();
        }
    }

    fn drain() -> Option<String> {
        let b = bridge()?;
        let mut env = b.vm.attach_current_thread().ok()?;
        let result = env.call_static_method(&b.cls, "drain", "()Ljava/lang/String;", &[]);
        take_string(&mut env, result)
    }

    /// Follow one utterance to its end, emitting what happens to it.
    ///
    /// One thread per sentence, living about as long as the sentence does. It
    /// stops on the first terminal event for *its own* id -- events for a
    /// superseded utterance are already filtered out in Kotlin, so seeing
    /// somebody else's id here means this thread is the stale one and should
    /// go.
    pub fn watch(app: tauri::AppHandle, id: String) {
        std::thread::spawn(move || {
            let start = Instant::now();
            loop {
                if start.elapsed() > SILENCE_CAP {
                    // Report it rather than vanishing: the player is waiting
                    // for an end that is never coming, and a reader that
                    // silently stops mid-paper is the worst of the options.
                    let _ = app.emit(
                        "speech",
                        super::SpeechEvent {
                            id: id.clone(),
                            kind: "error".into(),
                            from: -1,
                            to: -1,
                        },
                    );
                    return;
                }
                if let Some(raw) = drain() {
                    for e in parse_events(&raw) {
                        if e.id != id {
                            return;
                        }
                        let last = is_last(&e.kind);
                        let _ = app.emit("speech", e);
                        if last {
                            return;
                        }
                    }
                }
                std::thread::sleep(TICK);
            }
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_what_kotlin_queued() {
        let got = parse_events(
            r#"[{"id":"u1","type":"start"},{"id":"u1","type":"word","from":4,"to":9},{"id":"u1","type":"end"}]"#,
        );
        assert_eq!(got.len(), 3);
        assert_eq!(got[0].kind, "start");
        assert_eq!(got[1].from, 4);
        assert_eq!(got[1].to, 9);
        assert_eq!(got[2].kind, "end");
    }

    #[test]
    fn survives_garbage() {
        assert!(parse_events("not json").is_empty());
        assert!(parse_events("{}").is_empty());
        assert!(parse_events("[]").is_empty());
        assert!(parse_events(r#"[7, null, "x", {"id":""}, {"type":"end"}]"#).is_empty());
    }

    #[test]
    fn drops_a_word_that_cannot_move_a_highlight() {
        // No range at all, and a backwards one. Either would move the
        // highlight somewhere the text is not.
        let got = parse_events(
            r#"[{"id":"u1","type":"word"},{"id":"u1","type":"word","from":9,"to":4},{"id":"u1","type":"word","from":0,"to":3}]"#,
        );
        assert_eq!(got.len(), 1);
        assert_eq!(got[0].from, 0);
    }

    #[test]
    fn knows_when_an_utterance_is_over() {
        assert!(is_last("end"));
        assert!(is_last("error"));
        assert!(is_last("stop"));
        assert!(!is_last("start"));
        assert!(!is_last("word"));
    }
}
