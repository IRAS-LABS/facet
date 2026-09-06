//! FACET desktop shell.
//!
//! One window: the file explorer, which is what the binary is for. There is no
//! resident tray process and no second window; the whole app has the lifetime
//! of the window you open.

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
mod thumbs;
mod share;
// Android only (empty elsewhere): the loopback server that streams video and
// audio, because the asset protocol structurally cannot on that platform —
// the WebView re-applies the Range offset to an already-sliced body. The
// module doc has the full story.
mod media_server;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default();

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
            fsx::move_file,
            fsx::copy_file,
            fsx::drag_icon,
            fsx::empty_trash,
            fsx::watch_stamp,
            media::media_query,
            media::media_generation,
            media::media_scan,
            share::share_files,
            share::copy_files,
            ffmpeg::probe_media,
            ffmpeg::keyframes,
            ffmpeg::run_job,
            ffmpeg::cancel_job,
            ffmpeg::frame_at,
            ffmpeg::run_audio_job,
            ffmpeg::peaks
        ]);

    // The phone registers the same ffmpeg surface as the desktop. It reaches a
    // different binary — the one inside the APK rather than one on PATH — but
    // that difference is entirely inside `ffmpeg::cmd()`, so the command list
    // does not need to know about it. `run_program` is the one entry that is
    // registered and still refuses on this target: Android sandboxes forbid
    // arbitrary child processes, and `AndroidFs.runProgram` rejects before the
    // IPC hop, so the entry exists only to keep the two handler lists readable
    // side by side.
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
        fsx::move_file,
        fsx::copy_file,
        fsx::empty_trash,
        fsx::watch_stamp,
        media::media_query,
        media::media_generation,
            media::media_scan,
        share::share_files,
        share::copy_files,
        media_server::media_url,
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
