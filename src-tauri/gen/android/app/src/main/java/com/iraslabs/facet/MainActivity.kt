package com.iraslabs.facet

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Environment
import android.provider.Settings
import android.webkit.MimeTypeMap
import android.webkit.WebView
import androidx.activity.enableEdgeToEdge
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
import androidx.core.content.FileProvider
import java.io.File

/**
 * FACET's Android entry point.
 *
 * Beyond the Tauri boilerplate this exists for one reason: a file explorer that
 * cannot see files is not a file explorer. The Rust side lists
 * /storage/emulated/0 directly, and on a modern Android that returns an empty
 * directory — silently, with no error — unless the app holds storage access.
 * Asking for it here means the very first launch is the only awkward moment,
 * rather than every folder looking mysteriously empty.
 *
 * The ladder is three-runged because Google moved the goalposts twice:
 *   - API 30+  All-files access, which is a Settings screen the user has to
 *              toggle themselves. There is no in-app dialog for it; the most an
 *              app may do is take you there, which is what this does.
 *   - API 33+  The granular READ_MEDIA_* trio, still needed for the media
 *              pickers even when all-files access is held.
 *   - API 29-  The classic READ/WRITE pair as an ordinary runtime prompt.
 *
 * Nothing here forces the issue: if the user declines, the app still runs and
 * simply shows what it is allowed to show.
 */
class MainActivity : TauriActivity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    // The frontend is brotli-compressed into libfacet_lib.so, so an APK cannot
    // be inspected from the outside at all: there is no index.html to read and
    // grepping the .so for a selector finds nothing. Without this the only way
    // to see what the shell actually rendered is a screenshot, and a screenshot
    // cannot tell you whether a photograph is small because of a sizing rule or
    // because two hidden siblings are sharing its grid. This opens a devtools
    // socket over adb so the live DOM can be read directly.
    //
    // Debug builds only. In a release build the same socket would let any app
    // holding the debug permission -- or anyone with adb on an unlocked phone --
    // read and script the WebView, which has the user's whole library behind it.
    if (BuildConfig.DEBUG) WebView.setWebContentsDebuggingEnabled(true)
    super.onCreate(savedInstanceState)
    requestStorageAccess()
    // The doorbell for the phone library: MediaStore change notifications bump
    // a counter the frontend polls, so a file landing in a folder FACET has
    // never walked (a sync client's drop folder, a new app's media dir) shows
    // up within a second.
    MediaBridge.start(this)
  }

  private fun requestStorageAccess() {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
      if (!Environment.isExternalStorageManager()) {
        try {
          startActivity(
            Intent(
              Settings.ACTION_MANAGE_APP_ALL_FILES_ACCESS_PERMISSION,
              Uri.parse("package:$packageName"),
            )
          )
        } catch (_: Exception) {
          // Some OEM builds ship without that settings activity. The generic
          // screen is a worse landing spot but still gets there, and a crash on
          // first launch would be far worse than an extra tap.
          try {
            startActivity(Intent(Settings.ACTION_MANAGE_ALL_FILES_ACCESS_PERMISSION))
          } catch (_: Exception) {
          }
        }
      }
    }

    val wanted = mutableListOf<String>()
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
      wanted += Manifest.permission.READ_MEDIA_IMAGES
      wanted += Manifest.permission.READ_MEDIA_VIDEO
      wanted += Manifest.permission.READ_MEDIA_AUDIO
    } else {
      wanted += Manifest.permission.READ_EXTERNAL_STORAGE
      if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) {
        wanted += Manifest.permission.WRITE_EXTERNAL_STORAGE
      }
    }

    val missing = wanted.filter {
      ContextCompat.checkSelfPermission(this, it) != PackageManager.PERMISSION_GRANTED
    }
    if (missing.isNotEmpty()) {
      ActivityCompat.requestPermissions(this, missing.toTypedArray(), REQUEST_STORAGE)
    }
  }

  /**
   * Raise the system share sheet for files on disk. Called from the Rust side
   * (share.rs) over JNI, on the main thread via wry's dispatch pipe.
   *
   * A bare file:// URI has been a FileUriExposedException since API 24, so
   * every path goes through the FileProvider declared in the manifest — its
   * external-path root "." covers the whole primary volume the scanner reads.
   * A path the provider cannot mint (an SD card, a vanished file) is skipped
   * rather than sinking the whole share.
   */
  @Suppress("unused")
  fun shareFiles(paths: Array<String>) {
    val uris = ArrayList<Uri>()
    for (p in paths) {
      val f = File(p)
      if (!f.isFile) continue
      try {
        uris.add(FileProvider.getUriForFile(this, "$packageName.fileprovider", f))
      } catch (_: IllegalArgumentException) {
      }
    }
    if (uris.isEmpty()) return

    // One concrete type helps the target list; a mixed pile is anything.
    val mime = if (paths.size == 1) {
      MimeTypeMap.getSingleton()
        .getMimeTypeFromExtension(File(paths[0]).extension.lowercase()) ?: "*/*"
    } else "*/*"

    val send = if (uris.size == 1) {
      Intent(Intent.ACTION_SEND).apply {
        putExtra(Intent.EXTRA_STREAM, uris[0])
        type = mime
      }
    } else {
      Intent(Intent.ACTION_SEND_MULTIPLE).apply {
        putParcelableArrayListExtra(Intent.EXTRA_STREAM, uris)
        type = mime
      }
    }
    send.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
    try {
      startActivity(Intent.createChooser(send, null))
    } catch (_: Exception) {
      // No target on the device can take it. Nothing sane to do but stay up.
    }
  }

  private companion object {
    const val REQUEST_STORAGE = 4201
  }
}
