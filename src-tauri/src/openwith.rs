//! Files handed to FACET from outside it.
//!
//! On Android this is the fence in front of `OpenBridge.kt`: one command that
//! drains whatever "Open with FACET" / "Send to FACET" has queued since the
//! last ask, as absolute paths. The Kotlin side does the hard part -- turning a
//! `content://` URI into something on disk, copying the bytes in when it truly
//! is not on disk -- because that is entirely a platform question.
//!
//! Polling rather than an event, deliberately. An intent can land while the
//! WebView is still booting, or while it is in the background with no
//! listeners bound; a push would have to be buffered somewhere anyway, and the
//! queue in Kotlin is that buffer. The frontend asks at mount and on every
//! wake, which is exactly when an intent can have arrived.
//!
//! Everywhere else this answers an empty list. A desktop opens files with
//! command-line arguments and a single-instance plugin, which is a different
//! mechanism with different lifetimes, and pretending one command covers both
//! would mean a Windows build that quietly did nothing.

/// Paths handed to FACET since the last call. Empty is the normal answer.
#[tauri::command]
pub async fn open_pending() -> Result<Vec<String>, String> {
    Ok(platform_pending())
}

fn platform_pending() -> Vec<String> {
    #[cfg(target_os = "android")]
    {
        if let Some(raw) = droid::take() {
            return parse_paths(&raw);
        }
        Vec::new()
    }
    #[cfg(not(target_os = "android"))]
    {
        Vec::new()
    }
}

/// The JSON array Kotlin built, into the list the frontend reads.
///
/// Anything that is not a non-empty string is dropped rather than passed on:
/// the caller turns each of these into a file to open, and an empty path
/// resolves to the current directory, which would open the whole volume as if
/// the user had asked for it.
///
/// Only `platform_pending` calls this, and only on Android, so a desktop build
/// sees it as dead. The tests below run on every target, which is the point --
/// the parser is the part worth testing and it should not need a phone.
#[cfg_attr(not(target_os = "android"), allow(dead_code))]
fn parse_paths(raw: &str) -> Vec<String> {
    let v: serde_json::Value = match serde_json::from_str(raw) {
        Ok(v) => v,
        Err(_) => return Vec::new(),
    };
    let Some(arr) = v.as_array() else {
        return Vec::new();
    };
    arr.iter()
        .filter_map(|x| x.as_str())
        .filter(|s| !s.trim().is_empty())
        .map(str::to_owned)
        .collect()
}

#[cfg(target_os = "android")]
mod droid {
    //! JNI fence to `OpenBridge.kt`, the same shape as `media.rs::droid`: one
    //! dispatch onto the main thread to borrow the VM and the class, then every
    //! call attaches its own thread and calls a static.

    use jni::objects::{GlobalRef, JString, JValueOwned};
    use jni::JavaVM;
    use std::sync::{mpsc, OnceLock};
    use std::time::Duration;
    use wry::prelude::{dispatch, find_class};

    struct Bridge {
        vm: JavaVM,
        cls: GlobalRef,
    }

    static BRIDGE: OnceLock<Option<Bridge>> = OnceLock::new();

    fn bridge() -> Option<&'static Bridge> {
        BRIDGE
            .get_or_init(|| {
                let (tx, rx) = mpsc::channel::<Option<Bridge>>();
                dispatch(move |env, activity, _webview| {
                    let got = (|| -> Option<Bridge> {
                        let vm = env.get_java_vm().ok()?;
                        let cls =
                            find_class(env, activity, "com/iraslabs/facet/OpenBridge".into()).ok()?;
                        let cls = env.new_global_ref(&cls).ok()?;
                        Some(Bridge { vm, cls })
                    })();
                    if got.is_none() {
                        let _ = env.exception_describe();
                        let _ = env.exception_clear();
                        eprintln!("[FACET] open bridge: OpenBridge class not reachable");
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

    pub fn take() -> Option<String> {
        let b = bridge()?;
        let mut env = b.vm.attach_current_thread().ok()?;
        let result = env.call_static_method(&b.cls, "take", "()Ljava/lang/String;", &[]);
        take_string(&mut env, result)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_the_paths_kotlin_queued() {
        assert_eq!(
            parse_paths(r#"["/storage/emulated/0/DCIM/a.jpg","/storage/emulated/0/x.pdf"]"#),
            vec![
                "/storage/emulated/0/DCIM/a.jpg".to_string(),
                "/storage/emulated/0/x.pdf".to_string()
            ]
        );
    }

    #[test]
    fn survives_garbage() {
        assert!(parse_paths("not json").is_empty());
        assert!(parse_paths("{}").is_empty());
        assert!(parse_paths("[]").is_empty());
    }

    #[test]
    fn drops_entries_that_are_not_openable_paths() {
        // An empty string would resolve to the current directory, and a number
        // is not a path at all; neither may reach a caller that is about to
        // open whatever it is handed.
        assert_eq!(
            parse_paths(r#"["", "   ", 7, null, {"p":"/a"}, "/storage/emulated/0/ok.png"]"#),
            vec!["/storage/emulated/0/ok.png".to_string()]
        );
    }

    #[test]
    fn a_desktop_has_nothing_pending() {
        assert!(platform_pending().is_empty());
    }
}
