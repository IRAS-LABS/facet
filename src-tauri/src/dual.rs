//! Both cameras at once, from the page.
//!
//! The work is all in `DualBridge.kt`: Camera2's concurrent mode, two preview
//! surfaces behind the WebView, a still from each combined into one picture,
//! and two recordings combined into one video. This file is the fence between
//! that and the frontend, in the same shape as `speech.rs` and `thumbs.rs` --
//! one dispatch onto the main thread to borrow the VM, the class and the
//! activity, then every call attaches its own thread and invokes a static.
//!
//! Nothing here exists on the desktop. A laptop can open two cameras through
//! `getUserMedia` like any other web page, so the whole native detour would be
//! solving a problem that platform does not have; the commands are present so
//! the frontend has one set of names to call, and answer that dual mode is not
//! available rather than failing to exist.

/// Whether this device can run both cameras together.
///
/// Answered by asking the camera service for its concurrent pairs, not by
/// checking for two lenses: every phone has a front and a back camera and most
/// of them will not stream both at once, so the lens count says nothing. A
/// false here is what hides the button.
#[tauri::command]
pub async fn dual_available() -> Result<bool, String> {
    #[cfg(target_os = "android")]
    {
        Ok(droid::available())
    }
    #[cfg(not(target_os = "android"))]
    {
        Ok(false)
    }
}

/// Open both cameras and show them.
///
/// The empty string means it worked; anything else is a sentence to put in
/// front of the person, because every way this fails is a way worth explaining
/// -- another app holding the camera, a permission not granted, a pair the
/// driver changed its mind about.
#[tauri::command]
pub async fn dual_start() -> Result<(), String> {
    #[cfg(target_os = "android")]
    {
        match droid::start() {
            Some(why) if why.is_empty() => Ok(()),
            Some(why) => Err(why),
            None => Err("Dual camera is not available on this device.".into()),
        }
    }
    #[cfg(not(target_os = "android"))]
    {
        Err("Dual camera is only available on Android.".into())
    }
}

#[tauri::command]
pub async fn dual_stop() -> Result<(), String> {
    #[cfg(target_os = "android")]
    {
        droid::stop();
    }
    Ok(())
}

/// Where each camera is drawn, in device pixels.
///
/// The spec is the page's own JSON -- `[{cam, x, y, w, h, z}, ...]` -- passed
/// through untouched, because the page is the only layer that knows its safe
/// areas, its controls and which rectangle a finger just landed in. Growing
/// one preview, splitting the screen in half and swapping the two are the same
/// call with different numbers.
#[tauri::command]
pub async fn dual_place(#[allow(unused_variables)] spec: String) -> Result<(), String> {
    #[cfg(target_os = "android")]
    {
        match droid::place(&spec) {
            Some(why) if why.is_empty() => Ok(()),
            Some(why) => Err(why),
            None => Err("Dual camera is not running.".into()),
        }
    }
    #[cfg(not(target_os = "android"))]
    {
        Err("Dual camera is only available on Android.".into())
    }
}

/// One photograph from each camera, combined, and where it was written.
#[tauri::command]
pub async fn dual_photo() -> Result<String, String> {
    #[cfg(target_os = "android")]
    {
        take(droid::photo())
    }
    #[cfg(not(target_os = "android"))]
    {
        Err("Dual camera is only available on Android.".into())
    }
}

#[tauri::command]
pub async fn dual_record_start() -> Result<(), String> {
    #[cfg(target_os = "android")]
    {
        match droid::record_start() {
            Some(why) if why.is_empty() => Ok(()),
            Some(why) => Err(why),
            None => Err("Dual camera is not running.".into()),
        }
    }
    #[cfg(not(target_os = "android"))]
    {
        Err("Dual camera is only available on Android.".into())
    }
}

/// Stop filming and combine the two clips. Slow on purpose, and the caller
/// should say so: there is no hardware video encoder to reach from here, so a
/// minute of dual footage is about two minutes of work afterwards.
#[tauri::command]
pub async fn dual_record_stop() -> Result<String, String> {
    #[cfg(target_os = "android")]
    {
        take(droid::record_stop())
    }
    #[cfg(not(target_os = "android"))]
    {
        Err("Dual camera is only available on Android.".into())
    }
}

#[tauri::command]
pub async fn dual_recording() -> Result<bool, String> {
    #[cfg(target_os = "android")]
    {
        Ok(droid::recording())
    }
    #[cfg(not(target_os = "android"))]
    {
        Ok(false)
    }
}

/// Kotlin's "a path, or a message beginning with !" convention, unpacked.
///
/// One return value for both outcomes keeps the JNI signature to a single
/// string, and the marker cannot be mistaken for a path: a filename may
/// contain anything except a leading slash here, and every path these return
/// begins with one.
#[cfg(target_os = "android")]
fn take(got: Option<String>) -> Result<String, String> {
    match got {
        None => Err("Dual camera is not available.".into()),
        Some(s) if s.starts_with('!') => Err(s[1..].to_string()),
        Some(s) if s.is_empty() => Err("Dual camera returned nothing.".into()),
        Some(s) => Ok(s),
    }
}

#[cfg(target_os = "android")]
mod droid {
    //! The JNI fence to `DualBridge.kt`.

    use jni::objects::{GlobalRef, JString, JValue, JValueOwned};
    use jni::JavaVM;
    use std::sync::{mpsc, OnceLock};
    use std::time::Duration;
    use wry::prelude::{dispatch, find_class};

    struct Bridge {
        vm: JavaVM,
        cls: GlobalRef,
        /// The activity, which is both the Context the camera service is asked
        /// through and the view tree the previews are added to.
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
                        let cls = find_class(env, activity, "com/iraslabs/facet/DualBridge".into())
                            .ok()?;
                        let cls = env.new_global_ref(&cls).ok()?;
                        let ctx = env.new_global_ref(activity).ok()?;
                        Some(Bridge { vm, cls, ctx })
                    })();
                    if got.is_none() {
                        let _ = env.exception_describe();
                        let _ = env.exception_clear();
                        eprintln!("[FACET] dual bridge: DualBridge class not reachable");
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
        let js = JString::from(obj);
        // Bound rather than returned straight out: the `JavaStr` borrows both
        // `env` and `js`, and as the last expression in the block it would be
        // dropped after the locals it borrows.
        let out = env.get_string(&js).ok().map(String::from);
        out
    }

    fn flag(name: &str) -> bool {
        let Some(b) = bridge() else { return false };
        let Ok(mut env) = b.vm.attach_current_thread() else {
            return false;
        };
        match env.call_static_method(&b.cls, name, "()Z", &[]).and_then(|v| v.z()) {
            Ok(v) => v,
            Err(_) => {
                let _ = env.exception_describe();
                let _ = env.exception_clear();
                false
            }
        }
    }

    fn word(name: &str) -> Option<String> {
        let b = bridge()?;
        let mut env = b.vm.attach_current_thread().ok()?;
        let result = env.call_static_method(&b.cls, name, "()Ljava/lang/String;", &[]);
        take_string(&mut env, result)
    }

    pub fn available() -> bool {
        let Some(b) = bridge() else { return false };
        let Ok(mut env) = b.vm.attach_current_thread() else {
            return false;
        };
        let result = env
            .call_static_method(
                &b.cls,
                "available",
                "(Landroid/content/Context;)Z",
                &[JValue::Object(b.ctx.as_obj())],
            )
            .and_then(|v| v.z());
        match result {
            Ok(v) => v,
            Err(_) => {
                let _ = env.exception_describe();
                let _ = env.exception_clear();
                false
            }
        }
    }

    pub fn start() -> Option<String> {
        word("start")
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

    pub fn place(spec: &str) -> Option<String> {
        let b = bridge()?;
        let mut env = b.vm.attach_current_thread().ok()?;
        let jspec = env.new_string(spec).ok()?;
        let result = env.call_static_method(
            &b.cls,
            "place",
            "(Ljava/lang/String;)Ljava/lang/String;",
            &[JValue::Object(&jspec)],
        );
        take_string(&mut env, result)
    }

    pub fn photo() -> Option<String> {
        word("photo")
    }

    pub fn record_start() -> Option<String> {
        word("startRecording")
    }

    pub fn record_stop() -> Option<String> {
        word("stopRecording")
    }

    pub fn recording() -> bool {
        flag("recording")
    }
}
