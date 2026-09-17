package com.iraslabs.facet

import android.Manifest
import android.app.Activity
import android.content.Context
import android.content.pm.PackageManager
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Matrix
import android.graphics.Paint
import android.graphics.Rect
import android.graphics.RectF
import android.graphics.SurfaceTexture
import android.hardware.camera2.CameraCaptureSession
import android.hardware.camera2.CameraCharacteristics
import android.hardware.camera2.CameraDevice
import android.hardware.camera2.CameraManager
import android.hardware.camera2.CaptureRequest
import android.hardware.camera2.TotalCaptureResult
import android.media.ImageReader
import android.media.MediaRecorder
import android.os.Build
import android.os.Handler
import android.os.HandlerThread
import android.util.Log
import android.util.Size
import android.view.Surface
import android.view.TextureView
import android.view.ViewGroup
import android.webkit.WebView
import android.widget.FrameLayout
import androidx.core.content.ContextCompat
import java.io.File
import java.util.concurrent.ArrayBlockingQueue
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Future
import java.util.concurrent.FutureTask
import java.util.concurrent.TimeUnit
import org.json.JSONArray

/**
 * Both cameras at once, which the web layer cannot do at all.
 *
 * `getUserMedia` opens one camera per process on Android -- ask for a second
 * and Chromium answers `NotReadableError` -- so a dual viewfinder cannot be
 * built out of two video elements no matter how the page is written. Camera2
 * has the concurrent API underneath, and on this hardware it is real: an S21+
 * reports the pairs {0,1} and {0,3}, which is the main 5.4 mm rear lens beside
 * a front one, and will run both at 1920x1440 each.
 *
 * That ceiling is the price. A single camera here shoots 4032x3024; two
 * sharing the pipeline are capped at 1920x1440 apiece, and no amount of code
 * moves that -- it is why Samsung's own dual mode is not full resolution
 * either. Everything else about dual mode is ordinary; only this is a loss,
 * and the frontend says so rather than quietly shooting small.
 *
 * The preview deliberately does not travel through the web bridge. Two of
 * these streams pushed to JavaScript as data URLs is megabytes a second of
 * base64 through a channel meant for messages, and it looks like what it is.
 * The frames go straight to two `TextureView`s parked behind a transparent
 * WebView, so the pixels never leave the native side and the page draws only
 * the controls on top.
 *
 * Which leaves the page in charge of where they go, and that is deliberate
 * too. The page is the only layer that knows the screen, the safe areas and
 * where its own controls are -- and since it sits on top, it is the only layer
 * that receives a tap at all. So it does not ask for "picture-in-picture" or
 * "split"; it says where each camera's rectangle is. Picture-in-picture,
 * half-and-half, dragging the divider and swapping the two are then the same
 * one call with different numbers, which is why there is no swap function.
 */
object DualBridge {
  private const val TAG = "FacetDual"

  /** What two cameras at once are allowed to be, on this device. */
  private val CAP = Size(1920, 1440)

  /** Largest picture to write out; beyond this is pixels nobody asked for. */
  private const val OUT_MAX = 2160

  /**
   * How big a combined video may be, in pixels of frame.
   *
   * This phone's ffmpeg has no hardware encoder -- `-encoders` lists libx264
   * and nothing else -- so every frame of the combined file is rotated, scaled
   * and compressed on the CPU. At 1080x2400 that runs at about half real time,
   * so ten seconds of filming costs twenty of waiting, which is a progress bar.
   * At the 1440x3200 the sensors would otherwise justify it is four times the
   * work, which is a minute and a half for the same ten seconds, and nobody
   * waits for that. The cap is on area rather than on either side, so an
   * unusual layout is bounded by the same rule as an ordinary one.
   */
  private const val VID_PIXELS = 1080 * 2400
  private const val VID_SIDE = 2560

  private var host: FrameLayout? = null
  private var page: WebView? = null
  private var act: Activity? = null

  private var mgr: CameraManager? = null
  private val cams = HashMap<String, CameraDevice>()
  private val sessions = HashMap<String, CameraCaptureSession>()
  private val readers = HashMap<String, ImageReader>()
  private val views = HashMap<String, TextureView>()
  private val sizes = HashMap<String, Size>()
  private val surfs = HashMap<String, Surface>()
  private val recs = HashMap<String, MediaRecorder>()
  private val clips = HashMap<String, File>()

  /** The live combiner and its one recorder, while a combined recording runs. */
  private var mixer: DualMixer? = null
  private var mixRec: MediaRecorder? = null
  private var mixOut: File? = null

  /** Set while both cameras are recording, so a second tap does not restart. */
  @Volatile private var taping = false
  private var tapeStart = 0L

  /** Where each camera is drawn, in device pixels, as the page last said. */
  private val spots = HashMap<String, Spot>()

  private var thread: HandlerThread? = null
  private var hand: Handler? = null

  @Volatile private var live = false

  /** The pair this device will actually run together: rear first, front second. */
  private var pair: List<String> = emptyList()

  /** A camera's rectangle on screen, and what it sits above. */
  private data class Spot(val x: Int, val y: Int, val w: Int, val h: Int, val z: Int)

  // -- wiring ---------------------------------------------------------------

  /**
   * Take a reference to the view tree, without building anything yet.
   *
   * Called from `MainActivity.onWebViewCreate`. Dual mode may never be opened
   * in a given run of the app, and two `TextureView`s and a camera thread are
   * not the sort of thing to allocate on the chance that it is.
   */
  @JvmStatic
  fun attach(activity: Activity, webView: WebView) {
    act = activity
    page = webView
  }

  /** Whether this device can run two cameras together at all. */
  @JvmStatic
  fun available(ctx: Context): Boolean = findPair(ctx).size == 2

  /** Whether the dual preview is up right now. */
  @JvmStatic
  fun running(): Boolean = live

  /**
   * The pair to use: a rear camera and a front one the driver lists as
   * concurrently openable.
   *
   * A device may offer several pairs -- an S21+ offers the main rear lens with
   * either front camera -- and they are not equally good. Android requires
   * camera 0 to be the primary rear and 1 the primary front, so the pair with
   * the smallest ids is the pair of main lenses rather than an ultrawide and a
   * depth sensor.
   */
  private fun findPair(ctx: Context): List<String> {
    if (pair.size == 2) return pair
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R) return emptyList()
    val m = ctx.getSystemService(Context.CAMERA_SERVICE) as CameraManager
    val best = try {
      m.concurrentCameraIds
        .map { it.toList() }
        .filter { set ->
          set.size == 2 &&
            set.any { facing(m, it) == CameraCharacteristics.LENS_FACING_BACK } &&
            set.any { facing(m, it) == CameraCharacteristics.LENS_FACING_FRONT }
        }
        .minByOrNull { it.mapNotNull(String::toIntOrNull).sum() }
    } catch (e: Throwable) {
      Log.w(TAG, "concurrent query failed: ${e.message}")
      null
    } ?: return emptyList()

    val back = best.first { facing(m, it) == CameraCharacteristics.LENS_FACING_BACK }
    val front = best.first { facing(m, it) == CameraCharacteristics.LENS_FACING_FRONT }
    pair = listOf(back, front)
    Log.i(TAG, "concurrent pair back=$back front=$front")
    return pair
  }

  private fun facing(m: CameraManager, id: String): Int? =
    try {
      m.getCameraCharacteristics(id).get(CameraCharacteristics.LENS_FACING)
    } catch (_: Throwable) {
      null
    }

  private fun isFront(id: String): Boolean = pair.size == 2 && id == pair[1]

  // -- opening --------------------------------------------------------------

  /**
   * Bring both cameras up behind the page.
   *
   * Returns an empty string on success, or a sentence explaining why not --
   * the frontend shows it and falls back to the ordinary one-camera view,
   * which is a far better outcome than a black rectangle.
   */
  @JvmStatic
  fun start(): String {
    val a = act ?: return "The camera view is not ready yet."
    if (live) return ""
    val ids = findPair(a)
    if (ids.size != 2) return "This phone cannot run both cameras at once."
    if (ContextCompat.checkSelfPermission(a, Manifest.permission.CAMERA)
      != PackageManager.PERMISSION_GRANTED
    ) {
      return "Facet needs camera permission for dual view."
    }

    mgr = a.getSystemService(Context.CAMERA_SERVICE) as CameraManager
    val t = HandlerThread("facet-dual").apply { start() }
    thread = t
    hand = Handler(t.looper)

    val err = StringBuilder()
    // Two surfaces have to exist before either camera is opened, and a
    // `TextureView` does not have one until the compositor has laid it out and
    // called back. Adding the views and reading `surfaceTexture` on the next
    // line reads null every time; the camera then opens onto nothing and the
    // failure looks like a driver problem rather than a timing one.
    val ready = CountDownLatch(2)
    a.runOnUiThread {
      try {
        buildViews(a, ids, ready)
      } catch (e: Throwable) {
        err.append(e.message ?: e.javaClass.simpleName)
        while (ready.count > 0) ready.countDown()
      }
    }
    if (!ready.await(4, TimeUnit.SECONDS)) return "The dual preview surfaces never came up."
    if (err.isNotEmpty()) return "Could not place the dual preview. $err"

    live = true
    // Rear first. If the front then refuses, the rear is already up and the
    // failure is a message rather than a dead screen.
    for (id in ids) {
      val why = open(id)
      if (why.isNotEmpty()) {
        stop()
        return why
      }
    }
    return ""
  }

  private fun open(id: String): String {
    val m = mgr ?: return "No camera service."
    val done = Object()
    var fail = ""
    var got = false
    try {
      @Suppress("MissingPermission")
      m.openCamera(id, object : CameraDevice.StateCallback() {
        override fun onOpened(device: CameraDevice) {
          cams[id] = device
          got = true
          synchronized(done) { done.notifyAll() }
        }

        override fun onDisconnected(device: CameraDevice) {
          device.close()
          cams.remove(id)
          fail = "Camera $id was taken by another app."
          synchronized(done) { done.notifyAll() }
        }

        override fun onError(device: CameraDevice, error: Int) {
          device.close()
          cams.remove(id)
          fail = "Camera $id would not open (error $error)."
          synchronized(done) { done.notifyAll() }
        }
      }, hand)
    } catch (e: Throwable) {
      return "Camera $id would not open: ${e.message}"
    }
    synchronized(done) { if (!got && fail.isEmpty()) done.wait(4000) }
    if (!got) return if (fail.isEmpty()) "Camera $id did not answer." else fail
    return preview(id)
  }

  /** One preview stream and one still reader per camera. */
  private fun preview(id: String): String {
    val m = mgr ?: return "No camera service."
    val dev = cams[id] ?: return "Camera $id is not open."
    val view = views[id] ?: return "No surface for camera $id."

    val size = pickSize(m, id)
    sizes[id] = size
    val tex = view.surfaceTexture ?: return "Preview surface for camera $id is not ready."
    tex.setDefaultBufferSize(size.width, size.height)
    val surface = Surface(tex)
    surfs[id] = surface

    // The still reader is configured now, with the preview, rather than when
    // the shutter is pressed. A capture session's outputs are fixed when it is
    // built, so a camera that wants to photograph later has to say so now --
    // and in concurrent mode rebuilding a session means tearing down a working
    // pair of cameras and hoping both come back.
    val still =
      ImageReader.newInstance(size.width, size.height, android.graphics.ImageFormat.JPEG, 2)
    readers[id] = still

    val why = configure(id, still.surface, false)
    if (why.isNotEmpty()) return why

    act?.runOnUiThread { shape(id) }
    Log.i(TAG, "camera $id previewing at ${size.width}x${size.height}")
    return ""
  }

  /**
   * Build one camera's session: the preview, plus one other output.
   *
   * A session's outputs are fixed when it is made, so a camera cannot gain a
   * recorder halfway through -- going from photographing to filming means
   * replacing the session, which is what this is called twice for. The devices
   * themselves stay open throughout, which matters: reopening them would be
   * re-entering concurrent mode, and a phone that is willing to hold two
   * cameras now is not obliged to be willing again half a second later.
   */
  private fun configure(id: String, extra: Surface, record: Boolean): String {
    val dev = cams[id] ?: return "Camera $id is not open."
    val surface = surfs[id] ?: return "Camera $id has no preview surface."
    val done = Object()
    var ok = false
    var fail = ""
    val cb = object : CameraCaptureSession.StateCallback() {
      override fun onConfigured(s: CameraCaptureSession) {
        sessions[id] = s
        try {
          val req = dev.createCaptureRequest(
            if (record) CameraDevice.TEMPLATE_RECORD else CameraDevice.TEMPLATE_PREVIEW
          )
          req.addTarget(surface)
          // The recorder wants every frame; the still reader only wants the
          // ones it is asked for, so it is not a target of the repeating
          // request -- adding it would run the JPEG encoder continuously.
          if (record) req.addTarget(extra)
          req.set(CaptureRequest.CONTROL_AF_MODE, CaptureRequest.CONTROL_AF_MODE_CONTINUOUS_PICTURE)
          s.setRepeatingRequest(req.build(), null, hand)
          ok = true
        } catch (e: Throwable) {
          fail = "Camera $id would not stream: ${e.message}"
        }
        synchronized(done) { done.notifyAll() }
      }

      override fun onConfigureFailed(s: CameraCaptureSession) {
        fail = "Camera $id refused this combination of streams."
        synchronized(done) { done.notifyAll() }
      }
    }

    try {
      @Suppress("DEPRECATION")
      dev.createCaptureSession(listOf(surface, extra), cb, hand)
    } catch (e: Throwable) {
      return "Camera $id would not configure: ${e.message}"
    }
    synchronized(done) { if (!ok && fail.isEmpty()) done.wait(4000) }
    if (!ok) return if (fail.isEmpty()) "Camera $id timed out configuring." else fail
    return ""
  }

  /** The largest preview size this camera may use while another one is running. */
  private fun pickSize(m: CameraManager, id: String): Size {
    val map = try {
      m.getCameraCharacteristics(id)
        .get(CameraCharacteristics.SCALER_STREAM_CONFIGURATION_MAP)
    } catch (_: Throwable) {
      null
    } ?: return Size(1280, 720)
    val all = map.getOutputSizes(SurfaceTexture::class.java) ?: return Size(1280, 720)
    val fit = all.filter { it.width <= CAP.width && it.height <= CAP.height }
    return fit.maxByOrNull { it.width.toLong() * it.height } ?: Size(1280, 720)
  }

  // -- views ----------------------------------------------------------------

  /**
   * One texture view per camera, behind the page.
   *
   * `TextureView` rather than `SurfaceView` because a surface view is punched
   * through the window below everything drawn in it, and the whole point is to
   * have the page's controls on top. A texture view is an ordinary view and
   * layers the way any other one would -- which also means the two of them can
   * be reordered against each other, which is what swapping is.
   */
  private fun buildViews(a: Activity, ids: List<String>, ready: CountDownLatch) {
    val web = page ?: throw IllegalStateException("no web view")
    // The web view's own parent where there is one, and the content frame
    // otherwise. Which it is depends on how far through its setup wry has got
    // when this runs, and guessing wrong draws somewhere invisible.
    val parent = (web.parent as? ViewGroup)
      ?: a.findViewById<ViewGroup>(android.R.id.content)
      ?: throw IllegalStateException("no view tree to draw into")

    val box = FrameLayout(a)
    views.clear()
    for (id in ids) {
      val v = TextureView(a)
      v.surfaceTextureListener = waiter(ready)
      box.addView(v, FrameLayout.LayoutParams(-1, -1))
      views[id] = v
    }

    val at = parent.indexOfChild(web)
    parent.addView(box, if (at >= 0) at else 0, ViewGroup.LayoutParams(-1, -1))
    web.setBackgroundColor(Color.TRANSPARENT)
    host = box

    // Something sensible before the page has said anything: the rear filling
    // the screen with the front in a corner, which is what dual camera means
    // to most people and what it should look like in the half second between
    // the cameras opening and the frontend laying itself out.
    val dm = a.resources.displayMetrics
    val iw = (dm.widthPixels * 0.30f).toInt()
    val pad = (dm.density * 16).toInt()
    spots[ids[0]] = Spot(0, 0, dm.widthPixels, dm.heightPixels, 0)
    spots[ids[1]] = Spot(pad, pad * 6, iw, (iw * 4) / 3, 1)
    applySpots()
  }

  /** Counts a texture view in as soon as it has a surface to draw on. */
  private fun waiter(ready: CountDownLatch) =
    object : TextureView.SurfaceTextureListener {
      override fun onSurfaceTextureAvailable(t: SurfaceTexture, w: Int, h: Int) = ready.countDown()
      override fun onSurfaceTextureSizeChanged(t: SurfaceTexture, w: Int, h: Int) {}
      override fun onSurfaceTextureDestroyed(t: SurfaceTexture): Boolean = true
      override fun onSurfaceTextureUpdated(t: SurfaceTexture) {}
    }

  /**
   * Put each camera where the page says.
   *
   * The spec is a JSON array of `{cam, x, y, w, h, z}` in device pixels, where
   * `cam` is "back" or "front" -- the page thinks in lenses, not in whatever
   * ids this particular phone happened to hand out. Everything a layout can be
   * lives in those numbers: two equal halves, a corner inset, one of them
   * grown under a dragging finger, or the same two rectangles with the `cam`
   * values exchanged, which is what a swap is.
   */
  @JvmStatic
  fun place(spec: String): String {
    if (pair.size != 2) return "No camera pair."
    return try {
      val arr = JSONArray(spec)
      for (i in 0 until arr.length()) {
        val o = arr.getJSONObject(i)
        val id = when (o.optString("cam")) {
          "back" -> pair[0]
          "front" -> pair[1]
          else -> continue
        }
        // Read from the combiner's thread on every frame while filming.
        synchronized(spots) {
          spots[id] = Spot(
            o.optInt("x"),
            o.optInt("y"),
            o.optInt("w").coerceAtLeast(1),
            o.optInt("h").coerceAtLeast(1),
            o.optInt("z"),
          )
        }
      }
      act?.runOnUiThread { applySpots() }
      ""
    } catch (e: Throwable) {
      "Could not read the dual layout: ${e.message}"
    }
  }

  /** Move the views to their rectangles and stack them in the right order. */
  private fun applySpots() {
    val box = host ?: return
    for ((id, spot) in spots.entries.sortedBy { it.value.z }) {
      val v = views[id] ?: continue
      val lp = FrameLayout.LayoutParams(spot.w, spot.h)
      lp.leftMargin = spot.x
      lp.topMargin = spot.y
      v.layoutParams = lp
      // The page draws a rounded outline round the small one; the picture has
      // to follow it or its square corners poke out past the border.
      if (spot.z > 0 && spot.w < box.width) {
        val r = 12f * v.resources.displayMetrics.density
        v.outlineProvider = object : android.view.ViewOutlineProvider() {
          override fun getOutline(view: android.view.View, o: android.graphics.Outline) {
            o.setRoundRect(0, 0, view.width, view.height, r)
          }
        }
        v.clipToOutline = true
      } else {
        v.clipToOutline = false
      }
      v.bringToFront()
      shape(id)
    }
    box.requestLayout()
  }

  /**
   * Fill the view with the frame rather than stretching it to fit.
   *
   * A camera hands back 4:3 and the view is whatever shape the layout asked
   * for; scaling one onto the other squashes faces, which is the most obvious
   * way for a camera app to look wrong.
   *
   * Nothing here rotates or mirrors. Both are already done: a preview surface
   * carries a transform the camera service sets from the display rotation, and
   * for a front camera that transform includes the horizontal flip, which is
   * why every phone's selfie preview is a mirror. Adding a flip on top of it
   * cancels it -- which is exactly what happened here, and showed up as a
   * viewfinder and a saved photograph that disagreed about which way round the
   * room was. The saved frame does its own mirroring, in `upright`, because a
   * still arrives from the reader with no transform attached at all.
   */
  private fun shape(id: String) {
    val view = views[id] ?: return
    val src = sizes[id] ?: return
    val vw = (view.layoutParams?.width ?: view.width).toFloat()
    val vh = (view.layoutParams?.height ?: view.height).toFloat()
    if (vw <= 0f || vh <= 0f) return
    // The driver reports sizes landscape; the frame, once the surface's own
    // transform has run, is upright for the phone's natural way up.
    val sw = src.height.toFloat()
    val sh = src.width.toFloat()
    // That transform knows the sensor but not the screen. Turned sideways, the
    // page is laid out landscape while the frame is still upright for portrait,
    // so it is turned back here -- the same quarter the camera sample code
    // applies -- or the room in the viewfinder lies on its side.
    val turn = screenTurn()
    val cx = vw / 2f
    val cy = vh / 2f
    val shownW = if (turn % 2 == 1) sh else sw
    val shownH = if (turn % 2 == 1) sw else sh
    val scale = maxOf(vw / shownW, vh / shownH)
    val m = Matrix()
    // A texture view stretches the frame to fill it: undo that first, turn it,
    // then scale it up until it covers the view without distorting.
    m.setScale(sw / vw, sh / vh, cx, cy)
    if (turn != 0) m.postRotate(-90f * turn, cx, cy)
    m.postScale(scale, scale, cx, cy)
    view.setTransform(m)
  }

  // -- closing --------------------------------------------------------------

  /** Put both cameras down and give the page its background back. */
  @JvmStatic
  fun stop() {
    live = false
    // A recorder that is released mid-recording leaves an MP4 with no index,
    // which no player will open. Stopping it first costs a moment and turns
    // "the app closed" into two watchable clips. They are not combined here:
    // this runs on the way out, sometimes from `onDestroy`, and ffmpeg takes
    // longer than Android will wait.
    if (taping && mixer != null) {
      // Quick, unlike the old combining: stopping one recorder finishes the
      // file. The cameras are closing, so there is no session to put back.
      stopMixed(restore = false)
    } else if (taping) {
      taping = false
      if (stopRecorders()) {
        for (f in clips.values) { keep(f); Log.i(TAG, "kept ${f.name}") }
      }
    }
    for (s in sessions.values) try { s.close() } catch (_: Throwable) {}
    sessions.clear()
    for (c in cams.values) try { c.close() } catch (_: Throwable) {}
    cams.clear()
    for (r in recs.values) try { r.release() } catch (_: Throwable) {}
    recs.clear()
    clips.clear()
    for (r in readers.values) try { r.close() } catch (_: Throwable) {}
    readers.clear()
    for (v in surfs.values) try { v.release() } catch (_: Throwable) {}
    surfs.clear()
    sizes.clear()
    synchronized(spots) { spots.clear() }
    val box = host
    host = null
    views.clear()
    act?.runOnUiThread {
      try {
        (box?.parent as? ViewGroup)?.removeView(box)
        page?.setBackgroundColor(Color.BLACK)
      } catch (_: Throwable) {
      }
    }
    thread?.quitSafely()
    thread = null
    hand = null
  }

  // -- stills ---------------------------------------------------------------

  /**
   * One photograph from each camera, combined into a single picture.
   *
   * Returns the path written, or a message starting with "!" if nothing was.
   * Both captures are asked for before either is waited on, so the two frames
   * are as close together in time as the hardware allows -- fire one, wait for
   * it, then fire the other, and you get a picture of two different moments,
   * which is the one thing a dual camera exists to avoid.
   */
  @JvmStatic
  fun photo(): String {
    if (!live) return "!Dual view is not running."
    val ids = pair
    if (ids.size != 2) return "!No camera pair."
    val grabs = ids.associateWith { grab(it) }
    val shots = HashMap<String, Bitmap>()
    for ((id, g) in grabs) {
      val b = g.get() ?: return "!Camera $id did not produce a photo."
      shots[id] = b
    }
    return try {
      val out = save(compose(shots))
      Log.i(TAG, "dual photo -> $out")
      out
    } catch (e: Throwable) {
      "!Could not save the photo: ${e.message}"
    } finally {
      for (b in shots.values) b.recycle()
    }
  }

  /** Ask one camera for a still and hand back something to wait on. */
  private fun grab(id: String): Future<Bitmap?> {
    val task = FutureTask<Bitmap?> {
      val dev = cams[id]
      val ses = sessions[id]
      val reader = readers[id]
      if (dev == null || ses == null || reader == null) return@FutureTask null
      val got = ArrayBlockingQueue<ByteArray>(1)
      reader.setOnImageAvailableListener({ r ->
        val img = r.acquireNextImage() ?: return@setOnImageAvailableListener
        try {
          val buf = img.planes[0].buffer
          val bytes = ByteArray(buf.remaining())
          buf.get(bytes)
          got.offer(bytes)
        } finally {
          img.close()
        }
      }, hand)
      val req = dev.createCaptureRequest(CameraDevice.TEMPLATE_STILL_CAPTURE)
      req.addTarget(reader.surface)
      req.set(CaptureRequest.CONTROL_AF_MODE, CaptureRequest.CONTROL_AF_MODE_CONTINUOUS_PICTURE)
      // Written upright here rather than tagged: the two frames are about to be
      // drawn into one bitmap, and an orientation tag describes a whole file, so
      // two differently-tagged frames cannot both be right in one picture.
      req.set(CaptureRequest.JPEG_ORIENTATION, 0)
      ses.capture(req.build(), object : CameraCaptureSession.CaptureCallback() {
        override fun onCaptureFailed(
          s: CameraCaptureSession,
          r: CaptureRequest,
          f: android.hardware.camera2.CaptureFailure,
        ) {
          got.offer(ByteArray(0))
        }

        override fun onCaptureCompleted(
          s: CameraCaptureSession,
          r: CaptureRequest,
          t: TotalCaptureResult,
        ) {
        }
      }, hand)
      val bytes = got.poll(5, TimeUnit.SECONDS)
      reader.setOnImageAvailableListener(null, hand)
      if (bytes == null || bytes.isEmpty()) return@FutureTask null
      upright(id, BitmapFactory.decodeByteArray(bytes, 0, bytes.size))
    }
    Thread(task).start()
    return task
  }

  /**
   * Turn a sensor frame the right way up for a phone held upright.
   *
   * Sensors are mounted sideways -- the rear one 90 degrees out, the front one
   * 270 and handed -- and the driver returns what the sensor saw, not what the
   * person saw. A front frame is also flipped, to match the mirrored preview:
   * a selfie where the text on your shirt reads correctly but you are on the
   * wrong side of your own room does not look like the picture you took.
   */
  private fun upright(id: String, src: Bitmap?): Bitmap? {
    if (src == null) return null
    val m = mgr ?: return src
    val ch = try { m.getCameraCharacteristics(id) } catch (_: Throwable) { return src }
    val deg = ch.get(CameraCharacteristics.SENSOR_ORIENTATION) ?: 90
    val mx = Matrix()
    mx.postRotate(deg.toFloat())
    if (isFront(id)) mx.postScale(-1f, 1f)
    // Held sideways, turned the same way the viewfinder is in `shape`.
    val turn = screenTurn()
    if (turn != 0) mx.postRotate(-90f * turn)
    val out = Bitmap.createBitmap(src, 0, 0, src.width, src.height, mx, true)
    if (out !== src) src.recycle()
    return out
  }

  /**
   * Draw the two frames into one picture, in the arrangement on screen.
   *
   * The photograph is composed in the shape of the viewfinder rather than of
   * one of the sensors, because the viewfinder is the only arrangement the
   * person actually chose -- and because two equal halves have no "main" frame
   * whose shape the picture could inherit. It costs some of the rear sensor's
   * height in the full-bleed case, which is the same crop the preview was
   * already showing: what you saw is what you get.
   */
  private fun compose(shots: Map<String, Bitmap>): Bitmap {
    val laid = spots.entries
      .filter { shots.containsKey(it.key) }
      .sortedBy { it.value.z }
    if (laid.isEmpty()) throw IllegalStateException("nothing is placed")

    val left = laid.minOf { it.value.x }
    val top = laid.minOf { it.value.y }
    val right = laid.maxOf { it.value.x + it.value.w }
    val bottom = laid.maxOf { it.value.y + it.value.h }
    val spanW = (right - left).coerceAtLeast(1)
    val spanH = (bottom - top).coerceAtLeast(1)

    // Scaled so the largest rectangle is drawn from its source at about 1:1:
    // enough to keep every real pixel the biggest camera contributes, and not
    // so much that the inset gets blown up past what its own sensor gave.
    var k = laid.minOf { (shots[it.key]?.width ?: 1).toFloat() / it.value.w }
    // Capped by short and long side rather than by width and height, so a phone
    // held sideways keeps the same detail as one held upright.
    val shortSide = minOf(spanW, spanH)
    val longSide = maxOf(spanW, spanH)
    if (shortSide * k > OUT_MAX) k = OUT_MAX.toFloat() / shortSide
    if (longSide * k > OUT_MAX * 2) k = (OUT_MAX * 2).toFloat() / longSide
    val outW = (spanW * k).toInt().coerceAtLeast(1)
    val outH = (spanH * k).toInt().coerceAtLeast(1)

    val out = Bitmap.createBitmap(outW, outH, Bitmap.Config.ARGB_8888)
    val c = Canvas(out)
    c.drawColor(Color.BLACK)
    val paint = Paint(Paint.ANTI_ALIAS_FLAG or Paint.FILTER_BITMAP_FLAG)

    for ((id, spot) in laid) {
      val bmp = shots[id] ?: continue
      val dst = Rect(
        ((spot.x - left) * k).toInt(),
        ((spot.y - top) * k).toInt(),
        ((spot.x - left + spot.w) * k).toInt(),
        ((spot.y - top + spot.h) * k).toInt(),
      )
      // Cropped to its rectangle rather than squashed into it, the same way
      // the preview fills its own -- otherwise one of the two faces in the
      // picture comes out a different shape from the other.
      val fill = maxOf(
        dst.width().toFloat() / bmp.width,
        dst.height().toFloat() / bmp.height,
      )
      val sw = (dst.width() / fill).toInt().coerceIn(1, bmp.width)
      val sh = (dst.height() / fill).toInt().coerceIn(1, bmp.height)
      val src = Rect(
        (bmp.width - sw) / 2,
        (bmp.height - sh) / 2,
        (bmp.width - sw) / 2 + sw,
        (bmp.height - sh) / 2 + sh,
      )
      c.drawBitmap(bmp, src, dst, paint)
    }
    return out
  }

  // -- video ----------------------------------------------------------------

  /**
   * Film on both cameras at once.
   *
   * Each camera writes its own clip and they are combined when recording
   * stops. Nothing tries to composite live: two 1440p streams through a filter
   * graph will not hold thirty frames a second on a phone, and dropping frames
   * to keep a preview pretty would be paying in the one currency a recording
   * cannot spare. It also means the two clips are whole and playable even if
   * the combining afterwards fails.
   *
   * Sound is recorded once, on the rear camera. There is one microphone array
   * and one app: a second `MediaRecorder` asking for audio is refused outright,
   * and two recordings of the same room would be nothing but a phasing problem
   * for whatever mixed them.
   */
  @JvmStatic
  fun startRecording(): String {
    if (!live) return "Dual view is not running."
    if (taping) return ""
    val ids = pair
    if (ids.size != 2) return "No camera pair."
    val stamp = java.text.SimpleDateFormat("yyyyMMdd_HHmmss", java.util.Locale.US)
      .format(java.util.Date())

    val live = startMixed(stamp)
    if (live.isEmpty()) {
      taping = true
      tapeStart = System.currentTimeMillis()
      Log.i(TAG, "dual recording started, combined live")
      return ""
    }
    // Two clips and a combine afterwards is slow, but it is a video; a device
    // whose GPU or encoder will not take the live route still gets one.
    Log.w(TAG, "live combining unavailable, filming two clips: $live")

    for ((n, id) in ids.withIndex()) {
      val size = sizes[id] ?: return "Camera $id has no size."
      val f = File(rawDir(), "facet_dual_${stamp}_${if (n == 0) "back" else "front"}.mp4")
      val r = try {
        recorder(size, f, withSound = n == 0 && mic())
      } catch (e: Throwable) {
        stopRecorders()
        restorePhotoSessions()
        return "Could not set up the recorder: ${e.message}"
      }
      recs[id] = r
      clips[id] = f
      val why = configure(id, r.surface, true)
      if (why.isNotEmpty()) {
        stopRecorders()
        restorePhotoSessions()
        return why
      }
    }

    for ((id, r) in recs) {
      try {
        r.start()
      } catch (e: Throwable) {
        stopRecorders()
        restorePhotoSessions()
        return "Camera $id would not start recording: ${e.message}"
      }
    }
    taping = true
    tapeStart = System.currentTimeMillis()
    Log.i(TAG, "dual recording started")
    return ""
  }

  /**
   * Whether the microphone is ours to use.
   *
   * Asked rather than assumed: the camera permission is granted at the
   * viewfinder, but the microphone one is only asked for when something wants
   * to listen, and a `MediaRecorder` that is denied it fails at `prepare` --
   * which would turn a missing permission into a recording that never started
   * at all, rather than a silent one.
   */
  private fun mic(): Boolean {
    val a = act ?: return false
    return ContextCompat.checkSelfPermission(a, Manifest.permission.RECORD_AUDIO) ==
      PackageManager.PERMISSION_GRANTED
  }

  private fun recorder(size: Size, out: File, withSound: Boolean): MediaRecorder {
    val a = act
    @Suppress("DEPRECATION")
    val r = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S && a != null) {
      MediaRecorder(a)
    } else {
      MediaRecorder()
    }
    if (withSound) r.setAudioSource(MediaRecorder.AudioSource.CAMCORDER)
    r.setVideoSource(MediaRecorder.VideoSource.SURFACE)
    r.setOutputFormat(MediaRecorder.OutputFormat.MPEG_4)
    r.setOutputFile(out.absolutePath)
    // Sensor-side dimensions, landscape, because that is how the frames arrive
    // and nothing has turned them upright yet. Turning them is left to the
    // combining step, which has to rotate, crop and place them regardless.
    r.setVideoSize(size.width, size.height)
    r.setVideoFrameRate(30)
    r.setVideoEncodingBitRate(size.width * size.height * 6)
    r.setVideoEncoder(MediaRecorder.VideoEncoder.H264)
    if (withSound) {
      r.setAudioEncoder(MediaRecorder.AudioEncoder.AAC)
      r.setAudioEncodingBitRate(128_000)
      r.setAudioSamplingRate(44_100)
    }
    r.prepare()
    return r
  }

  /**
   * Stop both cameras and hand back one video of the two.
   *
   * Returns the combined file's path, or a message starting with "!". The two
   * source clips are kept beside it rather than tidied away: they are the only
   * full-quality record of what each lens saw, the combined file is a crop of
   * them by definition, and a tool for working with media should not be the
   * one deciding the original is disposable.
   */
  @JvmStatic
  fun stopRecording(): String {
    if (!taping) return "!Not recording."
    if (mixer != null) return stopMixed(restore = true)
    taping = false
    val brief = System.currentTimeMillis() - tapeStart < 900
    val ids = pair
    val kept = stopRecorders()
    restorePhotoSessions()
    if (!kept) return "!The recording was too short to save."
    val back = clips[ids.getOrNull(0)]
    val front = clips[ids.getOrNull(1)]
    clips.clear()
    if (back == null || front == null) return "!One of the clips is missing."
    if (brief) Log.w(TAG, "very short recording; the result may be a single frame")
    val began = System.currentTimeMillis()
    val out = File(dcim(), back.name.replace("_back.mp4", ".mp4"))
    val why = stitch(back, front, out)
    if (why.isNotEmpty()) {
      // Both clips play on their own. Put them where the gallery looks, say
      // what went wrong, and point at what there is, rather than reporting a
      // clean failure over the top of two perfectly good files.
      Log.w(TAG, "combining failed: $why")
      keep(back)
      keep(front)
      return "!Saved both clips, but could not combine them: $why"
    }
    // The two halves are working files, not photos: one recording is one video
    // in the gallery, the way every phone camera does it.
    back.delete()
    front.delete()
    scan(out)
    Log.i(TAG, "dual video -> ${out.absolutePath} (combined in ${System.currentTimeMillis() - began} ms)")
    return out.absolutePath
  }

  /**
   * Start one recorder and draw both cameras into it as they stream.
   *
   * Returns "" once filming, or why not -- in which case everything it set up
   * has been put back, and the two-clip route can start from a clean slate.
   */
  private fun startMixed(stamp: String): String {
    val laid = synchronized(spots) {
      spots.entries.filter { pair.contains(it.key) }.map { it.key to it.value }
    }
    if (laid.size != 2) return "nothing is placed"
    val left = laid.minOf { it.second.x }
    val top = laid.minOf { it.second.y }
    val spanW = (laid.maxOf { it.second.x + it.second.w } - left).coerceAtLeast(1)
    val spanH = (laid.maxOf { it.second.y + it.second.h } - top).coerceAtLeast(1)
    val turn = screenTurn()

    val sources = ArrayList<DualMixer.Source>()
    for (id in pair) {
      val s = sizes[id] ?: return "camera $id has no size"
      sources.add(DualMixer.Source(id, s.width, s.height, orientation(id) / 90))
    }

    // Enough that the larger rectangle is drawn from its camera at about 1:1 --
    // 1440 across, upright -- and then the long side capped, which is the rule
    // that usually binds.
    var k = 0f
    for ((id, spot) in laid) {
      val size = sizes[id] ?: return "camera $id has no size"
      val across = if ((orientation(id) / 90 + turn) % 2 == 1) size.height else size.width
      val f = across.toFloat() / spot.w
      if (k == 0f || f < k) k = f
    }
    val long = maxOf(spanW, spanH)
    if (long * k > VID_SIDE) k = VID_SIDE.toFloat() / long
    var outW = align16((spanW * k).toInt())
    var outH = align16((spanH * k).toInt())
    var tries = 0
    while (!encodes(outW, outH) && tries < 12) {
      k *= 0.9f
      outW = align16((spanW * k).toInt())
      outH = align16((spanH * k).toInt())
      tries++
    }
    if (!encodes(outW, outH)) return "no encoder takes ${outW}x$outH"

    val out = File(dcim(), "facet_dual_$stamp.mp4")
    // Hidden until it is finished: the gallery and the media scanner both watch
    // this folder, and a video that appears half-written stays broken there.
    val part = File(out.parentFile, ".${out.name}")
    val rec = try {
      sized(outW, outH, part, mic())
    } catch (e: Throwable) {
      if (part.isFile) part.delete()
      return "recorder: ${e.message}"
    }

    val kx = outW.toFloat() / spanW
    val ky = outH.toFloat() / spanH
    // Read on every frame, so moving or swapping the two while filming is
    // filmed too -- the recording is what the screen showed.
    val mix = DualMixer(outW, outH, rec.surface, sources, turn) {
      synchronized(spots) {
        spots.entries.filter { pair.contains(it.key) }.sortedBy { it.value.z }.map {
          val s = it.value
          DualMixer.Placed(it.key, (s.x - left) * kx, (s.y - top) * ky, s.w * kx, s.h * ky)
        }
      }
    }
    val why = mix.start()
    if (why.isNotEmpty()) {
      try { rec.release() } catch (_: Throwable) {}
      if (part.isFile) part.delete()
      return "compositor: $why"
    }
    var fail = ""
    for (id in pair) {
      val input = mix.input(id)
      fail = if (input == null) "camera $id has no input" else configure(id, input, true)
      if (fail.isNotEmpty()) break
    }
    if (fail.isEmpty()) {
      try {
        rec.start()
      } catch (e: Throwable) {
        fail = "recorder would not start: ${e.message}"
      }
    }
    if (fail.isNotEmpty()) {
      // The sessions go back to the still readers before the textures they
      // point at are released, or the cameras error out on a dead surface.
      restorePhotoSessions()
      mix.release()
      try { rec.release() } catch (_: Throwable) {}
      if (part.isFile) part.delete()
      return fail
    }
    mix.rolling = true
    mixer = mix
    mixRec = rec
    mixOut = out
    Log.i(TAG, "combining live at ${outW}x$outH, turn $turn")
    return ""
  }

  /** Finish a live-combined recording. Returns the path, or "!" and why not. */
  private fun stopMixed(restore: Boolean): String {
    val mix = mixer
    val rec = mixRec
    val out = mixOut
    mixer = null
    mixRec = null
    mixOut = null
    taping = false
    val brief = System.currentTimeMillis() - tapeStart < 900
    mix?.halt()
    var ok = rec != null
    try {
      rec?.stop()
    } catch (e: Throwable) {
      // As with the two-clip recorders: no frames reached the encoder.
      Log.w(TAG, "combined recorder stop: ${e.message}")
      ok = false
    }
    try { rec?.release() } catch (_: Throwable) {}
    if (restore) restorePhotoSessions()
    val frames = mix?.frames ?: 0
    mix?.release()
    if (out == null) return "!The recording has nowhere to go."
    val part = File(out.parentFile, ".${out.name}")
    if (!ok || frames == 0) {
      if (part.isFile) part.delete()
      return "!The recording was too short to save."
    }
    if (brief) Log.w(TAG, "very short recording; the result may be a single frame")
    if (!part.renameTo(out)) return "!Could not move the video into place."
    scan(out)
    Log.i(TAG, "dual video -> ${out.absolutePath} ($frames frames, combined live)")
    return out.absolutePath
  }

  /** A recorder for a picture already combined and upright: one size, sound if allowed. */
  private fun sized(w: Int, h: Int, out: File, withSound: Boolean): MediaRecorder {
    val a = act
    @Suppress("DEPRECATION")
    val r = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S && a != null) {
      MediaRecorder(a)
    } else {
      MediaRecorder()
    }
    if (withSound) r.setAudioSource(MediaRecorder.AudioSource.CAMCORDER)
    r.setVideoSource(MediaRecorder.VideoSource.SURFACE)
    r.setOutputFormat(MediaRecorder.OutputFormat.MPEG_4)
    r.setOutputFile(out.absolutePath)
    r.setVideoSize(w, h)
    r.setVideoFrameRate(30)
    r.setVideoEncodingBitRate(w * h * 6)
    r.setVideoEncoder(MediaRecorder.VideoEncoder.H264)
    if (withSound) {
      r.setAudioEncoder(MediaRecorder.AudioEncoder.AAC)
      r.setAudioEncodingBitRate(128_000)
      r.setAudioSamplingRate(44_100)
    }
    r.prepare()
    return r
  }

  /** Whether an H.264 encoder on this device takes this frame size. */
  private fun encodes(w: Int, h: Int): Boolean =
    try {
      android.media.MediaCodecList(android.media.MediaCodecList.REGULAR_CODECS).codecInfos.any { info ->
        info.isEncoder &&
          info.supportedTypes.any { it.equals("video/avc", ignoreCase = true) } &&
          info.getCapabilitiesForType("video/avc").videoCapabilities?.isSizeSupported(w, h) == true
      }
    } catch (_: Throwable) {
      false
    }

  /** Multiples of sixteen: what every H.264 encoder takes without padding. */
  private fun align16(v: Int): Int = (v / 16 * 16).coerceAtLeast(16)

  /** How far the screen has turned from the phone's natural way up, in quarters. */
  private fun screenTurn(): Int =
    try {
      @Suppress("DEPRECATION")
      act?.windowManager?.defaultDisplay?.rotation ?: 0
    } catch (_: Throwable) {
      0
    }

  /** Whether both cameras are filming right now. */
  @JvmStatic
  fun recording(): Boolean = taping

  /** True if both recorders produced a file worth keeping. */
  private fun stopRecorders(): Boolean {
    var ok = recs.isNotEmpty()
    for ((id, r) in recs) {
      try {
        r.stop()
      } catch (e: Throwable) {
        // `stop` throws when the encoder never received a frame, and leaves an
        // empty file behind. That is a failed recording, not a crash.
        Log.w(TAG, "camera $id recorder stop: ${e.message}")
        ok = false
      }
      try { r.release() } catch (_: Throwable) {}
    }
    recs.clear()
    if (!ok) {
      for (f in clips.values) if (f.isFile && f.length() == 0L) f.delete()
      clips.clear()
    }
    return ok
  }

  /** Put the still readers back, so the next tap of the shutter works. */
  private fun restorePhotoSessions() {
    for (id in pair) {
      val reader = readers[id] ?: continue
      val why = configure(id, reader.surface, false)
      if (why.isNotEmpty()) Log.w(TAG, "could not restore camera $id: $why")
    }
  }

  /**
   * Combine the two clips into the arrangement that was on screen.
   *
   * ffmpeg is already in the APK -- it is what the rest of FACET converts with
   * -- and it lives in the native library directory because that is the one
   * place in an app's own storage Android will still execute from.
   *
   * The filter does per clip what `compose` does per photograph: turn it
   * upright, mirror it if it came from the front, fill its rectangle without
   * distorting it, and paint it at its place in z-order. Sound comes from the
   * rear clip, the only one that recorded any.
   */
  private fun stitch(back: File, front: File, out: File): String {
    val a = act ?: return "no activity"
    val exe = File(a.applicationInfo.nativeLibraryDir, "libffmpeg.so")
    if (!exe.isFile) return "ffmpeg is missing from this build"

    val laid = spots.entries.filter { pair.contains(it.key) }.sortedBy { it.value.z }
    if (laid.size != 2) return "nothing is placed"
    val left = laid.minOf { it.value.x }
    val top = laid.minOf { it.value.y }
    val spanW = (laid.maxOf { it.value.x + it.value.w } - left).coerceAtLeast(1)
    val spanH = (laid.maxOf { it.value.y + it.value.h } - top).coerceAtLeast(1)

    // The same scale rule as the photograph -- enough that the largest rectangle
    // is drawn from its source at about 1:1 -- and then the encoder's cap on
    // top of it, which is the one that usually binds.
    var k = laid.minOf { (sizes[it.key]?.height ?: 1).toFloat() / it.value.w }
    val fit = kotlin.math.sqrt(VID_PIXELS.toDouble() / (spanW.toDouble() * spanH)).toFloat()
    if (k > fit) k = fit
    val long = maxOf(spanW, spanH)
    if (long * k > VID_SIDE) k = VID_SIDE.toFloat() / long
    // Even numbers throughout. H.264 stores colour at half resolution, so an
    // odd width is not merely unusual -- the encoder refuses it.
    val outW = even((spanW * k).toInt())
    val outH = even((spanH * k).toInt())

    val ins = ArrayList<String>()
    val filter = StringBuilder()
    filter.append("color=c=black:s=${outW}x${outH}:r=30[bg]")
    var last = "bg"
    var sound = 0
    for ((n, e) in laid.withIndex()) {
      val id = e.key
      val spot = e.value
      val front1 = isFront(id)
      if (!front1) sound = n
      ins.add("-i")
      ins.add((if (front1) front else back).absolutePath)
      val w = even((spot.w * k).toInt())
      val h = even((spot.h * k).toInt())
      val x = ((spot.x - left) * k).toInt()
      val y = ((spot.y - top) * k).toInt()
      // transpose=1 turns a sensor mounted at 90 degrees upright; 2 is the
      // other way round, for the 270 a front sensor sometimes reports. The
      // flip after it is the same mirror the preview and the stills use.
      val turn = if (orientation(id) == 270) "transpose=2," else "transpose=1,"
      val flip = if (front1) "hflip," else ""
      // Filmed sideways: the screen's quarter turn, as `shape` gives the preview.
      val side = when (screenTurn()) {
        1 -> "transpose=2,"
        2 -> "hflip,vflip,"
        3 -> "transpose=1,"
        else -> ""
      }
      filter.append(";[$n:v]$turn$flip${side}scale=$w:$h:force_original_aspect_ratio=increase")
      filter.append(",crop=$w:$h,setsar=1[v$n]")
      val tag = if (n == laid.size - 1) "out" else "s$n"
      // `shortest=1` on the first overlay is what makes this finish. The black
      // background underneath is a generated source with no end to it, and an
      // overlay onto an endless background is itself endless: it holds the last
      // frame of the clip and goes on painting it, encoding forever, writing a
      // file that grows until the card is full. Asked for once without it, this
      // was still running eight minutes into an eleven-second recording.
      val end = if (n == 0) ":shortest=1" else ""
      filter.append(";[$last][v$n]overlay=$x:$y$end[$tag]")
      last = tag
    }

    val cmd = ArrayList<String>()
    cmd.add(exe.absolutePath)
    cmd.add("-y")
    cmd.addAll(ins)
    cmd.add("-filter_complex")
    cmd.add(filter.toString())
    cmd.add("-map")
    cmd.add("[out]")
    // The rear clip is the one with sound, and may have none if the microphone
    // was refused; the "?" makes that a silent video rather than a failed one.
    cmd.add("-map")
    cmd.add("$sound:a?")
    cmd.add("-c:v")
    cmd.add("libx264")
    cmd.add("-preset")
    cmd.add("veryfast")
    cmd.add("-crf")
    cmd.add("20")
    cmd.add("-pix_fmt")
    cmd.add("yuv420p")
    cmd.add("-c:a")
    cmd.add("aac")
    cmd.add("-shortest")
    cmd.add("-movflags")
    cmd.add("+faststart")
    // Written under a hidden name and moved into place at the end. FACET
    // watches this folder and so does the system's media scanner; a file
    // appearing the moment ffmpeg opens it is a video that cannot be opened,
    // and a thumbnail that fails once tends to stay failed. The leading dot is
    // the whole of the trick, and the extension has to survive it: ffmpeg
    // chooses the container from the name, and a ".part" on the end of it is a
    // format it has never heard of rather than a temporary file.
    val part = File(out.parentFile, ".${out.name}")
    cmd.add(part.absolutePath)

    return try {
      val p = ProcessBuilder(cmd).redirectErrorStream(true).start()
      // Read it as it comes. A process whose output nobody drains fills its
      // pipe buffer and stops, and ffmpeg is talkative enough to reach that on
      // any clip worth combining -- the wait below would then never return.
      val tail = ArrayDeque<String>()
      p.inputStream.bufferedReader().forEachLine {
        tail.addLast(it)
        while (tail.size > 6) tail.removeFirst()
      }
      val code = p.waitFor()
      when {
        code != 0 || !part.isFile || part.length() == 0L -> {
          if (part.isFile) part.delete()
          "ffmpeg exit $code: ${tail.joinToString(" / ")}"
        }
        !part.renameTo(out) -> {
          part.delete()
          "could not move the combined video into place"
        }
        else -> ""
      }
    } catch (e: Throwable) {
      if (part.isFile) part.delete()
      e.message ?: e.javaClass.simpleName
    }
  }

  private fun even(v: Int): Int = (v / 2 * 2).coerceAtLeast(2)

  private fun orientation(id: String): Int =
    try {
      mgr?.getCameraCharacteristics(id)?.get(CameraCharacteristics.SENSOR_ORIENTATION) ?: 90
    } catch (_: Throwable) {
      90
    }

  private fun dcim(): File {
    val dir = File(
      android.os.Environment.getExternalStoragePublicDirectory(
        android.os.Environment.DIRECTORY_DCIM
      ),
      "Facet",
    )
    dir.mkdirs()
    return dir
  }

  /**
   * Where the two raw halves are filmed: the app's own folder, which no gallery
   * lists, so a recording in progress never shows up as two stray clips.
   */
  private fun rawDir(): File {
    val a = act ?: return dcim()
    val dir = a.getExternalFilesDir("dual") ?: return dcim()
    dir.mkdirs()
    return dir
  }

  /** Move a raw half into the camera folder when it is all there is. */
  private fun keep(f: File) {
    if (!f.isFile) return
    val to = File(dcim(), f.name)
    val moved = f.parentFile == to.parentFile || f.renameTo(to) ||
      (try { f.copyTo(to, overwrite = false); f.delete(); true } catch (_: Throwable) { false })
    scan(if (moved) to else f)
  }

  private fun scan(f: File) {
    act?.let {
      android.media.MediaScannerConnection.scanFile(it, arrayOf(f.absolutePath), null, null)
    }
  }

  /** Alongside every other picture FACET takes. */
  private fun save(bmp: Bitmap): String {
    val dir = dcim()
    val stamp = java.text.SimpleDateFormat("yyyyMMdd_HHmmss", java.util.Locale.US)
      .format(java.util.Date())
    val f = File(dir, "facet_dual_$stamp.jpg")
    java.io.FileOutputStream(f).use { bmp.compress(Bitmap.CompressFormat.JPEG, 94, it) }
    bmp.recycle()
    scan(f)
    return f.absolutePath
  }
}
