//! The phone's media index, as the frontend sees it.
//!
//! On Android this is a thin fence in front of `MediaBridge.kt`: one command
//! pages through MediaStore.Files (every indexed row, newest first) and one
//! reads the change counter its ContentObserver keeps. Both hand back the JSON
//! string Kotlin built, untouched -- the frontend already has to parse the
//! rows, and re-encoding a 5k-row page here would only cost time.
//!
//! Everywhere else both commands answer `None`: there is no system index worth
//! binding, and the caller falls back to the filesystem walk in `fsx.rs`.

use serde::Serialize;

/// One page of MediaStore rows plus the cursor for the next, or `None` when
/// this platform has no index to page through.
#[tauri::command]
pub async fn media_query(before_id: i64, limit: u32) -> Result<Option<String>, String> {
    tauri::async_runtime::spawn_blocking(move || platform_query(before_id, limit))
        .await
        .map_err(|e| e.to_string())
}

#[derive(Serialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MediaPulse {
    /// Monotonic; changes every time the observer fires. 0 means unsupported.
    pub gen: i64,
    /// How many change notices arrived since the last pulse (capped).
    pub changed: u32,
}

/// The change counter, cheap enough to poll once a second.
#[tauri::command]
pub async fn media_generation() -> Result<MediaPulse, String> {
    Ok(platform_pulse())
}

/// Tell the platform's media index about paths FACET just wrote, moved or
/// removed, so the phone's own gallery shows an edited copy the moment it is
/// saved rather than after the next full scan (which can be days away).
///
/// Every command that changes a file on disk calls `scan` itself, so the
/// frontend rarely needs this; it is exposed for the cases where the write
/// happened somewhere Rust cannot see (a recorder that appends chunks and only
/// knows the final size at stop). No-op off Android.
#[tauri::command]
pub fn media_scan(paths: Vec<String>) -> Result<(), String> {
    scan(&paths);
    Ok(())
}

/// Fire-and-forget: hand the paths to the indexer on a helper thread so the
/// caller (a file write on the IPC thread) never waits for JNI.
pub fn scan(paths: &[String]) {
    #[cfg(target_os = "android")]
    {
        let owned: Vec<String> = paths.iter().filter(|p| !p.is_empty()).cloned().collect();
        if owned.is_empty() {
            return;
        }
        std::thread::spawn(move || {
            let json = serde_json::to_string(&owned).unwrap_or_else(|_| "[]".into());
            droid::scan(&json);
        });
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = paths;
    }
}

fn platform_query(before_id: i64, limit: u32) -> Option<String> {
    #[cfg(target_os = "android")]
    {
        return droid::query(before_id, limit.min(5000) as i32);
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = (before_id, limit);
        None
    }
}

fn platform_pulse() -> MediaPulse {
    #[cfg(target_os = "android")]
    {
        if let Some(raw) = droid::pulse() {
            return parse_pulse(&raw);
        }
    }
    MediaPulse { gen: 0, changed: 0 }
}

/// `{"gen":N,"changed":[...]}` from Kotlin into the struct the frontend reads.
///
/// Only `platform_pulse` calls this, and only under `cfg(target_os =
/// "android")` — there is no Kotlin side on the desktop — so a desktop
/// `cargo check` sees it as dead. The tests below do exercise it on every
/// target, which is the point: the parser is the part worth testing and it
/// should not need an Android device to run.
#[cfg_attr(not(target_os = "android"), allow(dead_code))]
fn parse_pulse(raw: &str) -> MediaPulse {
    let v: serde_json::Value = match serde_json::from_str(raw) {
        Ok(v) => v,
        Err(_) => return MediaPulse { gen: 0, changed: 0 },
    };
    let gen = v.get("gen").and_then(|g| g.as_i64()).unwrap_or(0);
    let changed = v
        .get("changed")
        .and_then(|c| c.as_array())
        .map(|a| a.len() as u32)
        .unwrap_or(0);
    MediaPulse { gen, changed }
}

#[cfg(target_os = "android")]
mod droid {
    //! JNI fence to `MediaBridge.kt`, same shape as `thumbs.rs::droid`: one
    //! dispatch onto the main thread to borrow the VM, the activity and the
    //! class, then every call attaches its own thread and calls a static.

    use std::sync::{mpsc, OnceLock};
    use std::time::Duration;
    use wry::prelude::{dispatch, find_class};
    use jni::objects::{GlobalRef, JString, JValue, JValueOwned};
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
                        let cls = find_class(env, activity, "com/iraslabs/facet/MediaBridge".into()).ok()?;
                        let cls = env.new_global_ref(&cls).ok()?;
                        let ctx = env.new_global_ref(activity).ok()?;
                        Some(Bridge { vm, cls, ctx })
                    })();
                    if got.is_none() {
                        let _ = env.exception_describe();
                        let _ = env.exception_clear();
                        eprintln!("[FACET] media bridge: MediaBridge class not reachable");
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

    pub fn query(before_id: i64, limit: i32) -> Option<String> {
        let b = bridge()?;
        let mut env = b.vm.attach_current_thread().ok()?;
        let result = env.call_static_method(
            &b.cls,
            "query",
            "(Landroid/content/Context;JI)Ljava/lang/String;",
            &[JValue::Object(b.ctx.as_obj()), JValue::Long(before_id), JValue::Int(limit)],
        );
        take_string(&mut *env, result)
    }

    pub fn pulse() -> Option<String> {
        let b = bridge()?;
        let mut env = b.vm.attach_current_thread().ok()?;
        let result = env.call_static_method(&b.cls, "pulse", "()Ljava/lang/String;", &[]);
        take_string(&mut *env, result)
    }

    pub fn scan(json: &str) {
        let Some(b) = bridge() else { return };
        let Ok(mut env) = b.vm.attach_current_thread() else { return };
        let Ok(js) = env.new_string(json) else { return };
        let r = env.call_static_method(
            &b.cls,
            "scan",
            "(Landroid/content/Context;Ljava/lang/String;)V",
            &[JValue::Object(b.ctx.as_obj()), JValue::Object(&js)],
        );
        if r.is_err() {
            let _ = env.exception_describe();
            let _ = env.exception_clear();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pulse_parses_counter_and_change_count() {
        let p = parse_pulse(r#"{"gen":42,"changed":["content://media/external/file/9","content://media/external/images/media/10"]}"#);
        assert_eq!(p, MediaPulse { gen: 42, changed: 2 });
    }

    #[test]
    fn pulse_survives_garbage() {
        assert_eq!(parse_pulse("not json"), MediaPulse { gen: 0, changed: 0 });
        assert_eq!(parse_pulse("{}"), MediaPulse { gen: 0, changed: 0 });
    }

    #[test]
    fn scan_is_a_no_op_off_android() {
        scan(&["C:/nowhere/x.jpg".to_string()]);
        media_scan(vec![]).unwrap();
    }

    #[test]
    fn desktop_has_no_index() {
        assert_eq!(platform_query(0, 500), None);
        assert_eq!(platform_pulse().gen, 0);
    }
}
