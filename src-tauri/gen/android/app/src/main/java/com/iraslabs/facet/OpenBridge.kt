package com.iraslabs.facet

import android.content.ContentUris
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Environment
import android.provider.DocumentsContract
import android.provider.MediaStore
import android.provider.OpenableColumns
import org.json.JSONArray
import java.io.File
import java.util.concurrent.ConcurrentLinkedQueue

/**
 * "Open with FACET", and the share sheet's "Send to FACET".
 *
 * Android hands an app a `content://` URI and expects it to be read through a
 * ContentResolver. FACET is a file explorer: every layer under the frontend --
 * the scanner, the thumbnailer, ffmpeg, the editors -- takes an absolute path
 * on disk, because that is what a file manager *is*. So the entire job of this
 * file is to turn what the system gives us into a path, and to refuse to guess
 * when it cannot.
 *
 * The ladder, cheapest and most honest first:
 *
 *  1. `file://` -- already a path. This is what most file managers send.
 *  2. `content://com.android.externalstorage.documents/...` -- the Storage
 *     Access Framework's own document id is `primary:DCIM/x.jpg`, which is a
 *     path relative to the volume root and needs no query at all.
 *  3. `content://media/...` -- MediaStore's `_data` column is the real path.
 *     Deprecated since API 29 and *still* populated on every device this app
 *     has run on; when it is not, the next rung catches it.
 *  4. Anything else -- a Drive file, a mail attachment, another app's private
 *     cache -- has no path, and never will. Copy the bytes into our own cache
 *     and hand back that path. The copy is real, so every tool works on it;
 *     it lives in `cacheDir` so the system can reclaim it, and stale copies
 *     are pruned on the way in.
 *
 * The result is a queue rather than a single slot: a "share 12 photos" intent
 * is twelve paths, and two intents can land before the WebView has polled once.
 * `take` drains it. Rust (`openwith.rs`) polls; nothing here calls into the
 * frontend, so there is no lifecycle race to lose -- a path that arrives while
 * the WebView is still booting simply waits in the queue.
 */
object OpenBridge {
  private val queue = ConcurrentLinkedQueue<String>()

  /** Copies of un-pathable content live here, under `cacheDir`. */
  private const val INBOX = "opened"

  /** A copy older than this is nobody's working file any more. */
  private const val STALE_MS = 24L * 60L * 60L * 1000L

  /** Refuse to copy something that is not a file the user meant to open. */
  private const val COPY_CAP = 512L * 1024L * 1024L

  /**
   * Take everything an incoming intent points at and queue it as paths.
   *
   * Safe to call with any intent, including the plain launcher one -- an
   * intent that carries nothing openable queues nothing. Never throws: a
   * failure here would crash the activity on launch, and the correct
   * behaviour when we cannot resolve a URI is simply to open the gallery.
   */
  @JvmStatic
  fun offer(ctx: Context, intent: Intent?) {
    if (intent == null) return
    try {
      val uris = urisOf(intent)
      if (uris.isEmpty()) return
      prune(ctx)
      for (u in uris) {
        val p = resolve(ctx, u) ?: continue
        queue.add(p)
      }
    } catch (_: Throwable) {
    }
  }

  /**
   * Drain the queue as a JSON array of absolute paths, or null when empty.
   *
   * Null rather than `[]` so the polling side can tell "nothing happened"
   * from "something happened" without parsing, which is the common case
   * several times a minute for the whole life of the process.
   */
  @JvmStatic
  fun take(): String? {
    if (queue.isEmpty()) return null
    val out = JSONArray()
    while (true) {
      val p = queue.poll() ?: break
      out.put(p)
    }
    if (out.length() == 0) return null
    return out.toString()
  }

  /** Every URI an intent points at, whatever shape it arrived in. */
  private fun urisOf(intent: Intent): List<Uri> {
    val out = ArrayList<Uri>()
    when (intent.action) {
      Intent.ACTION_VIEW, Intent.ACTION_EDIT, "android.intent.action.QUICK_VIEW" -> {
        intent.data?.let { out.add(it) }
      }
      Intent.ACTION_SEND -> {
        streamExtra(intent)?.let { out.add(it) }
      }
      Intent.ACTION_SEND_MULTIPLE -> {
        val list = if (Build.VERSION.SDK_INT >= 33) {
          intent.getParcelableArrayListExtra(Intent.EXTRA_STREAM, Uri::class.java)
        } else {
          @Suppress("DEPRECATION")
          intent.getParcelableArrayListExtra<Uri>(Intent.EXTRA_STREAM)
        }
        if (list != null) out.addAll(list.filterNotNull())
      }
      else -> return out
    }
    // `ClipData` is the modern carrier and some senders fill only it. Adding
    // it unconditionally would double every ordinary share, since the system
    // mirrors EXTRA_STREAM into it -- so it is a fallback, not a supplement.
    if (out.isEmpty()) {
      val clip = intent.clipData
      if (clip != null) {
        for (i in 0 until clip.itemCount) {
          clip.getItemAt(i)?.uri?.let { out.add(it) }
        }
      }
    }
    return out
  }

  private fun streamExtra(intent: Intent): Uri? =
    if (Build.VERSION.SDK_INT >= 33) {
      intent.getParcelableExtra(Intent.EXTRA_STREAM, Uri::class.java)
    } else {
      @Suppress("DEPRECATION")
      intent.getParcelableExtra<Uri>(Intent.EXTRA_STREAM)
    }

  /** One URI to one absolute path, or null when there is nothing to open. */
  private fun resolve(ctx: Context, uri: Uri): String? {
    when (uri.scheme?.lowercase()) {
      "file" -> {
        val p = uri.path ?: return null
        return if (File(p).isFile) p else null
      }
      "content" -> {}
      else -> return null
    }

    docPath(uri)?.let { if (File(it).isFile) return it }
    dataColumn(ctx, uri)?.let { if (File(it).isFile) return it }
    return copyIn(ctx, uri)
  }

  /**
   * The Storage Access Framework's own answer, with no query.
   *
   * `primary:DCIM/Camera/x.jpg` is a path relative to the shared volume, and
   * `raw:/storage/emulated/0/x.jpg` is a path outright. A non-primary volume
   * id (an SD card's `1A2B-3C4D:`) is left to the next rung: guessing
   * `/storage/<id>/` is right often enough to be dangerous and wrong often
   * enough to matter.
   *
   * MediaDocuments (`content://com.android.providers.media.documents/...`)
   * carry `image:1234`, which is a MediaStore row id, so it is turned back
   * into a media URI and answered by the `_data` rung.
   */
  private fun docPath(uri: Uri): String? {
    val id = try {
      DocumentsContract.getDocumentId(uri)
    } catch (_: Throwable) {
      return null
    } ?: return null

    if (uri.authority == "com.android.externalstorage.documents") {
      val cut = id.indexOf(':')
      if (cut < 0) return null
      val volume = id.substring(0, cut)
      val rel = id.substring(cut + 1)
      if (volume.equals("raw", ignoreCase = true)) return rel
      if (!volume.equals("primary", ignoreCase = true)) return null
      val root = Environment.getExternalStorageDirectory() ?: return null
      return File(root, rel).absolutePath
    }
    return null
  }

  /**
   * MediaStore's `_data`, for the URI itself or for the row a MediaDocuments
   * id names. Deprecated, not removed, and still the only thing that turns a
   * gallery pick into a path the rest of the app can use.
   */
  private fun dataColumn(ctx: Context, uri: Uri): String? {
    val target = mediaUri(uri) ?: uri
    @Suppress("DEPRECATION")
    val col = MediaStore.MediaColumns.DATA
    return try {
      ctx.contentResolver.query(target, arrayOf(col), null, null, null)?.use { c ->
        if (!c.moveToFirst()) return null
        val i = c.getColumnIndex(col)
        if (i < 0) return null
        c.getString(i)?.takeIf { it.isNotEmpty() }
      }
    } catch (_: Throwable) {
      null
    }
  }

  /** `image:1234` from the media documents provider back to a media row URI. */
  private fun mediaUri(uri: Uri): Uri? {
    if (uri.authority != "com.android.providers.media.documents") return null
    val id = try { DocumentsContract.getDocumentId(uri) } catch (_: Throwable) { null } ?: return null
    val cut = id.indexOf(':')
    if (cut < 0) return null
    val row = id.substring(cut + 1).toLongOrNull() ?: return null
    val base = when (id.substring(0, cut)) {
      "image" -> MediaStore.Images.Media.EXTERNAL_CONTENT_URI
      "video" -> MediaStore.Video.Media.EXTERNAL_CONTENT_URI
      "audio" -> MediaStore.Audio.Media.EXTERNAL_CONTENT_URI
      "document" -> MediaStore.Files.getContentUri("external")
      else -> return null
    }
    return ContentUris.withAppendedId(base, row)
  }

  /**
   * The last rung: copy the bytes somewhere they have a path.
   *
   * This is the honest answer for a Drive file or a mail attachment, which
   * genuinely do not exist on this disk. The copy is named after the sender's
   * display name so the app shows what the user expects to see, sanitised so
   * a hostile name cannot climb out of the inbox directory.
   */
  private fun copyIn(ctx: Context, uri: Uri): String? {
    val dir = File(ctx.cacheDir, INBOX)
    if (!dir.isDirectory && !dir.mkdirs()) return null

    val name = safeName(displayName(ctx, uri) ?: "opened")
    // A second open of the same attachment must not overwrite a file the user
    // may still be looking at, and must not collide with a different one.
    var out = File(dir, name)
    var n = 1
    while (out.exists()) {
      val dot = name.lastIndexOf('.')
      val stem = if (dot > 0) name.substring(0, dot) else name
      val ext = if (dot > 0) name.substring(dot) else ""
      out = File(dir, "$stem-$n$ext")
      n += 1
      if (n > 999) return null
    }

    return try {
      var written = 0L
      ctx.contentResolver.openInputStream(uri)?.use { input ->
        out.outputStream().use { sink ->
          val buf = ByteArray(64 * 1024)
          while (true) {
            val r = input.read(buf)
            if (r <= 0) break
            written += r
            // A provider can stream forever; a file explorer opening one
            // should not fill the user's storage to find that out.
            if (written > COPY_CAP) throw java.io.IOException("too large")
            sink.write(buf, 0, r)
          }
        }
      } ?: return null
      if (written <= 0L) {
        out.delete()
        null
      } else {
        out.absolutePath
      }
    } catch (_: Throwable) {
      // A partial copy is worse than none: it opens, and shows a truncated
      // picture with no hint that it is truncated.
      try { out.delete() } catch (_: Throwable) {}
      null
    }
  }

  private fun displayName(ctx: Context, uri: Uri): String? = try {
    ctx.contentResolver
      .query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)
      ?.use { c ->
        if (!c.moveToFirst()) null
        else {
          val i = c.getColumnIndex(OpenableColumns.DISPLAY_NAME)
          if (i < 0) null else c.getString(i)?.takeIf { it.isNotBlank() }
        }
      }
  } catch (_: Throwable) {
    null
  } ?: uri.lastPathSegment?.substringAfterLast('/')?.takeIf { it.isNotBlank() }

  /**
   * A file name, and only a file name.
   *
   * Separators, `..` and control characters all go: the name arrives from
   * another app, and this one is about to write it inside its own cache.
   */
  private fun safeName(raw: String): String {
    val cleaned = raw
      .replace('\\', '_')
      .replace('/', '_')
      .filter { it.code >= 0x20 && it.code != 0x7f }
      .trim()
      .trimStart('.')
    val name = if (cleaned.isBlank()) "opened" else cleaned
    return if (name.length <= 120) name else name.takeLast(120)
  }

  /** Drop yesterday's copies. Cheap, and it runs only when an intent lands. */
  private fun prune(ctx: Context) {
    try {
      val dir = File(ctx.cacheDir, INBOX)
      val now = System.currentTimeMillis()
      for (f in dir.listFiles() ?: return) {
        if (f.isFile && now - f.lastModified() > STALE_MS) f.delete()
      }
    } catch (_: Throwable) {
    }
  }
}
