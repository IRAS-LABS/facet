//! The real Windows Explorer right-click menu, on files FACET is showing.
//!
//! FACET's own menu is built from its own commands, and that is the right
//! menu for almost everything. What it can never contain is what *other*
//! programs have added to Explorer's: 7-Zip's archive submenu, "Send with
//! Tailscale", "Scan with Defender", a Git client's entries, the real "Open
//! with" list and Properties. Those live in shell extensions, and the only way
//! to offer them is to ask the shell for the menu it would have shown and show
//! that, which is what this module does.
//!
//! The shape is the one every file manager that does this uses, and each step
//! is there because the menu breaks in a specific way without it:
//!
//!  - **The items are resolved to ID lists and bound through their parent
//!    folder.** `IShellFolder::GetUIObjectOf` on the parent, with every
//!    selected child at once, is what gives *one* menu for a multi-selection —
//!    the one where "Add to archive" means all of them. Asking per item would
//!    give a menu about the first file only.
//!  - **It runs on the window's own thread.** Shell extensions are apartment-
//!    threaded COM objects and the menu is a Win32 popup owned by FACET's
//!    window; both have to be on the thread that owns that window, which is
//!    also an STA already (the web view insists on it). A Tauri command lands
//!    on a worker, so the work is posted over and the answer comes back on a
//!    channel.
//!  - **The window is subclassed while the menu is up.** "Send to", "Open
//!    with" and 7-Zip's submenu are filled in lazily, when the submenu opens,
//!    and some entries draw their own icons. Both arrive as window messages to
//!    the menu's owner (`WM_INITMENUPOPUP`, `WM_MEASUREITEM`, `WM_DRAWITEM`,
//!    `WM_MENUCHAR`), and unless they are handed to `IContextMenu2/3` the
//!    submenus open empty. The subclass is removed the moment the menu closes.
//!  - **The command is invoked by offset, with the click point.** Verbs are
//!    not unique across extensions, and an offset is the only name every
//!    handler is guaranteed to answer to.
//!
//! Two deliberate differences from Explorer. Rename is not offered: it is
//! carried out by Explorer's own view, which FACET is not, so the row would do
//! nothing. And the Shift key is never passed through to the command — in
//! Explorer, Shift held while choosing Delete skips the Recycle Bin, and a
//! Shift+right-click (the shortcut to this very menu) would leave it held.
//! From here, Delete always recycles.

/// Show the shell's menu for `paths` at `x`, `y` and run what was picked.
///
/// `x` and `y` are physical pixels from the top-left of the window's client
/// area — the page multiplies its CSS coordinates by `devicePixelRatio` before
/// sending them, because only it knows the zoom. `extended` asks for the
/// entries Explorer keeps behind Shift ("Copy as path", "Open PowerShell window
/// here"), which is what a Shift+right-click means there too.
///
/// Resolves to the picked command's verb (possibly empty — not every handler
/// names its commands), or `None` when the menu was dismissed. The caller only
/// needs the difference: something may have changed on disk, or nothing did.
#[tauri::command]
pub async fn shell_menu(
    window: tauri::Window,
    paths: Vec<String>,
    x: i32,
    y: i32,
    extended: bool,
) -> Result<Option<String>, String> {
    if paths.is_empty() {
        return Err("nothing selected".into());
    }
    #[cfg(windows)]
    {
        win::show(window, paths, x, y, extended).await
    }
    #[cfg(not(windows))]
    {
        let _ = (window, x, y, extended);
        Err("the Windows menu only exists on Windows".into())
    }
}

/// The folder an item sits in, as a key two items can be compared on.
///
/// Lower-cased because NTFS compares names that way, and on the backslash
/// form because the page sends forward slashes. A drive root has no parent on
/// disk and gets the empty key, which groups drive roots with each other —
/// correct, since the shell's parent for all of them is This PC.
#[cfg_attr(not(windows), allow(dead_code))]
fn parent_key(path: &str) -> String {
    let native = to_native(path);
    std::path::Path::new(&native)
        .parent()
        .map(|p| p.to_string_lossy().trim_end_matches('\\').to_lowercase())
        .unwrap_or_default()
}

/// FACET's paths use forward slashes everywhere; the shell's parser wants
/// backslashes, and quietly fails to resolve a UNC path without them.
#[cfg_attr(not(windows), allow(dead_code))]
fn to_native(path: &str) -> String {
    path.replace('/', "\\")
}

#[cfg(windows)]
mod win {
    use windows::core::{Interface, HRESULT, HSTRING, PCSTR, PCWSTR, PSTR};
    use windows::Win32::Foundation::{ERROR_CANCELLED, HWND, LPARAM, LRESULT, POINT, RPC_E_CHANGED_MODE, WPARAM};
    use windows::Win32::Graphics::Gdi::ClientToScreen;
    use windows::Win32::System::Com::{CoInitializeEx, CoUninitialize, COINIT_APARTMENTTHREADED};
    use windows::Win32::UI::Shell::Common::ITEMIDLIST;
    use windows::Win32::UI::Shell::{
        DefSubclassProc, ILFree, IContextMenu, IContextMenu2, IContextMenu3, IShellFolder,
        RemoveWindowSubclass, SHBindToParent, SHParseDisplayName, SetWindowSubclass,
        CMF_EXPLORE, CMF_EXTENDEDVERBS, CMF_NORMAL, CMIC_MASK_PTINVOKE, CMINVOKECOMMANDINFO,
        CMINVOKECOMMANDINFOEX, GCS_VERBW, SEE_MASK_ASYNCOK, SEE_MASK_UNICODE,
    };
    use windows::Win32::UI::WindowsAndMessaging::{
        CreatePopupMenu, DestroyMenu, TrackPopupMenuEx, HMENU, SW_SHOWNORMAL, TPM_RETURNCMD,
        TPM_RIGHTBUTTON, WM_DRAWITEM, WM_INITMENUPOPUP, WM_MEASUREITEM, WM_MENUCHAR,
    };

    /// The command ids handed to the shell. Zero is what `TrackPopupMenuEx`
    /// returns for "dismissed", so the range starts above it; the top is the
    /// largest id a menu item can carry.
    const FIRST: u32 = 1;
    const LAST: u32 = 0x7FFF;

    /// Our subclass's name on the window. Any constant that no other subclass
    /// of the same window uses; tao installs its own under a different id.
    const SUBCLASS_ID: usize = 0x46_41_43_45; // "FACE"

    fn err(e: windows::core::Error) -> String {
        e.message().to_string()
    }

    pub async fn show(
        window: tauri::Window,
        paths: Vec<String>,
        x: i32,
        y: i32,
        extended: bool,
    ) -> Result<Option<String>, String> {
        // Not the `HWND` itself: it is a raw pointer and therefore not `Send`.
        let hwnd = window.hwnd().map_err(|e| e.to_string())?.0 as isize;

        let (tx, rx) = std::sync::mpsc::channel();
        window
            .run_on_main_thread(move || {
                let _ = tx.send(run(HWND(hwnd as *mut _), &paths, x, y, extended));
            })
            .map_err(|e| e.to_string())?;

        // The wait happens on a blocking thread rather than on the async
        // worker that received the command. The menu stays open for as long as
        // the user looks at it, and parking a runtime worker for that long is
        // how an unrelated `await` elsewhere in the app ends up stalling.
        //
        // Also why this command is async at all: a synchronous Tauri command
        // runs on the main thread from inside the web view's message handler,
        // and a popup menu's modal loop nested inside that handler is exactly
        // the re-entrancy WebView2 does not support.
        tauri::async_runtime::spawn_blocking(move || rx.recv())
            .await
            .map_err(|e| e.to_string())?
            .map_err(|_| "the window closed before the menu could open".to_string())?
    }

    /// Everything, on the window's thread.
    fn run(hwnd: HWND, paths: &[String], x: i32, y: i32, extended: bool) -> Result<Option<String>, String> {
        let _com = Apartment::enter()?;

        let parent = super::parent_key(&paths[0]);
        if paths.iter().any(|p| super::parent_key(p) != parent) {
            return Err("the Windows menu can only show items from one folder at a time".into());
        }

        let items = Pidls::parse(paths)?;
        let menu = items.context_menu(hwnd)?;

        let hmenu = Menu(unsafe { CreatePopupMenu() }.map_err(err)?);
        let mut flags = CMF_NORMAL | CMF_EXPLORE;
        if extended {
            flags |= CMF_EXTENDEDVERBS;
        }
        unsafe { menu.QueryContextMenu(hmenu.0, 0, FIRST, LAST, flags) }
            .ok()
            .map_err(err)?;

        let mut at = POINT { x, y };
        unsafe {
            let _ = ClientToScreen(hwnd, &mut at);
        }

        let chosen = {
            let hook = Hook {
                menu2: menu.cast().ok(),
                menu3: menu.cast().ok(),
            };
            let _subclass = Subclass::install(hwnd, &hook);
            unsafe {
                TrackPopupMenuEx(
                    hmenu.0,
                    TPM_RETURNCMD.0 | TPM_RIGHTBUTTON.0,
                    at.x,
                    at.y,
                    hwnd,
                    None,
                )
            }
            .0 as u32
            // `_subclass` is dropped here, before `hook` — the order the
            // subclass procedure depends on, since it reads `hook` through a
            // raw pointer.
        };
        if chosen < FIRST {
            return Ok(None);
        }
        let offset = (chosen - FIRST) as usize;
        let verb = verb_of(&menu, offset);

        // The folder the items are in, for handlers that start a program there
        // ("Open in Terminal"). Kept in a binding: the struct below borrows it.
        let dir = HSTRING::from(
            std::path::Path::new(&super::to_native(&paths[0]))
                .parent()
                .map(|p| p.to_string_lossy().into_owned())
                .unwrap_or_default(),
        );

        let info = CMINVOKECOMMANDINFOEX {
            cbSize: std::mem::size_of::<CMINVOKECOMMANDINFOEX>() as u32,
            // No CMIC_MASK_SHIFT_DOWN, ever; see the module note on Delete.
            // ASYNCOK lets a handler that starts a long job (an archive, a
            // copy) return and finish on its own thread, as it would in
            // Explorer, rather than holding FACET's window frozen until done.
            fMask: SEE_MASK_UNICODE | CMIC_MASK_PTINVOKE | SEE_MASK_ASYNCOK,
            hwnd,
            // The ANSI and wide fields both carry the offset, disguised as a
            // pointer in the MAKEINTRESOURCE way. Some handlers only read one.
            lpVerb: PCSTR(offset as *const u8),
            lpVerbW: PCWSTR(offset as *const u16),
            lpDirectoryW: if dir.is_empty() { PCWSTR::null() } else { PCWSTR(dir.as_ptr()) },
            nShow: SW_SHOWNORMAL.0,
            ptInvoke: at,
            ..Default::default()
        };
        let invoked = unsafe { menu.InvokeCommand(&info as *const _ as *const CMINVOKECOMMANDINFO) };
        match invoked {
            Ok(()) => Ok(Some(verb)),
            // The user said no in a dialog the command raised — a delete
            // confirmation, a UAC prompt. Not a failure worth a message, but
            // still a command that ran, so the folder is re-read either way.
            Err(e) if e.code() == HRESULT::from_win32(ERROR_CANCELLED.0) => Ok(Some(verb)),
            Err(e) => Err(err(e)),
        }
    }

    /// The canonical verb of a picked command, or empty when the handler does
    /// not name it. Only ever informational.
    fn verb_of(menu: &IContextMenu, offset: usize) -> String {
        let mut buf = [0u16; 128];
        let ok = unsafe {
            menu.GetCommandString(
                offset,
                GCS_VERBW,
                None,
                PSTR(buf.as_mut_ptr().cast()),
                buf.len() as u32,
            )
        };
        if ok.is_err() {
            return String::new();
        }
        let end = buf.iter().position(|&c| c == 0).unwrap_or(buf.len());
        String::from_utf16_lossy(&buf[..end])
    }

    /// COM on this thread for the duration of the menu.
    ///
    /// The window's thread is already a single-threaded apartment in practice,
    /// in which case this only bumps a count and the drop gives it back. If it
    /// were ever a multithreaded one instead, shell extensions would load into
    /// the wrong apartment and misbehave in ways that are very hard to trace
    /// back here, so that case refuses up front.
    struct Apartment(bool);

    impl Apartment {
        fn enter() -> Result<Self, String> {
            let hr = unsafe { CoInitializeEx(None, COINIT_APARTMENTTHREADED) };
            if hr == RPC_E_CHANGED_MODE {
                return Err("the window's thread is not a single-threaded COM apartment".into());
            }
            Ok(Self(hr.is_ok()))
        }
    }

    impl Drop for Apartment {
        fn drop(&mut self) {
            if self.0 {
                unsafe { CoUninitialize() };
            }
        }
    }

    /// Absolute item ID lists for the selection, freed on drop.
    ///
    /// Kept alive for as long as the menu is: the child IDs handed to
    /// `GetUIObjectOf` point *into* these, not at copies.
    struct Pidls(Vec<*mut ITEMIDLIST>);

    impl Pidls {
        fn parse(paths: &[String]) -> Result<Self, String> {
            let mut out = Pidls(Vec::with_capacity(paths.len()));
            for p in paths {
                let wide = HSTRING::from(super::to_native(p));
                let mut pidl: *mut ITEMIDLIST = std::ptr::null_mut();
                unsafe { SHParseDisplayName(&wide, None, &mut pidl, 0, None) }
                    .map_err(|e| format!("{p}: {}", err(e)))?;
                out.0.push(pidl);
            }
            Ok(out)
        }

        /// One `IContextMenu` for all of them, from their shared parent.
        fn context_menu(&self, hwnd: HWND) -> Result<IContextMenu, String> {
            let mut folder: Option<IShellFolder> = None;
            let mut children: Vec<*const ITEMIDLIST> = Vec::with_capacity(self.0.len());
            for &pidl in &self.0 {
                let mut last: *mut ITEMIDLIST = std::ptr::null_mut();
                let parent: IShellFolder =
                    unsafe { SHBindToParent(pidl, Some(&mut last)) }.map_err(err)?;
                // Every item has the same parent (checked by path before this),
                // so the first folder speaks for all of them.
                folder.get_or_insert(parent);
                children.push(last as *const ITEMIDLIST);
            }
            let folder = folder.ok_or("nothing selected")?;
            unsafe { folder.GetUIObjectOf::<IContextMenu>(hwnd, &children, None) }.map_err(err)
        }
    }

    impl Drop for Pidls {
        fn drop(&mut self) {
            for &pidl in &self.0 {
                unsafe { ILFree(Some(pidl)) };
            }
        }
    }

    /// The popup menu handle, destroyed on every way out of `run`.
    struct Menu(HMENU);

    impl Drop for Menu {
        fn drop(&mut self) {
            unsafe {
                let _ = DestroyMenu(self.0);
            }
        }
    }

    /// What the subclass procedure forwards menu messages to. Either may be
    /// missing: an old extension implements neither, and then its submenus are
    /// simply static.
    struct Hook {
        menu2: Option<IContextMenu2>,
        menu3: Option<IContextMenu3>,
    }

    /// The window subclassed for as long as this value lives.
    struct Subclass(HWND);

    impl Subclass {
        fn install(hwnd: HWND, hook: &Hook) -> Self {
            unsafe {
                let _ = SetWindowSubclass(hwnd, Some(forward), SUBCLASS_ID, hook as *const Hook as usize);
            }
            Subclass(hwnd)
        }
    }

    impl Drop for Subclass {
        fn drop(&mut self) {
            unsafe {
                let _ = RemoveWindowSubclass(self.0, Some(forward), SUBCLASS_ID);
            }
        }
    }

    /// Hand the owner-window messages a shell menu depends on to its handler.
    ///
    /// The same routine Raymond Chen's reference host uses: `IContextMenu3`
    /// when there is one, because only it can answer `WM_MENUCHAR` and return
    /// a result; `IContextMenu2` otherwise. `WM_DRAWITEM` and `WM_MEASUREITEM`
    /// are only forwarded when they come from a menu (`wParam` zero) so that
    /// nothing else owner-drawn in the window could be answered by a shell
    /// extension instead.
    unsafe extern "system" fn forward(
        hwnd: HWND,
        msg: u32,
        wparam: WPARAM,
        lparam: LPARAM,
        _id: usize,
        data: usize,
    ) -> LRESULT {
        let menu_msg = match msg {
            WM_INITMENUPOPUP | WM_MENUCHAR => true,
            WM_DRAWITEM | WM_MEASUREITEM => wparam.0 == 0,
            _ => false,
        };
        if menu_msg && data != 0 {
            let hook = unsafe { &*(data as *const Hook) };
            if let Some(m3) = &hook.menu3 {
                let mut result = LRESULT(0);
                if unsafe { m3.HandleMenuMsg2(msg, wparam, lparam, Some(&mut result)) }.is_ok() {
                    return result;
                }
            } else if let Some(m2) = &hook.menu2 {
                if msg != WM_MENUCHAR && unsafe { m2.HandleMenuMsg(msg, wparam, lparam) }.is_ok() {
                    return LRESULT(0);
                }
            }
        }
        unsafe { DefSubclassProc(hwnd, msg, wparam, lparam) }
    }

    #[cfg(test)]
    mod tests {
        use super::*;
        use windows::core::w;
        use windows::Win32::UI::WindowsAndMessaging::{
            CreateWindowExW, DestroyWindow, GetMenuItemCount, GetMenuItemID, WINDOW_EX_STYLE,
            WINDOW_STYLE,
        };

        /// Everything the menu needs, stopping one call short of showing it —
        /// the same line `share.rs` draws, for the same reason: tracking a
        /// popup in a test run would put a real menu on a real screen and wait
        /// for someone to click it.
        ///
        /// What is checked is the part that breaks: that forward-slash paths
        /// resolve, that two files in one folder give *one* menu through their
        /// parent, that the shell (and whatever extensions this machine has)
        /// fills it, and that a picked id can be turned back into a verb. Two
        /// files rather than one, and one with a space and a non-ASCII name,
        /// because a multi-selection and an awkward name are both invisible
        /// until they are not.
        #[test]
        fn two_files_get_one_real_menu_with_delete_in_it() {
            let _com = Apartment::enter().expect("an STA on the test thread");

            let dir = std::env::temp_dir().join("facet-shellmenu-test");
            std::fs::create_dir_all(&dir).unwrap();
            let a = dir.join("one.txt");
            let b = dir.join("two ünd drei.txt");
            std::fs::write(&a, b"a").unwrap();
            std::fs::write(&b, b"b").unwrap();
            let paths: Vec<String> = [a, b]
                .iter()
                .map(|p| p.to_string_lossy().replace('\\', "/"))
                .collect();

            // "STATIC" is a class the system already registered, so this needs
            // no window procedure of its own. No WS_VISIBLE, so nothing appears.
            let hwnd = unsafe {
                CreateWindowExW(
                    WINDOW_EX_STYLE(0),
                    w!("STATIC"),
                    w!("facet shell menu test"),
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
            .expect("a window to own the menu");

            let verbs = (|| -> Result<Vec<String>, String> {
                let items = Pidls::parse(&paths)?;
                let menu = items.context_menu(hwnd)?;
                let hmenu = Menu(unsafe { CreatePopupMenu() }.map_err(err)?);
                unsafe { menu.QueryContextMenu(hmenu.0, 0, FIRST, LAST, CMF_NORMAL | CMF_EXPLORE) }
                    .ok()
                    .map_err(err)?;
                let n = unsafe { GetMenuItemCount(Some(hmenu.0)) };
                Ok((0..n)
                    .map(|i| unsafe { GetMenuItemID(hmenu.0, i) })
                    // Separators and submenus report no id of their own.
                    .filter(|&id| id != u32::MAX && id >= FIRST)
                    .map(|id| verb_of(&menu, (id - FIRST) as usize))
                    .collect())
            })();
            unsafe {
                let _ = DestroyWindow(hwnd);
            }

            let verbs = verbs.expect("a context menu for both files");
            assert!(
                verbs.iter().any(|v| v.eq_ignore_ascii_case("delete")),
                "the shell's own Delete is in the menu: {verbs:?}"
            );
            // Rename is left out on purpose; see the module note.
            assert!(
                !verbs.iter().any(|v| v.eq_ignore_ascii_case("rename")),
                "Rename is not offered: {verbs:?}"
            );
        }
    }
}

// Windows only: on any other system a backslash is part of a file name, not a
// separator, and these paths would not have parents at all.
#[cfg(all(test, windows))]
mod tests {
    use super::*;

    #[test]
    fn items_in_one_folder_share_a_key_whatever_the_slashes() {
        assert_eq!(parent_key("C:/Users/me/a.jpg"), parent_key("c:\\users\\ME\\b.png"));
        assert_ne!(parent_key("C:/Users/me/a.jpg"), parent_key("C:/Users/you/a.jpg"));
    }

    #[test]
    fn a_folder_and_a_file_beside_it_share_a_key() {
        assert_eq!(parent_key("D:/photos/2024"), parent_key("D:/photos/cover.jpg"));
    }
}
