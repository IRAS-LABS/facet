package com.iraslabs.facet

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.database.ContentObserver
import android.media.MediaScannerConnection
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Environment
import android.os.Handler
import android.os.Looper
import android.provider.MediaStore
import org.json.JSONArray
import org.json.JSONObject
import java.util.ArrayDeque
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicLong

/**
 * The phone's own index of what is on disk, and a doorbell for when it changes.
 *
 * Called from Rust (media.rs) over JNI. Two jobs:
 *
 *  1. `query` pages through MediaStore.Files on the external volume(s) -- every
 *     row, not just pictures: images, video, audio, documents, APKs, anything
 *     the system indexer has seen. This is the same index Samsung Gallery
 *     reads, so a folder FACET has never heard of (Tail-drop, a new messenger's
 *     media directory, an SD card) is visible the moment the system knows it.
 *     Pages walk `_id` downwards so the first chunk is the newest files, and a
 *     5k-row library never becomes one giant string.
 *
 *  2. `start` registers a ContentObserver over the media collections. Every
 *     change bumps a generation counter; Rust exposes it as a one-integer
 *     command the frontend polls once a second while visible. Push instead of
 *     stat-walking directories on a timer, and it fires for folders no walk
 *     would ever have reached.
 *
 * Any failure is an empty page or a stale counter; the walk-based fallback on
 * the Rust side keeps the app alive regardless.
 */
object MediaBridge {
  private val generation = AtomicLong(1)
  private val started = AtomicBoolean(false)
  private val recent = ArrayDeque<String>()
  private const val RECENT_CAP = 32

  /**
   * Tell the system indexer about files FACET just wrote, moved or removed.
   *
   * A file written through plain POSIX I/O lands on disk but not in
   * MediaStore until the next full media scan, so Samsung Gallery (and every
   * other app that reads the index) does not see it -- possibly for days.
   * `scanFile` indexes each path at once; a path that no longer exists is
   * dropped from the index the same way. `json` is a JSON array of absolute
   * paths. Asynchronous and fire-and-forget: the observer above fires when the
   * scan lands, which is how FACET's own roll learns about it too.
   */
  @JvmStatic
  fun scan(ctx: Context, json: String) {
    val paths = try {
      val a = JSONArray(json)
      Array(a.length()) { a.getString(it) }
    } catch (_: Throwable) { return }
    if (paths.isEmpty()) return
    try {
      MediaScannerConnection.scanFile(ctx.applicationContext, paths, null, null)
    } catch (_: Throwable) {}
  }

  /** Register the observers. Idempotent; safe to call from onCreate every time. */
  @JvmStatic
  fun start(ctx: Context) {
    if (!started.compareAndSet(false, true)) return
    val app = ctx.applicationContext
    val observer = object : ContentObserver(Handler(Looper.getMainLooper())) {
      override fun onChange(selfChange: Boolean) = onChange(selfChange, null)
      override fun onChange(selfChange: Boolean, uri: Uri?) {
        generation.incrementAndGet()
        if (uri != null) synchronized(recent) {
          if (recent.size >= RECENT_CAP) recent.pollFirst()
          recent.addLast(uri.toString())
        }
      }
    }
    val uris = mutableListOf(
      MediaStore.Files.getContentUri("external"),
      MediaStore.Images.Media.EXTERNAL_CONTENT_URI,
      MediaStore.Video.Media.EXTERNAL_CONTENT_URI,
      MediaStore.Audio.Media.EXTERNAL_CONTENT_URI,
    )
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
      uris += MediaStore.Downloads.EXTERNAL_CONTENT_URI
    }
    for (u in uris) {
      try {
        app.contentResolver.registerContentObserver(u, true, observer)
      } catch (_: Exception) {
      }
    }
  }

  /** `{"gen":N,"changed":[uri,...]}`; the changed list is drained on read. */
  @JvmStatic
  fun pulse(): String {
    val out = JSONObject()
    out.put("gen", generation.get())
    val arr = JSONArray()
    synchronized(recent) {
      while (recent.isNotEmpty()) arr.put(recent.pollFirst())
    }
    out.put("changed", arr)
    return out.toString()
  }

  /**
   * One page of the index, newest `_id` first.
   *
   * @param beforeId  only rows with `_id` strictly below this; 0 means start.
   * @param limit     rows per page.
   * @return `{"rows":[...],"next":id|-1,"access":"full"|"partial"|"none"}`
   *         where `next` is the cursor for the following page, -1 when done.
   */
  @JvmStatic
  fun query(ctx: Context, beforeId: Long, limit: Int): String {
    val out = JSONObject()
    val rows = JSONArray()
    var next = -1L
    val lim = limit.coerceIn(1, 5000)
    val projection = projection()
    val uri = MediaStore.Files.getContentUri("external")
    val selection = if (beforeId > 0) "${MediaStore.Files.FileColumns._ID} < ?" else null
    val args = if (beforeId > 0) arrayOf(beforeId.toString()) else null
    val sort = "${MediaStore.Files.FileColumns._ID} DESC"
    try {
      val cursor = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
        val b = Bundle()
        if (selection != null) {
          b.putString(android.content.ContentResolver.QUERY_ARG_SQL_SELECTION, selection)
          b.putStringArray(android.content.ContentResolver.QUERY_ARG_SQL_SELECTION_ARGS, args)
        }
        b.putString(android.content.ContentResolver.QUERY_ARG_SQL_SORT_ORDER, sort)
        b.putInt(android.content.ContentResolver.QUERY_ARG_LIMIT, lim)
        // The provider's default already hides pending and trashed rows; say so
        // explicitly rather than depend on a default that has moved before.
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
          b.putInt(MediaStore.QUERY_ARG_MATCH_PENDING, MediaStore.MATCH_EXCLUDE)
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
          b.putInt(MediaStore.QUERY_ARG_MATCH_TRASHED, MediaStore.MATCH_EXCLUDE)
        }
        ctx.contentResolver.query(uri, projection, b, null)
      } else {
        ctx.contentResolver.query(uri, projection, selection, args, "$sort LIMIT $lim")
      }
      cursor?.use { c ->
        val iId = c.getColumnIndex(MediaStore.Files.FileColumns._ID)
        val iData = c.getColumnIndex(MediaStore.Files.FileColumns.DATA)
        val iSize = c.getColumnIndex(MediaStore.Files.FileColumns.SIZE)
        val iAdded = c.getColumnIndex(MediaStore.Files.FileColumns.DATE_ADDED)
        val iMod = c.getColumnIndex(MediaStore.Files.FileColumns.DATE_MODIFIED)
        val iTaken = c.getColumnIndex("datetaken")
        val iMime = c.getColumnIndex(MediaStore.Files.FileColumns.MIME_TYPE)
        val iType = c.getColumnIndex(MediaStore.Files.FileColumns.MEDIA_TYPE)
        val iW = c.getColumnIndex("width")
        val iH = c.getColumnIndex("height")
        val iDur = c.getColumnIndex("duration")
        val iBucket = c.getColumnIndex("bucket_display_name")
        val iFormat = c.getColumnIndex("format")
        val iPending = c.getColumnIndex("is_pending")
        val iTrashed = c.getColumnIndex("is_trashed")
        var seen = 0
        while (c.moveToNext()) {
          seen += 1
          val id = if (iId >= 0) c.getLong(iId) else 0L
          if (id > 0) next = id
          val path = if (iData >= 0 && !c.isNull(iData)) c.getString(iData) else null
          if (path.isNullOrEmpty()) continue
          // A folder is a row too (MTP "association" format); it is not a file.
          // A row the indexer calls a picture or a clip is never a folder,
          // whatever its format column says, so only unclassified rows go.
          val mediaType = if (iType >= 0 && !c.isNull(iType)) c.getInt(iType) else 0
          if (iFormat >= 0 && !c.isNull(iFormat) && c.getInt(iFormat) == 0x3001 && mediaType != 1 && mediaType != 3) continue
          // Half-written by another app, or in the system trash: not a file the
          // user can see anywhere else, so not one here. Reported rather than
          // dropped so the frontend rule is the same one the harness checks.
          val pending = iPending >= 0 && !c.isNull(iPending) && c.getInt(iPending) != 0
          val trashed = iTrashed >= 0 && !c.isNull(iTrashed) && c.getInt(iTrashed) != 0
          val row = JSONObject()
          row.put("id", id)
          row.put("path", path)
          if (pending) row.put("pending", true)
          if (trashed) row.put("trashed", true)
          if (iSize >= 0 && !c.isNull(iSize)) row.put("size", c.getLong(iSize))
          if (iAdded >= 0 && !c.isNull(iAdded)) row.put("added", c.getLong(iAdded) * 1000)
          if (iMod >= 0 && !c.isNull(iMod)) row.put("modified", c.getLong(iMod) * 1000)
          if (iTaken >= 0 && !c.isNull(iTaken)) {
            val t = c.getLong(iTaken)
            if (t > 0) row.put("taken", t)
          }
          if (iMime >= 0 && !c.isNull(iMime)) row.put("mime", c.getString(iMime))
          if (iType >= 0 && !c.isNull(iType)) row.put("mediaType", mediaType)
          if (iW >= 0 && !c.isNull(iW)) row.put("width", c.getInt(iW))
          if (iH >= 0 && !c.isNull(iH)) row.put("height", c.getInt(iH))
          if (iDur >= 0 && !c.isNull(iDur)) {
            val d = c.getLong(iDur)
            if (d > 0) row.put("duration", d / 1000.0)
          }
          if (iBucket >= 0 && !c.isNull(iBucket)) row.put("bucket", c.getString(iBucket))
          rows.put(row)
        }
        // A short page means the index is exhausted.
        if (seen < lim) next = -1L
      }
    } catch (e: Exception) {
      out.put("error", e.toString())
      next = -1L
    }
    out.put("rows", rows)
    out.put("next", next)
    out.put("access", access(ctx))
    return out.toString()
  }

  private fun projection(): Array<String> {
    val cols = mutableListOf(
      MediaStore.Files.FileColumns._ID,
      MediaStore.Files.FileColumns.DATA,
      MediaStore.Files.FileColumns.SIZE,
      MediaStore.Files.FileColumns.DATE_ADDED,
      MediaStore.Files.FileColumns.DATE_MODIFIED,
      MediaStore.Files.FileColumns.MIME_TYPE,
      MediaStore.Files.FileColumns.MEDIA_TYPE,
      // These have lived on the files table for years under these names; the
      // typed constants only reached MediaColumns in API 29.
      "datetaken",
      "width",
      "height",
      "duration",
      "bucket_display_name",
      "format",
    )
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) cols += "is_pending"
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) cols += "is_trashed"
    return cols.toTypedArray()
  }

  /**
   * "full" when the app can see everything, "partial" for Android 14's
   * "select photos" grant, "none" when it holds no media permission at all.
   * The frontend uses this only to word its empty state honestly.
   */
  private fun access(ctx: Context): String {
    fun has(p: String) = ctx.checkSelfPermission(p) == PackageManager.PERMISSION_GRANTED
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R && Environment.isExternalStorageManager()) return "full"
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
      val images = has(Manifest.permission.READ_MEDIA_IMAGES)
      val video = has(Manifest.permission.READ_MEDIA_VIDEO)
      if (images && video) return "full"
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE &&
        has(Manifest.permission.READ_MEDIA_VISUAL_USER_SELECTED)) return "partial"
      return if (images || video) "partial" else "none"
    }
    return if (has(Manifest.permission.READ_EXTERNAL_STORAGE)) "full" else "none"
  }
}
