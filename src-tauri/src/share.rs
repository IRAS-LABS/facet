//! Getting files back out of FACET.
//!
//! Two doors, because "share this" turns out to be two different questions and
//! answering only one of them is what makes a share button disappointing:
//!
//!  - **The OS share sheet** (`share_files`) is the one people mean when they
//!    say share: Mail, Phone Link, nearby devices, whatever else has registered
//!    itself as a share target. It is the right answer for sending a photo to
//!    someone, and the wrong answer for almost everything else, because on
//!    Windows the target list is UWP-only and can be short or empty.
//!  - **The clipboard** (`copy_files`) is the one people actually use. Files on
//!    the clipboard as `CF_HDROP` paste into Explorer, Outlook, Discord, Slack,
//!    a chat box, a file dialog — anything that accepts a dropped file. This is
//!    not a lesser fallback for the share sheet; for most destinations it is the
//!    only thing that works at all.
//!
//! So both ship, side by side, and the share sheet failing is not an error the
//! user has to care about — the caller offers the clipboard next to it.
//!
//! The share sheet ships on Windows and Android (where it is the OS chooser
//! raised from the activity); the clipboard door is Windows-only, because
//! CF_HDROP is the only clipboard that means "these files". Elsewhere the
//! commands return an error saying so, which the UI shows rather than
//! pretending the click worked.

/// A short line for the share sheet's header. Not the file list — the sheet
/// shows that itself — just enough that the person on the other end of a mail
/// draft can tell what they were sent.
fn title_for(paths: &[String]) -> String {
    match paths.len() {
        0 => "Nothing".into(),
        1 => std::path::Path::new(&paths[0])
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_else(|| paths[0].clone()),
        n => format!("{n} items"),
    }
}

#[tauri::command]
pub fn share_files(window: tauri::Window, paths: Vec<String>) -> Result<(), String> {
    if paths.is_empty() {
        return Err("nothing selected".into());
    }
    #[cfg(windows)]
    {
        win::share(&window, paths)
    }
    #[cfg(target_os = "android")]
    {
        let _ = window;
        android::share(paths)
    }
    #[cfg(not(any(windows, target_os = "android")))]
    {
        let _ = window;
        Err("the share sheet is only wired up on Windows and Android so far".into())
    }
}

#[tauri::command]
pub fn copy_files(paths: Vec<String>) -> Result<(), String> {
    if paths.is_empty() {
        return Err("nothing selected".into());
    }
    #[cfg(windows)]
    {
        win::copy(&paths)
    }
    #[cfg(not(windows))]
    {
        Err("copying files to the clipboard is only wired up on Windows so far".into())
    }
}

#[cfg(target_os = "android")]
mod android {
    /// Hand the paths to `MainActivity.shareFiles`, which mints FileProvider
    /// URIs and raises the chooser. All the Android knowledge stays in Kotlin;
    /// this side only crosses the JNI fence.
    ///
    /// `dispatch` queues onto the activity's main thread and returns at once,
    /// so a failure over there cannot be reported here — the closure logs and
    /// clears instead, because a pending JNI exception left in place takes the
    /// whole app down on the next call into Java.
    pub fn share(paths: Vec<String>) -> Result<(), String> {
        wry::prelude::dispatch(move |env, activity, _webview| {
            let ok = (|| -> Option<()> {
                let cls = env.find_class("java/lang/String").ok()?;
                let first = env.new_string(paths.first()?).ok()?;
                let arr = env
                    .new_object_array(paths.len() as i32, cls, &first)
                    .ok()?;
                for (i, p) in paths.iter().enumerate().skip(1) {
                    let s = env.new_string(p).ok()?;
                    env.set_object_array_element(&arr, i as i32, &s).ok()?;
                }
                env.call_method(
                    activity,
                    "shareFiles",
                    "([Ljava/lang/String;)V",
                    &[(&arr).into()],
                )
                .ok()?;
                Some(())
            })();
            if ok.is_none() {
                let _ = env.exception_describe();
                let _ = env.exception_clear();
                eprintln!("[FACET] share_files: JNI call into shareFiles failed");
            }
        });
        Ok(())
    }
}

#[cfg(windows)]
mod win {
    use windows::core::{w, Interface, HSTRING};
    use windows::ApplicationModel::DataTransfer::{DataRequestedEventArgs, DataTransferManager};
    use windows::Foundation::TypedEventHandler;
    use windows::Storage::{IStorageItem, StorageFile, StorageFolder};
    use windows::Win32::Foundation::{GlobalFree, HANDLE, HGLOBAL, HWND, POINT};
    use windows::Win32::System::Com::CoIncrementMTAUsage;
    use windows::Win32::System::DataExchange::{
        CloseClipboard, EmptyClipboard, OpenClipboard, RegisterClipboardFormatW, SetClipboardData,
    };
    use windows::Win32::System::Memory::{GlobalAlloc, GlobalLock, GlobalUnlock, GMEM_MOVEABLE};
    use windows::Win32::UI::Shell::{IDataTransferManagerInterop, DROPFILES};

    /// `CF_HDROP`. Spelled out rather than imported because the constant lives
    /// behind a different feature of the bindings than the clipboard calls do.
    const CF_HDROP: u32 = 15;
    /// `DROPEFFECT_COPY`. Without this, Explorer decides for itself, and a paste
    /// that silently *moves* the user's photos is not a share, it is an accident.
    const DROPEFFECT_COPY: u32 = 1;

    fn err(e: windows::core::Error) -> String {
        e.message().to_string()
    }

    /// Carries a WinRT object across a thread boundary.
    ///
    /// The bindings mark almost nothing `Send`, because agility is a per-class
    /// fact they cannot see. `StorageFile` and `StorageFolder` are agile objects
    /// — the runtime marshals them between apartments itself, which is the whole
    /// reason file handles can be opened on a worker and used on the UI thread.
    /// This wrapper asserts exactly that and nothing more.
    ///
    /// The assertion is written for the one concrete type it is true of, not
    /// for `T`. A blanket `impl<T> Send` would make the wrapper a way to send
    /// anything at all, and the next person to reach for it would get no
    /// warning from the compiler that the class they wrapped is apartment-bound.
    struct Agile<T>(T);
    unsafe impl Send for Agile<Vec<IStorageItem>> {}

    impl<T> Agile<T> {
        /// Reached through a method, never through `.0`, and that is load-bearing.
        /// Rust 2021 closures capture the narrowest path they actually use, so a
        /// closure body mentioning `files.0` captures the inner `Vec` — which is
        /// not `Send` — and the wrapper silently stops doing its job. A method
        /// call forces the whole wrapper to be captured.
        fn get(&self) -> &T {
            &self.0
        }
    }

    /// Resolve paths into storage items, off the UI thread.
    ///
    /// Deliberately done before the sheet is asked for. The alternative is to
    /// open the files inside the `DataRequested` handler, which runs on the UI
    /// thread with a live message pump waiting on it — and blocking that pump on
    /// disk I/O is how a share button freezes the whole window on a slow drive.
    fn items(paths: &[String]) -> Result<Vec<IStorageItem>, String> {
        // WinRT has to be initialised on whichever thread this landed on. The
        // implicit-MTA form is used rather than `RoInitialize` because the
        // thread belongs to Tauri's pool, not to us, and taking it into an
        // apartment we then never uninitialise would be a leak on someone
        // else's thread. The cookie is intentionally never released: the
        // process keeps its MTA alive for as long as it runs.
        unsafe {
            let _ = CoIncrementMTAUsage();
        }
        let mut out = Vec::with_capacity(paths.len());
        for p in paths {
            let h = HSTRING::from(p.as_str());
            let item: IStorageItem = if std::path::Path::new(p).is_dir() {
                StorageFolder::GetFolderFromPathAsync(&h)
                    .and_then(|op| op.get())
                    .map_err(err)?
                    .cast()
                    .map_err(err)?
            } else {
                StorageFile::GetFileFromPathAsync(&h)
                    .and_then(|op| op.get())
                    .map_err(err)?
                    .cast()
                    .map_err(err)?
            };
            out.push(item);
        }
        Ok(out)
    }

    pub fn share(window: &tauri::Window, paths: Vec<String>) -> Result<(), String> {
        let title = super::title_for(&paths);
        let files = Agile(items(&paths)?);
        // Not the `HWND` itself: it is a raw pointer and therefore not `Send`,
        // and the sheet has to be raised from the thread that owns the window.
        let hwnd = window.hwnd().map_err(|e| e.to_string())?.0 as isize;

        let (tx, rx) = std::sync::mpsc::channel();
        window
            .run_on_main_thread(move || {
                let _ = tx.send(show(HWND(hwnd as *mut _), files, title));
            })
            .map_err(|e| e.to_string())?;
        rx.recv().map_err(|e| e.to_string())?
    }

    /// Raise the sheet. Must be on the window's own thread.
    ///
    /// `DataTransferManager` is a phone API with a desktop adapter bolted on:
    /// there is no "share these files" call, only a per-window manager that
    /// raises `DataRequested` and expects the app to fill a package in the
    /// handler. Hence the handler being registered immediately before the sheet
    /// is shown, and the items being captured by it rather than passed in.
    fn show(hwnd: HWND, files: Agile<Vec<IStorageItem>>, title: String) -> Result<(), String> {
        let interop: IDataTransferManagerInterop =
            windows::core::factory::<DataTransferManager, IDataTransferManagerInterop>().map_err(err)?;
        let dtm: DataTransferManager = unsafe { interop.GetForWindow(hwnd) }.map_err(err)?;

        dtm.DataRequested(&TypedEventHandler::new(
            move |_, args: windows::core::Ref<'_, DataRequestedEventArgs>| {
                let Some(args) = args.as_ref() else { return Ok(()) };
                let data = args.Request()?.Data()?;
                data.Properties()?.SetTitle(&HSTRING::from(title.as_str()))?;
                // Read-only: the target gets to copy or send the file, not to
                // write back over the original the user is still looking at.
                let list: Vec<Option<IStorageItem>> = files.get().iter().cloned().map(Some).collect();
                data.SetStorageItemsReadOnly(&windows_collections::IIterable::from(list))?;
                Ok(())
            },
        ))
        .map_err(err)?;

        unsafe { interop.ShowShareUIForWindow(hwnd) }.map_err(err)
    }

    /// One `GMEM_MOVEABLE` block, filled by `fill`, ready to hand to the
    /// clipboard. Freed here only on failure — once `SetClipboardData` accepts
    /// it the block belongs to the clipboard and freeing it would be a
    /// use-after-free in whatever pastes next.
    fn block(bytes: usize, fill: impl FnOnce(*mut u8)) -> Result<HGLOBAL, String> {
        unsafe {
            let h = GlobalAlloc(GMEM_MOVEABLE, bytes).map_err(err)?;
            let p = GlobalLock(h);
            if p.is_null() {
                let _ = GlobalFree(Some(h));
                return Err("out of memory".into());
            }
            fill(p as *mut u8);
            // Returns an error when the lock count reaches zero, which is the
            // normal outcome and not a failure.
            let _ = GlobalUnlock(h);
            Ok(h)
        }
    }

    pub fn copy(paths: &[String]) -> Result<(), String> {
        // CF_HDROP is a DROPFILES header followed by the paths as one run of
        // wide strings, each NUL-terminated, with a second NUL closing the list.
        let mut wide: Vec<u16> = Vec::new();
        for p in paths {
            wide.extend(p.encode_utf16());
            wide.push(0);
        }
        wide.push(0);

        let head = std::mem::size_of::<DROPFILES>();
        let drop_list = block(head + wide.len() * 2, |p| unsafe {
            p.cast::<DROPFILES>().write(DROPFILES {
                pFiles: head as u32,
                pt: POINT { x: 0, y: 0 },
                fNC: false.into(),
                // The paths are UTF-16. Getting this wrong does not fail — it
                // makes the receiver read the first path as a byte string and
                // paste a file called "C".
                fWide: true.into(),
            });
            std::ptr::copy_nonoverlapping(wide.as_ptr(), p.add(head).cast::<u16>(), wide.len());
        })?;

        let effect = block(4, |p| unsafe { p.cast::<u32>().write(DROPEFFECT_COPY) })?;
        let effect_fmt = unsafe { RegisterClipboardFormatW(w!("Preferred DropEffect")) };

        unsafe {
            OpenClipboard(None).map_err(err)?;
            // Everything from here to CloseClipboard is in a closure so that a
            // failure cannot leave the clipboard open — a clipboard left locked
            // by one app breaks copy and paste system-wide until it exits.
            let res = (|| -> Result<(), String> {
                EmptyClipboard().map_err(err)?;
                SetClipboardData(CF_HDROP, Some(HANDLE(drop_list.0))).map_err(err)?;
                if effect_fmt != 0 {
                    let _ = SetClipboardData(effect_fmt, Some(HANDLE(effect.0)));
                }
                Ok(())
            })();
            let _ = CloseClipboard();
            if res.is_err() {
                let _ = GlobalFree(Some(drop_list));
                let _ = GlobalFree(Some(effect));
            }
            res
        }
    }

    #[cfg(test)]
    mod tests {
        use super::*;
        use windows::Win32::UI::Shell::{DragQueryFileW, HDROP};

        /// Read the clipboard back the way a receiving app would.
        ///
        /// Deliberately through `DragQueryFileW` rather than by re-parsing the
        /// block this module just wrote: checking your own encoding against your
        /// own decoder proves the two agree, not that either is right. This is
        /// the shell's parser, which is the one Explorer and every other target
        /// will use.
        fn clipboard_files() -> Vec<String> {
            unsafe {
                OpenClipboard(None).expect("open clipboard");
                let h = windows::Win32::System::DataExchange::GetClipboardData(CF_HDROP)
                    .expect("CF_HDROP on the clipboard");
                let hdrop = HDROP(h.0);
                let count = DragQueryFileW(hdrop, u32::MAX, None);
                let mut out = Vec::new();
                for i in 0..count {
                    let len = DragQueryFileW(hdrop, i, None) as usize;
                    let mut buf = vec![0u16; len + 1];
                    DragQueryFileW(hdrop, i, Some(&mut buf));
                    out.push(String::from_utf16_lossy(&buf[..len]));
                }
                let _ = CloseClipboard();
                out
            }
        }

        #[test]
        fn files_land_on_the_clipboard_as_files() {
            let dir = std::env::temp_dir().join("facet-share-test");
            std::fs::create_dir_all(&dir).unwrap();
            // Two of them, and one with a space and a non-ASCII character: the
            // wide/narrow flag and the double-NUL terminator are both invisible
            // until a path needs them.
            let a = dir.join("one.txt");
            let b = dir.join("two ünd drei.txt");
            std::fs::write(&a, b"a").unwrap();
            std::fs::write(&b, b"b").unwrap();

            let paths = vec![
                a.to_string_lossy().into_owned(),
                b.to_string_lossy().into_owned(),
            ];
            copy(&paths).expect("copy to clipboard");

            let back = clipboard_files();
            assert_eq!(back.len(), 2, "both paths came back: {back:?}");
            assert_eq!(back[0], paths[0]);
            assert_eq!(back[1], paths[1], "the non-ASCII path survived as UTF-16");
        }

        #[test]
        fn paths_resolve_into_storage_items() {
            let dir = std::env::temp_dir().join("facet-share-test-items");
            std::fs::create_dir_all(&dir).unwrap();
            let f = dir.join("photo.jpg");
            std::fs::write(&f, b"not really a jpeg").unwrap();

            // A file and a folder, because they take different WinRT calls and
            // only one of them is the obvious one.
            let got = items(&[
                f.to_string_lossy().into_owned(),
                dir.to_string_lossy().into_owned(),
            ])
            .expect("both resolve");
            assert_eq!(got.len(), 2);
        }

        /// Everything the share sheet needs, stopping one call short of showing
        /// it. `ShowShareUIForWindow` is deliberately not called: it would put a
        /// real flyout on a real screen in the middle of a test run. What is
        /// checked here is the part that actually breaks — the activation
        /// factory, the interop QI, and the per-window manager.
        ///
        /// Two things this had to learn the hard way, and both are the reason
        /// `share` looks the way it does. `GetForWindow` returns E_ACCESSDENIED
        /// for a window the caller does not own, so the desktop window will not
        /// stand in — hence a real (never shown) window here, and hence
        /// `run_on_main_thread` in the real path. And the thread has to be an
        /// STA: this is a UI API, and the worker thread a Tauri command lands on
        /// is not one.
        #[test]
        fn the_share_sheet_can_be_reached() {
            use windows::Win32::System::Com::{CoInitializeEx, COINIT_APARTMENTTHREADED};
            use windows::Win32::UI::WindowsAndMessaging::{
                CreateWindowExW, DestroyWindow, WINDOW_EX_STYLE, WINDOW_STYLE,
            };

            unsafe {
                let _ = CoInitializeEx(None, COINIT_APARTMENTTHREADED);
            }
            let interop = windows::core::factory::<DataTransferManager, IDataTransferManagerInterop>()
                .expect("IDataTransferManagerInterop from the DataTransferManager factory");

            // "STATIC" is a class the system already registered, so this needs
            // no window procedure of its own. No WS_VISIBLE, so nothing appears.
            let hwnd = unsafe {
                CreateWindowExW(
                    WINDOW_EX_STYLE(0),
                    w!("STATIC"),
                    w!("facet share test"),
                    WINDOW_STYLE(0),
                    0,
                    0,
                    0,
                    0,
                    None,
                    None,
                    None,
                    None,
                )
            }
            .expect("a window to hang the share manager off");

            let dtm: windows::core::Result<DataTransferManager> = unsafe { interop.GetForWindow(hwnd) };
            let outcome = dtm.as_ref().err().map(|e| format!("{e:?}"));
            unsafe {
                let _ = DestroyWindow(hwnd);
            }
            assert!(dtm.is_ok(), "GetForWindow: {outcome:?}");
        }
    }
}
