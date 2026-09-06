/**
 * Real filesystem & SAF access for Android.
 *
 * Implements `FsAdapter` for Facet on Android devices.
 * Communicates with native Kotlin / SAF and Rust backend via Tauri IPC.
 */

import {
  type FsAdapter,
  type Place,
} from "./types";
import { TauriFs } from "./tauri-fs";

export class AndroidFs extends TauriFs implements FsAdapter {
  /**
   * Overrides platform roots for Android storage locations & SAF granted trees.
   */
  override async roots(): Promise<Place[]> {
    try {
      const places = await super.roots();
      if (places.length > 0) return places;
    } catch {
      // Fallback if desktop roots invocation is unavailable or empty
    }

    return [
      { id: "dcim", name: "Camera (DCIM)", icon: "📷", path: "/sdcard/DCIM", pinned: true },
      { id: "downloads", name: "Downloads", icon: "📥", path: "/sdcard/Download", pinned: true },
      { id: "pictures", name: "Pictures", icon: "🖼️", path: "/sdcard/Pictures", pinned: true },
      { id: "movies", name: "Movies & Videos", icon: "🎬", path: "/sdcard/Movies", pinned: true },
      { id: "music", name: "Music", icon: "🎵", path: "/sdcard/Music", pinned: true },
      { id: "documents", name: "Documents", icon: "📄", path: "/sdcard/Documents", pinned: true },
    ];
  }

  override openExternal(_path: string): Promise<void> {
    return super.openExternal(_path);
  }

  override revealInShell(_path: string): Promise<void> {
    // Reveal in shell is not available on Android
    return Promise.reject(new Error("Reveal in file manager is not supported on Android. Use Open External instead."));
  }

  override runProgram(_program: string, _args: readonly string[], _cwd?: string): Promise<void> {
    // Child processes are forbidden in Android app sandboxes
    return Promise.reject(new Error("Running arbitrary programs is disabled on Android for security reasons."));
  }
}

/** Detection helper for Android webview environment */
export const IS_ANDROID: boolean =
  typeof navigator !== "undefined" && /android/i.test(navigator.userAgent);
