package com.iraslabs.facet

import android.content.ContentUris
import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.ImageDecoder
import android.graphics.Matrix
import android.media.ExifInterface
import android.media.MediaMetadataRetriever
import android.net.Uri
import android.os.Build
import android.provider.MediaStore
import android.util.Size
import java.io.ByteArrayOutputStream
import java.io.File
import java.util.concurrent.ConcurrentHashMap

/**
 * Thumbnails the way the phone's own gallery gets them.
 *
 * Called from Rust (thumbs.rs) over JNI on a blocking-pool thread, one path at
 * a time. Everything Android-specific stays here; the Rust side only sees a
 * JPEG byte array or null.
 *
 * Three rungs, fastest first:
 *   1. MediaStore. `ContentResolver.loadThumbnail` (API 29+) hands back the
 *      thumbnail the system's MediaProvider already keeps for every indexed
 *      picture and clip -- upright, sized, and usually a cache hit measured in
 *      single-digit milliseconds. This is what Samsung Gallery scrolls on.
 *   2. Decode it ourselves. A file MediaStore has not indexed yet (just saved,
 *      or in a folder with a .nomedia) is decoded with `ImageDecoder` at a
 *      target sample size -- the codec scales while decoding, so the
 *      full-size surface is never allocated, and EXIF orientation is applied
 *      for free. Covers HEIC too, which the WebView cannot decode at all.
 *   3. For a clip, `MediaMetadataRetriever` pulls one scaled frame at one
 *      second -- the first frame of a phone video is very often the shutter's
 *      black frame.
 *
 * Any failure is `null`: the caller has slower paths of its own and a chip.
 */
object ThumbBridge {
  private const val JPEG_QUALITY = 80

  /** Absolute path -> MediaStore content URI, filled lazily in one query. */
  private val ids = ConcurrentHashMap<String, Uri>()
  @Volatile private var mapped = false
  private val mapLock = Any()

  /**
   * One JPEG of `path`, long edge about `px`, or null.
   *
   * `video` is a hint from the caller's extension table; MediaStore decides
   * for itself, the hint only picks the fallback decoder.
   */
  @JvmStatic
  fun load(ctx: Context, path: String, px: Int, video: Boolean): ByteArray? {
    val bmp = try {
      fromMediaStore(ctx, path, px)
        ?: (if (video) frameOf(path, px) else decodeFile(path, px))
    } catch (_: Throwable) {
      null
    } ?: return null
    return try {
      encode(bmp, px)
    } catch (_: Throwable) {
      null
    } finally {
      bmp.recycle()
    }
  }

  private fun fromMediaStore(ctx: Context, path: String, px: Int): Bitmap? {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) return null
    val uri = uriFor(ctx, path) ?: return null
    return try {
      ctx.contentResolver.loadThumbnail(uri, Size(px, px), null)
    } catch (_: Throwable) {
      // Not indexed, indexed under a stale row, or the provider refused.
      // Nothing to learn from which; the local decoders take over.
      null
    }
  }

  /**
   * The MediaStore row for a path.
   *
   * The whole roll is mapped in one query the first time anything asks --
   * ten thousand rows is a few tens of milliseconds, and it turns every
   * later lookup into a hash probe. A path missing from the map gets one
   * targeted query, so a photo taken after launch still resolves.
   */
  private fun uriFor(ctx: Context, path: String): Uri? {
    val canon = try { File(path).canonicalPath } catch (_: Throwable) { path }
    ids[canon]?.let { return it }
    ids[path]?.let { return it }
    if (!mapped) {
      synchronized(mapLock) {
        if (!mapped) {
          mapAll(ctx)
          mapped = true
        }
      }
      ids[canon]?.let { return it }
      ids[path]?.let { return it }
    }
    return queryOne(ctx, canon) ?: queryOne(ctx, path)
  }

  private val files: Uri = MediaStore.Files.getContentUri("external")

  private fun mapAll(ctx: Context) {
    val proj = arrayOf(
      MediaStore.Files.FileColumns._ID,
      MediaStore.Files.FileColumns.DATA,
      MediaStore.Files.FileColumns.MEDIA_TYPE,
    )
    val sel = "${MediaStore.Files.FileColumns.MEDIA_TYPE} IN (?, ?)"
    val args = arrayOf(
      MediaStore.Files.FileColumns.MEDIA_TYPE_IMAGE.toString(),
      MediaStore.Files.FileColumns.MEDIA_TYPE_VIDEO.toString(),
    )
    try {
      ctx.contentResolver.query(files, proj, sel, args, null)?.use { c ->
        val idCol = c.getColumnIndexOrThrow(MediaStore.Files.FileColumns._ID)
        val dataCol = c.getColumnIndexOrThrow(MediaStore.Files.FileColumns.DATA)
        val typeCol = c.getColumnIndexOrThrow(MediaStore.Files.FileColumns.MEDIA_TYPE)
        while (c.moveToNext()) {
          val data = c.getString(dataCol) ?: continue
          ids[data] = uriOf(c.getLong(idCol), c.getInt(typeCol))
        }
      }
    } catch (_: Throwable) {
      // No permission yet, or the provider is mid-rescan. Lookups fall back
      // to single queries and the map is retried next launch.
    }
  }

  private fun queryOne(ctx: Context, path: String): Uri? {
    val proj = arrayOf(MediaStore.Files.FileColumns._ID, MediaStore.Files.FileColumns.MEDIA_TYPE)
    return try {
      ctx.contentResolver.query(
        files, proj, "${MediaStore.Files.FileColumns.DATA} = ?", arrayOf(path), null,
      )?.use { c ->
        if (!c.moveToFirst()) return null
        val uri = uriOf(c.getLong(0), c.getInt(1))
        ids[path] = uri
        uri
      }
    } catch (_: Throwable) {
      null
    }
  }

  /**
   * The typed URI, not the generic files one: `loadThumbnail` on a
   * `MediaStore.Files` URI answers for images but not reliably for video on
   * every OEM build, and the typed collections are what the system gallery
   * itself asks through.
   */
  private fun uriOf(id: Long, type: Int): Uri = when (type) {
    MediaStore.Files.FileColumns.MEDIA_TYPE_VIDEO ->
      ContentUris.withAppendedId(MediaStore.Video.Media.EXTERNAL_CONTENT_URI, id)
    else -> ContentUris.withAppendedId(MediaStore.Images.Media.EXTERNAL_CONTENT_URI, id)
  }

  /** A still, scaled during decode and turned upright. */
  private fun decodeFile(path: String, px: Int): Bitmap? {
    val f = File(path)
    if (!f.isFile) return null
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
      return try {
        ImageDecoder.decodeBitmap(ImageDecoder.createSource(f)) { decoder, info, _ ->
          val long = maxOf(info.size.width, info.size.height)
          if (long > px) decoder.setTargetSampleSize(maxOf(1, long / px))
          decoder.allocator = ImageDecoder.ALLOCATOR_SOFTWARE
          decoder.isMutableRequired = false
        }
      } catch (_: Throwable) {
        null
      }
    }
    // API 24-27: sample-size decode, then EXIF by hand.
    val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
    BitmapFactory.decodeFile(path, bounds)
    val long = maxOf(bounds.outWidth, bounds.outHeight)
    if (long <= 0) return null
    val opts = BitmapFactory.Options().apply {
      inSampleSize = maxOf(1, long / px)
      inPreferredConfig = Bitmap.Config.RGB_565
    }
    val raw = BitmapFactory.decodeFile(path, opts) ?: return null
    val orient = try {
      ExifInterface(path).getAttributeInt(ExifInterface.TAG_ORIENTATION, 1)
    } catch (_: Throwable) { 1 }
    return upright(raw, orient)
  }

  private fun upright(bmp: Bitmap, orientation: Int): Bitmap {
    val m = Matrix()
    when (orientation) {
      ExifInterface.ORIENTATION_ROTATE_90 -> m.postRotate(90f)
      ExifInterface.ORIENTATION_ROTATE_180 -> m.postRotate(180f)
      ExifInterface.ORIENTATION_ROTATE_270 -> m.postRotate(270f)
      ExifInterface.ORIENTATION_FLIP_HORIZONTAL -> m.postScale(-1f, 1f)
      ExifInterface.ORIENTATION_FLIP_VERTICAL -> m.postScale(1f, -1f)
      ExifInterface.ORIENTATION_TRANSPOSE -> { m.postRotate(90f); m.postScale(-1f, 1f) }
      ExifInterface.ORIENTATION_TRANSVERSE -> { m.postRotate(270f); m.postScale(-1f, 1f) }
      else -> return bmp
    }
    val out = Bitmap.createBitmap(bmp, 0, 0, bmp.width, bmp.height, m, true)
    if (out !== bmp) bmp.recycle()
    return out
  }

  /** One frame of a clip, a second in (or the midpoint of a shorter one). */
  private fun frameOf(path: String, px: Int): Bitmap? {
    if (!File(path).isFile) return null
    val mmr = MediaMetadataRetriever()
    try {
      mmr.setDataSource(path)
      val durMs = mmr.extractMetadata(MediaMetadataRetriever.METADATA_KEY_DURATION)?.toLongOrNull() ?: 0L
      val atUs = if (durMs in 1..1999) durMs * 500 else 1_000_000L
      val frame = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O_MR1) {
        mmr.getScaledFrameAtTime(atUs, MediaMetadataRetriever.OPTION_CLOSEST_SYNC, px, px)
      } else {
        mmr.getFrameAtTime(atUs, MediaMetadataRetriever.OPTION_CLOSEST_SYNC)
      }
      // A clip shorter than a second seeks past its own end and gets nothing;
      // the first frame always exists.
      return frame ?: mmr.getFrameAtTime(0, MediaMetadataRetriever.OPTION_CLOSEST_SYNC)
    } catch (_: Throwable) {
      return null
    } finally {
      try { mmr.release() } catch (_: Throwable) {}
    }
  }

  /**
   * JPEG bytes, long edge held to about `px`.
   *
   * MediaStore is allowed to hand back something larger than asked -- it
   * rounds to whatever it has cached -- and a 1024 px tile is four times the
   * bytes the grid can show. Anything past 5/4 of the request is scaled once.
   */
  private fun encode(src: Bitmap, px: Int): ByteArray? {
    var bmp = src
    val long = maxOf(bmp.width, bmp.height)
    if (long > px * 5 / 4) {
      val k = px.toFloat() / long
      val w = maxOf(1, Math.round(bmp.width * k))
      val h = maxOf(1, Math.round(bmp.height * k))
      val scaled = Bitmap.createScaledBitmap(bmp, w, h, true)
      if (scaled !== bmp) {
        bmp.recycle()
        bmp = scaled
      }
    }
    val out = ByteArrayOutputStream(48 * 1024)
    val okay = bmp.compress(Bitmap.CompressFormat.JPEG, JPEG_QUALITY, out)
    if (bmp !== src) bmp.recycle()
    return if (okay && out.size() > 0) out.toByteArray() else null
  }
}
