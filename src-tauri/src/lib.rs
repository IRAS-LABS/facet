//! FACET desktop shell.
//!
//! The file explorer, which is what the binary is for, and on a desktop any
//! number of pop-out windows (`pip.rs`), each showing one file. There is no
//! resident tray process: the app lives as long as its last window, and
//! `facet pip open clip.mp4` starts with only the pop-out.

// ffmpeg is a child process. There is no ffmpeg on a *stock* Android device,
// which is why this module was desktop-only for most of the project's life —
// but as of 2026-08-23 the APK ships its own arm64 `ffmpeg` and `ffprobe` as
// `lib{ffmpeg,ffprobe}.so` under jniLibs, and `native_lib_dir()` below resolves
// them at runtime. Leaving the `#[cfg(desktop)]` on meant those two 25 MB
// binaries were packaged, doubling the APK, while the module that execs them
// was never compiled for the target that carries them — so every phone call
// site (video thumbnails, durations, waveforms) had no command to invoke.
mod ffmpeg;
mod fsx;
mod media;
mod openwith;
mod speech;
mod thumbs;
mod share;
// Android only (empty elsewhere): the loopback server that streams video and
// audio, because the asset protocol structurally cannot on that platform —
// the WebView re-applies the Range offset to an already-sliced body. The
// module doc has the full story.
mod media_server;
// Desktop only: the command-line grammar, and the pop-out windows it drives.
#[cfg(desktop)]
mod cli;
#[cfg(desktop)]
mod pip;
#[cfg(desktop)]
mod pip_layout;
// Desktop only: FACET as an MCP server, so a model can drive the same engine
// over stdio that the window drives over IPC. Reached by `facet mcp` in `run()`
// below, before any window exists.
#[cfg(desktop)]
mod mcp;

/// The `--req N` of a command line that failed to parse, so the error can
/// still be reported against the number the caller is waiting for.
#[cfg(desktop)]
fn req_of(args: &[String]) -> Option<u64> {
    let i = args.iter().position(|a| a == "--req")?;
    args.get(i + 1)?.parse().ok()
}

/// Act on a command line, from this launch or a second one.
#[cfg(desktop)]
fn handle_args<R: tauri::Runtime>(app: &tauri::AppHandle<R>, args: &[String], cwd: &std::path::Path) {
    match cli::parse(args, cwd) {
        Ok(request) => pip::dispatch(app, request),
        Err(e) => {
            pip::record_error(app, req_of(args), e);
            // A second launch that said nothing sensible still means "show me
            // FACET"; a broken pop-out command must not raise the explorer.
            if args.first().map(String::as_str) != Some("pip") {
                pip::show_main(app);
            }
        }
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // `facet mcp` is not the app. It is this same binary answering JSON-RPC on
    // stdin, and it has to be caught here — before the builder, before the
    // single-instance plugin — or a running FACET would swallow the launch and
    // hand the arguments to a window, leaving the client waiting on a stdout
    // that nothing will ever write to.
    #[cfg(desktop)]
    {
        let mut args = std::env::args().skip(1);
        if args.next().as_deref() == Some("mcp") {
            std::process::exit(mcp::serve());
        }
    }

    let builder = tauri::Builder::default();

    // First, before anything else can open a window: a second `facet.exe`
    // hands its arguments to this copy and exits. Without it every `facet pip
    // open` would be a whole new process, with its own pop-out table that no
    // later `pip tile` or `pip close` could reach.
    #[cfg(desktop)]
    let builder = builder
        .plugin(tauri_plugin_single_instance::init(|app, argv, cwd| {
            let args: Vec<String> = argv.into_iter().skip(1).collect();
            handle_args(app, &args, std::path::Path::new(&cwd));
        }))
        .manage(pip::Pips::default())
        .setup(|app| {
            // The explorer is `create: false` in tauri.conf.json so that a
            // cold `facet pip open` does not flash it up first. Everything
            // else builds it here, exactly as Tauri would have.
            let args: Vec<String> = std::env::args().skip(1).collect();
            let cwd = std::env::current_dir().unwrap_or_default();
            let pip_only = matches!(cli::parse(&args, &cwd), Ok(ref r) if r.is_pip())
                || args.first().map(String::as_str) == Some("pip");
            if !pip_only {
                pip::show_main(app.handle());
            }
            match cli::parse(&args, &cwd) {
                Ok(r) if matches!(r.command, cli::Command::Nothing) => {}
                _ => handle_args(app.handle(), &args, &cwd),
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::Destroyed = event {
                use tauri::Manager;
                pip::forget(window.app_handle(), window.label());
            }
        });

    // The two platforms register genuinely different command sets, so the
    // handler is built per-target rather than shared with dead entries: ffmpeg
    // is a child process and there is no ffmpeg on a stock phone.
    //
    // A stray `--facet` on the command line is accepted and ignored. It meant
    // something back when this binary had a second mode; the explorer is all it
    // has now, so the flag is a no-op kept only so an old shortcut still works.
    #[cfg(desktop)]
    let builder = builder
        // Item 9. Nothing else in the app can start an OS-level drag: a drag
        // that ends in another program is one the operating system has to own
        // from the first pixel of movement.
        .plugin(tauri_plugin_drag::init())
        .invoke_handler(tauri::generate_handler![
            fsx::list_dir,
            fsx::list_roots,
            fsx::home_places,
            fsx::scan_media,
            thumbs::mark, thumbs::thumb_cached,
            thumbs::thumb_store, thumbs::thumb_batch,
            fsx::open_external,
            fsx::reveal,
            fsx::run_program,
            fsx::read_head,
            fsx::read_range,
            fsx::read_tail,
            fsx::write_file,
            fsx::append_file,
        fsx::patch_file,
            fsx::move_file,
            fsx::copy_file,
            fsx::drag_icon,
            fsx::empty_trash,
            fsx::watch_stamp,
            media::media_query,
            media::media_generation,
            media::media_scan,
            openwith::open_pending,
            speech::speech_voices,
            speech::speech_speak,
            speech::speech_stop,
            share::share_files,
            share::copy_files,
            ffmpeg::media_ready,
            ffmpeg::probe_media,
            ffmpeg::keyframes,
            ffmpeg::run_job,
            ffmpeg::cancel_job,
            ffmpeg::frame_at,
            ffmpeg::run_audio_job,
            ffmpeg::peaks,
            pip::pip_info,
            pip::pip_ready,
            pip::pip_open,
            pip::pip_list,
            pip::pip_tile,
            pip::pip_close,
            pip::pip_show_all,
            pip::pip_reveal
        ]);

    // The phone registers the same ffmpeg surface as the desktop. It reaches a
    // different binary — the one inside the APK rather than one on PATH — but
    // that difference is entirely inside `ffmpeg::cmd()`, so the command list
    // does not need to know about it. `run_program` is the one entry that is
    // registered and still refuses on this target: Android sandboxes forbid
    // arbitrary child processes, and `AndroidFs.runProgram` rejects before the
    // IPC hop, so the entry exists only to keep the two handler lists readable
    // side by side.
    // The phone has no pop-outs and always wants the explorer. `create: false`
    // is shared config, so build it here — the same two calls Tauri's own
    // setup makes for a window that is left to it.
    //
    // Only when Tauri has not already. tauri.android.conf.json replaces the
    // whole `windows` array (a merge patch swaps arrays rather than merging
    // them), which drops `create: false`, so on Android Tauri builds `main`
    // itself and a second build panics with "a webview with label `main`
    // already exists" before the first frame. Checking for the window covers
    // both configs.
    #[cfg(mobile)]
    let builder = builder.setup(|app| {
        use tauri::Manager;
        if app.get_webview_window("main").is_none() {
            if let Some(cfg) = app.config().app.windows.iter().find(|w| w.label == "main") {
                tauri::WebviewWindowBuilder::from_config(app.handle(), cfg)?.build()?;
            }
        }
        Ok(())
    });

    #[cfg(mobile)]
    let builder = builder.invoke_handler(tauri::generate_handler![
        fsx::list_dir,
        fsx::list_roots,
        fsx::home_places,
        fsx::scan_media,
            thumbs::mark, thumbs::thumb_cached,
            thumbs::thumb_store, thumbs::thumb_batch,
        fsx::open_external,
        fsx::reveal,
        fsx::run_program,
        fsx::read_head,
        fsx::read_range,
        fsx::read_tail,
        fsx::write_file,
        fsx::append_file,
        fsx::patch_file,
        fsx::move_file,
        fsx::copy_file,
        fsx::empty_trash,
        fsx::watch_stamp,
        media::media_query,
        media::media_generation,
            media::media_scan,
        openwith::open_pending,
        speech::speech_voices,
        speech::speech_speak,
        speech::speech_stop,
        share::share_files,
        share::copy_files,
        media_server::media_url,
        ffmpeg::media_ready,
        ffmpeg::probe_media,
        ffmpeg::keyframes,
        ffmpeg::run_job,
        ffmpeg::cancel_job,
        ffmpeg::frame_at,
        ffmpeg::run_audio_job,
        ffmpeg::peaks
    ]);

    builder
        .run(tauri::generate_context!())
        .expect("failed to start Facet");
}
