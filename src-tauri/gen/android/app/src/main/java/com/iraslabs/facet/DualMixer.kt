package com.iraslabs.facet

import android.graphics.SurfaceTexture
import android.opengl.EGL14
import android.opengl.EGLConfig
import android.opengl.EGLContext
import android.opengl.EGLDisplay
import android.opengl.EGLExt
import android.opengl.EGLSurface
import android.opengl.GLES11Ext
import android.opengl.GLES20
import android.os.Handler
import android.os.HandlerThread
import android.view.Surface
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.nio.FloatBuffer
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/**
 * Both cameras drawn into one video while they film.
 *
 * The first dual recorder filmed each camera to its own file and combined the
 * two afterwards with ffmpeg. That worked, and it cost one and a half to three
 * times the length of the clip in waiting, because this phone's ffmpeg has no
 * hardware encoder and every frame went through libx264 on the CPU. Nobody
 * films thirty seconds of a birthday and then watches a progress bar for a
 * minute and a half; the phone's own camera app saves the moment you stop.
 *
 * So the combining happens on the GPU, as the frames arrive. Each camera
 * streams into a `SurfaceTexture` here instead of into its own recorder; each
 * rear frame draws both textures, in the rectangles the page last asked for,
 * onto the input surface of one hardware-encoded `MediaRecorder`. Stopping is
 * then stopping a recorder -- the file is finished when the button is.
 *
 * The frames arrive upright. A texture a camera streams into carries the same
 * transform the preview view does -- sensor rotation, and the mirror for the
 * front camera -- and `getTransformMatrix` hands it over, so nothing here
 * turns or flips anything for a phone held upright. Held sideways, the screen
 * has turned but the sensor has not, and `turn` says by how much.
 */
internal class DualMixer(
  private val outW: Int,
  private val outH: Int,
  private val target: Surface,
  private val sources: List<Source>,
  /** Quarter turns, clockwise, from the phone's natural orientation to the screen's. */
  private val turn: Int,
  /** The rectangles to draw, in output pixels, bottom of the stack first. */
  private val layout: () -> List<Placed>,
) {
  /** One camera: its id, the size it streams at, and its sensor's quarter turns. The first leads. */
  class Source(val id: String, val streamW: Int, val streamH: Int, val sensorTurn: Int)

  class Placed(val id: String, val x: Float, val y: Float, val w: Float, val h: Float)

  private var thread: HandlerThread? = null
  private var hand: Handler? = null

  private var display: EGLDisplay = EGL14.EGL_NO_DISPLAY
  private var context: EGLContext = EGL14.EGL_NO_CONTEXT
  private var surface: EGLSurface = EGL14.EGL_NO_SURFACE

  private var program = 0
  private var aPos = 0
  private var aTex = 0
  private var uTex = 0

  private val textures = HashMap<String, SurfaceTexture>()
  private val inputs = HashMap<String, Surface>()
  private val names = HashMap<String, Int>()
  private val matrices = HashMap<String, FloatArray>()
  private val fresh = HashMap<String, Boolean>()
  private val seen = HashMap<String, Boolean>()

  private val quad: FloatBuffer = ByteBuffer.allocateDirect(16 * 4)
    .order(ByteOrder.nativeOrder()).asFloatBuffer()

  /** Set once the recorder has started; frames before that are only kept current. */
  @Volatile var rolling = false

  /** Frames written, for the log: a recording with none is a recording that failed. */
  @Volatile var frames = 0
    private set

  /** The surface a camera should stream into, once `start` has returned. */
  fun input(id: String): Surface? = inputs[id]

  /** Build the GL side. Returns "" or what went wrong. */
  fun start(): String {
    val t = HandlerThread("FacetDualMix")
    t.start()
    thread = t
    val h = Handler(t.looper)
    hand = h
    var why = ""
    val done = CountDownLatch(1)
    h.post {
      why = try {
        setUp()
        ""
      } catch (e: Throwable) {
        e.message ?: e.javaClass.simpleName
      }
      done.countDown()
    }
    if (!done.await(4, TimeUnit.SECONDS)) why = "the compositor did not start"
    if (why.isNotEmpty()) release()
    return why
  }

  private fun setUp() {
    display = EGL14.eglGetDisplay(EGL14.EGL_DEFAULT_DISPLAY)
    if (display == EGL14.EGL_NO_DISPLAY) throw IllegalStateException("no EGL display")
    val version = IntArray(2)
    if (!EGL14.eglInitialize(display, version, 0, version, 1)) {
      throw IllegalStateException("EGL would not initialise")
    }
    val attribs = intArrayOf(
      EGL14.EGL_RED_SIZE, 8,
      EGL14.EGL_GREEN_SIZE, 8,
      EGL14.EGL_BLUE_SIZE, 8,
      EGL14.EGL_RENDERABLE_TYPE, EGL14.EGL_OPENGL_ES2_BIT,
      // Without this the encoder's surface refuses the configuration: a
      // recordable config is one whose buffers a video encoder can read.
      EGL_RECORDABLE_ANDROID, 1,
      EGL14.EGL_NONE,
    )
    val configs = arrayOfNulls<EGLConfig>(1)
    val count = IntArray(1)
    if (!EGL14.eglChooseConfig(display, attribs, 0, configs, 0, 1, count, 0) || count[0] == 0) {
      throw IllegalStateException("no recordable EGL config")
    }
    val config = configs[0]
    context = EGL14.eglCreateContext(
      display, config, EGL14.EGL_NO_CONTEXT,
      intArrayOf(EGL14.EGL_CONTEXT_CLIENT_VERSION, 2, EGL14.EGL_NONE), 0,
    )
    if (context == EGL14.EGL_NO_CONTEXT) throw IllegalStateException("no EGL context")
    surface = EGL14.eglCreateWindowSurface(display, config, target, intArrayOf(EGL14.EGL_NONE), 0)
    if (surface == EGL14.EGL_NO_SURFACE) throw IllegalStateException("the encoder surface was refused")
    if (!EGL14.eglMakeCurrent(display, surface, surface, context)) {
      throw IllegalStateException("could not draw into the encoder")
    }

    program = link(VERTEX, FRAGMENT)
    aPos = GLES20.glGetAttribLocation(program, "aPos")
    aTex = GLES20.glGetAttribLocation(program, "aTex")
    uTex = GLES20.glGetUniformLocation(program, "uTex")

    val lead = sources.first().id
    for (s in sources) {
      val ids = IntArray(1)
      GLES20.glGenTextures(1, ids, 0)
      val name = ids[0]
      GLES20.glBindTexture(GLES11Ext.GL_TEXTURE_EXTERNAL_OES, name)
      GLES20.glTexParameteri(GLES11Ext.GL_TEXTURE_EXTERNAL_OES, GLES20.GL_TEXTURE_MIN_FILTER, GLES20.GL_LINEAR)
      GLES20.glTexParameteri(GLES11Ext.GL_TEXTURE_EXTERNAL_OES, GLES20.GL_TEXTURE_MAG_FILTER, GLES20.GL_LINEAR)
      GLES20.glTexParameteri(GLES11Ext.GL_TEXTURE_EXTERNAL_OES, GLES20.GL_TEXTURE_WRAP_S, GLES20.GL_CLAMP_TO_EDGE)
      GLES20.glTexParameteri(GLES11Ext.GL_TEXTURE_EXTERNAL_OES, GLES20.GL_TEXTURE_WRAP_T, GLES20.GL_CLAMP_TO_EDGE)
      val st = SurfaceTexture(name)
      st.setDefaultBufferSize(s.streamW, s.streamH)
      // The rear camera sets the pace. Drawing on every frame from either
      // would write sixty frames a second of thirty, half of them repeats.
      st.setOnFrameAvailableListener({
        fresh[s.id] = true
        if (s.id == lead) draw()
      }, hand)
      names[s.id] = name
      textures[s.id] = st
      inputs[s.id] = Surface(st)
      matrices[s.id] = FloatArray(16)
    }
  }

  private fun draw() {
    for (s in sources) {
      if (fresh[s.id] != true) continue
      fresh[s.id] = false
      val st = textures[s.id] ?: continue
      try {
        st.updateTexImage()
        st.getTransformMatrix(matrices[s.id])
        seen[s.id] = true
      } catch (_: Throwable) {
      }
    }
    if (!rolling) return

    GLES20.glViewport(0, 0, outW, outH)
    GLES20.glClearColor(0f, 0f, 0f, 1f)
    GLES20.glClear(GLES20.GL_COLOR_BUFFER_BIT)
    GLES20.glUseProgram(program)

    val placed = try { layout() } catch (_: Throwable) { emptyList() }
    for (p in placed) {
      if (seen[p.id] != true) continue
      val src = sources.firstOrNull { it.id == p.id } ?: continue
      paint(src, p)
    }

    EGLExt.eglPresentationTimeANDROID(display, surface, System.nanoTime())
    if (EGL14.eglSwapBuffers(display, surface)) frames++
  }

  /**
   * One camera into its rectangle, filling it without distorting it.
   *
   * The same crop the preview view does in `DualBridge.shape` and the stills do
   * in `compose`: scale until both sides are covered, keep the middle. Worked
   * out in the upright picture and then handed through the texture's own
   * matrix, which is what turns "upright" back into the sensor's coordinates.
   */
  private fun paint(src: Source, p: Placed) {
    val name = names[src.id] ?: return
    val m = matrices[src.id] ?: return
    // Upright size: sensors are mounted a quarter turn out, so an upright frame
    // swaps the sides the stream reports. Held sideways, the screen has turned
    // back the other way, and the sides swap again.
    val quarter = (src.sensorTurn + turn) % 2 == 1
    val sw = (if (quarter) src.streamH else src.streamW).toFloat()
    val sh = (if (quarter) src.streamW else src.streamH).toFloat()
    val scale = maxOf(p.w / sw, p.h / sh)
    val fx = (p.w / (sw * scale)).coerceAtMost(1f)
    val fy = (p.h / (sh * scale)).coerceAtMost(1f)
    val k = ((turn % 4) + 4) % 4
    // Turned a quarter, the screen's width runs along the texture's height.
    val cu = if (k % 2 == 1) fy else fx
    val cv = if (k % 2 == 1) fx else fy
    val u0 = 0.5f - cu / 2f
    val u1 = 0.5f + cu / 2f
    val v0 = 0.5f - cv / 2f
    val v1 = 0.5f + cv / 2f

    val x0 = p.x / outW * 2f - 1f
    val x1 = (p.x + p.w) / outW * 2f - 1f
    val yTop = 1f - p.y / outH * 2f
    val yBot = 1f - (p.y + p.h) / outH * 2f

    // Corners in strip order: bottom-left, bottom-right, top-left, top-right.
    // The texture coordinates are those of the upright crop, turned by the
    // screen's rotation so a sideways phone films a level horizon.
    val corners = arrayOf(floatArrayOf(u0, v0), floatArrayOf(u1, v0), floatArrayOf(u0, v1), floatArrayOf(u1, v1))
    // Walking the corners round: BL -> TL -> TR -> BR is one quarter turn.
    val ring = intArrayOf(0, 2, 3, 1)
    fun tex(i: Int): FloatArray {
      val at = ring.indexOf(i)
      return corners[ring[(at + k) % 4]]
    }

    quad.clear()
    val pos = arrayOf(floatArrayOf(x0, yBot), floatArrayOf(x1, yBot), floatArrayOf(x0, yTop), floatArrayOf(x1, yTop))
    for (i in 0 until 4) {
      quad.put(pos[i][0]); quad.put(pos[i][1])
      val t = tex(i)
      quad.put(t[0]); quad.put(t[1])
    }
    quad.position(0)

    GLES20.glActiveTexture(GLES20.GL_TEXTURE0)
    GLES20.glBindTexture(GLES11Ext.GL_TEXTURE_EXTERNAL_OES, name)
    GLES20.glUniformMatrix4fv(uTex, 1, false, m, 0)
    GLES20.glEnableVertexAttribArray(aPos)
    GLES20.glVertexAttribPointer(aPos, 2, GLES20.GL_FLOAT, false, 16, quad)
    quad.position(2)
    GLES20.glEnableVertexAttribArray(aTex)
    GLES20.glVertexAttribPointer(aTex, 2, GLES20.GL_FLOAT, false, 16, quad)
    quad.position(0)
    GLES20.glDrawArrays(GLES20.GL_TRIANGLE_STRIP, 0, 4)
  }

  /** Stop drawing into the encoder, and wait until any frame in progress is done. */
  fun halt() {
    rolling = false
    val h = hand ?: return
    val done = CountDownLatch(1)
    h.post { done.countDown() }
    done.await(2, TimeUnit.SECONDS)
  }

  /** Let go of everything: textures, surfaces, the context and the thread. */
  fun release() {
    rolling = false
    val h = hand
    val t = thread
    if (h != null && t != null && t.isAlive) {
      val done = CountDownLatch(1)
      h.post {
        tearDown()
        done.countDown()
      }
      done.await(2, TimeUnit.SECONDS)
      t.quitSafely()
    } else {
      tearDown()
    }
    thread = null
    hand = null
  }

  private fun tearDown() {
    for (st in textures.values) try { st.setOnFrameAvailableListener(null); st.release() } catch (_: Throwable) {}
    textures.clear()
    for (s in inputs.values) try { s.release() } catch (_: Throwable) {}
    inputs.clear()
    if (display != EGL14.EGL_NO_DISPLAY) {
      try {
        if (program != 0) GLES20.glDeleteProgram(program)
        val ids = names.values.toIntArray()
        if (ids.isNotEmpty()) GLES20.glDeleteTextures(ids.size, ids, 0)
      } catch (_: Throwable) {
      }
      EGL14.eglMakeCurrent(display, EGL14.EGL_NO_SURFACE, EGL14.EGL_NO_SURFACE, EGL14.EGL_NO_CONTEXT)
      if (surface != EGL14.EGL_NO_SURFACE) EGL14.eglDestroySurface(display, surface)
      if (context != EGL14.EGL_NO_CONTEXT) EGL14.eglDestroyContext(display, context)
      // Not `eglTerminate`: the display is the process's one default display,
      // and the WebView draws through it too.
      EGL14.eglReleaseThread()
    }
    names.clear()
    program = 0
    surface = EGL14.EGL_NO_SURFACE
    context = EGL14.EGL_NO_CONTEXT
    display = EGL14.EGL_NO_DISPLAY
  }

  private fun link(vs: String, fs: String): Int {
    val v = shader(GLES20.GL_VERTEX_SHADER, vs)
    val f = shader(GLES20.GL_FRAGMENT_SHADER, fs)
    val p = GLES20.glCreateProgram()
    GLES20.glAttachShader(p, v)
    GLES20.glAttachShader(p, f)
    GLES20.glLinkProgram(p)
    val ok = IntArray(1)
    GLES20.glGetProgramiv(p, GLES20.GL_LINK_STATUS, ok, 0)
    if (ok[0] == 0) {
      val log = GLES20.glGetProgramInfoLog(p)
      GLES20.glDeleteProgram(p)
      throw IllegalStateException("shader link: $log")
    }
    return p
  }

  private fun shader(type: Int, src: String): Int {
    val s = GLES20.glCreateShader(type)
    GLES20.glShaderSource(s, src)
    GLES20.glCompileShader(s)
    val ok = IntArray(1)
    GLES20.glGetShaderiv(s, GLES20.GL_COMPILE_STATUS, ok, 0)
    if (ok[0] == 0) {
      val log = GLES20.glGetShaderInfoLog(s)
      GLES20.glDeleteShader(s)
      throw IllegalStateException("shader compile: $log")
    }
    return s
  }

  companion object {
    private const val TAG = "FacetDual"
    private const val EGL_RECORDABLE_ANDROID = 0x3142

    private const val VERTEX = """
      attribute vec4 aPos;
      attribute vec2 aTex;
      uniform mat4 uTex;
      varying vec2 vTex;
      void main() {
        gl_Position = aPos;
        vTex = (uTex * vec4(aTex, 0.0, 1.0)).xy;
      }
    """

    private const val FRAGMENT = """
      #extension GL_OES_EGL_image_external : require
      precision mediump float;
      varying vec2 vTex;
      uniform samplerExternalOES sTex;
      void main() {
        gl_FragColor = texture2D(sTex, vTex);
      }
    """
  }
}
