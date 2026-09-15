package com.iraslabs.facet

import android.content.Context
import android.os.Build
import android.os.Bundle
import android.speech.tts.TextToSpeech
import android.speech.tts.UtteranceProgressListener
import android.speech.tts.Voice
import org.json.JSONArray
import org.json.JSONObject
import java.util.Locale
import java.util.concurrent.ConcurrentLinkedQueue
import java.util.concurrent.atomic.AtomicInteger

/**
 * The phone's own voices, for read-aloud.
 *
 * This file exists because of one platform fact that is easy to get wrong and
 * expensive to discover late: **Android's WebView does not implement the Web
 * Speech API's synthesis side.** `window.speechSynthesis` is present, so
 * feature detection says yes; `getVoices()` returns an empty list forever and
 * `speak()` is silent. Chrome for Android has it. The WebView that every Tauri
 * and Cordova app actually runs in does not. So the frontend's system-voice
 * engine finds nothing on the one platform where the built-in voices are the
 * *good* option -- Google's and Samsung's Android voices are neural and free,
 * and are a better default on a phone than an 88 MB model download.
 *
 * `android.speech.tts.TextToSpeech` is the real thing behind those voices and
 * is what this bridge exposes. Three notes on the shape:
 *
 * **Initialisation is asynchronous and can fail.** The engine binds as a
 * service; the voice list does not exist until `onInit`. Everything here
 * therefore answers "not ready yet" rather than blocking, and the frontend
 * waits on that the same way it waits on the browser's `voiceschanged`.
 *
 * **Progress comes back as character ranges.** `onRangeStart` reports exactly
 * where in the text the engine has got to, which is what drives the word
 * highlight -- the same information the browser's `boundary` event carries, so
 * the player upstream needs no special case. It is API 26+; below that the
 * player falls back to estimating, which it already does for Kokoro.
 *
 * **Events are queued, not pushed.** Rust drains this queue while an utterance
 * is in flight and re-emits it as a Tauri event. Pushing from here would mean
 * calling into the WebView from a TTS callback thread, which is the kind of
 * lifecycle race that works for months and then crashes on a rotation.
 */
object SpeechBridge {
  private var tts: TextToSpeech? = null

  /** 0 = never started, 1 = starting, 2 = usable, -1 = the engine refused. */
  @Volatile private var state = 0

  private val events = ConcurrentLinkedQueue<String>()
  private val counter = AtomicInteger(0)

  /** The utterance the frontend last asked for. Late events from an older one are dropped. */
  @Volatile private var current = ""

  /**
   * Bind the engine. Safe to call repeatedly; only the first call does anything.
   *
   * Called on the first voice query rather than at launch: a user who never
   * opens the reader should not pay for a service binding, and binding early is
   * also how apps end up holding a TTS engine awake in the background.
   */
  @JvmStatic
  fun start(ctx: Context) {
    if (state != 0) return
    state = 1
    try {
      val app = ctx.applicationContext
      var engine: TextToSpeech? = null
      engine = TextToSpeech(app) { status ->
        state = if (status == TextToSpeech.SUCCESS) 2 else -1
        if (state == 2) engine?.setOnUtteranceProgressListener(listener)
      }
      tts = engine
    } catch (_: Throwable) {
      state = -1
    }
  }

  private val listener = object : UtteranceProgressListener() {
    override fun onStart(utteranceId: String?) = post(utteranceId, "start", null)

    override fun onDone(utteranceId: String?) = post(utteranceId, "end", null)

    @Deprecated("kept because the base class requires it")
    override fun onError(utteranceId: String?) = post(utteranceId, "error", null)

    override fun onError(utteranceId: String?, errorCode: Int) {
      post(utteranceId, "error", JSONObject().put("code", errorCode))
    }

    override fun onStop(utteranceId: String?, interrupted: Boolean) {
      // A deliberate stop is not an end: reporting it as one would make the
      // player advance a sentence every time the user pressed pause.
      post(utteranceId, "stop", null)
    }

    override fun onRangeStart(utteranceId: String?, start: Int, end: Int, frame: Int) {
      post(utteranceId, "word", JSONObject().put("from", start).put("to", end))
    }
  }

  private fun post(id: String?, type: String, extra: JSONObject?) {
    val who = id ?: return
    if (who != current) return
    val o = JSONObject().put("id", who).put("type", type)
    if (extra != null) for (k in extra.keys()) o.put(k, extra.get(k))
    // A queue nobody is draining must not grow without bound -- the frontend
    // can be backgrounded in the middle of a sentence.
    while (events.size > 512) events.poll()
    events.add(o.toString())
  }

  /**
   * What the engine can do, as JSON: `{"state":2,"voices":[...]}`.
   *
   * `state` is reported rather than waited on, so the caller decides how long
   * to wait. Binding is usually well under a second, but a cold engine on a
   * busy phone has been seen to take three.
   */
  @JvmStatic
  fun voices(ctx: Context): String {
    start(ctx)
    val out = JSONObject().put("state", state)
    val list = JSONArray()
    val engine = tts
    if (state == 2 && engine != null) {
      val found = try { engine.voices } catch (_: Throwable) { null }
      if (found != null) {
        for (v in found) {
          if (v == null) continue
          list.put(describe(v))
        }
      }
      if (list.length() == 0) {
        // Some OEM engines report no Voice objects but do have languages. A
        // language is enough to speak with, so offer those rather than telling
        // the user the phone has no voices when it plainly does.
        val langs = try {
          engine.availableLanguages ?: emptySet<Locale>()
        } catch (_: Throwable) {
          emptySet<Locale>()
        }
        for (loc in langs) {
          list.put(
            JSONObject()
              .put("id", "lang:" + loc.toLanguageTag())
              .put("name", loc.displayName)
              .put("lang", loc.toLanguageTag())
              .put("network", false)
              .put("quality", 300)
          )
        }
      }
    }
    return out.put("voices", list).toString()
  }

  private fun describe(v: Voice): JSONObject {
    val tag = try { v.locale.toLanguageTag() } catch (_: Throwable) { "" }
    return JSONObject()
      .put("id", v.name)
      .put("name", prettyName(v, tag))
      .put("lang", tag)
      .put("network", needsNetwork(v))
      .put("quality", v.quality)
  }

  /**
   * Whether speaking with this voice sends the sentence to a server.
   *
   * `isNetworkConnectionRequired` is the obvious answer and it is not a
   * reliable one: Google's engine returns false for most of its own
   * `xx-xx-x-yyy-network` voices, which is how a picker filtered on that flag
   * alone still ends up offering a hundred languages the phone cannot speak
   * without data. So three signals, any of which is disqualifying:
   *
   *  - the flag, when the engine does set it;
   *  - the `networkTts` feature, which Google does set on those voices;
   *  - `notInstalled`, because a voice whose data has not been downloaded is
   *    synthesised on a server whatever else it claims;
   *
   * and last the name, since the whole family ends in `-network` and an OEM
   * engine that sets none of the above still follows that convention.
   */
  private fun needsNetwork(v: Voice): Boolean {
    val feats = try { v.features ?: emptySet<String>() } catch (_: Throwable) { emptySet<String>() }
    if (try { v.isNetworkConnectionRequired } catch (_: Throwable) { false }) return true
    if (feats.contains(TextToSpeech.Engine.KEY_FEATURE_NETWORK_SYNTHESIS)) return true
    if (feats.contains(TextToSpeech.Engine.KEY_FEATURE_NOT_INSTALLED)) return true
    return v.name.endsWith("-network", ignoreCase = true)
  }

  /**
   * A name a person can choose from.
   *
   * Android voice names are identifiers, not labels: "en-us-x-tpf-local",
   * "en-GB-language", "en-us-x-sfg#female_2-local". The useful parts are the
   * variant tag and whether it is a male or female voice; the rest is noise.
   * Where nothing useful survives, the locale's own display name is a better
   * answer than the raw id.
   */
  private fun prettyName(v: Voice, tag: String): String {
    val raw = v.name
    val female = raw.contains("female", true) || Regex("-x-[a-z]*f[a-z]?[#-]").containsMatchIn(raw)
    val male = raw.contains("male", true) && !female
    val variant = Regex("-x-([a-z0-9]+)").find(raw)?.groupValues?.get(1)
    val sex = if (female) "female" else if (male) "male" else ""
    val locale = try { v.locale.displayName } catch (_: Throwable) { tag }
    val bits = listOfNotNull(
      locale.takeIf { it.isNotBlank() },
      variant?.takeIf { it.isNotBlank() && it != "local" },
      sex.takeIf { it.isNotBlank() },
    )
    return if (bits.isEmpty()) raw else bits.joinToString(" ")
  }

  /**
   * Say something. Returns the utterance id, or "" when nothing was said.
   *
   * QUEUE_FLUSH, always: the player upstream owns the queue and hands over one
   * utterance at a time, so anything still speaking here is something the user
   * has already moved on from.
   */
  @JvmStatic
  fun speak(
    ctx: Context,
    text: String,
    voiceId: String,
    rate: Float,
    pitch: Float,
    volume: Float,
  ): String {
    start(ctx)
    val engine = tts ?: return ""
    if (state != 2) return ""
    if (text.isBlank()) return ""

    val id = "u" + counter.incrementAndGet()
    current = id
    events.clear()

    try {
      if (voiceId.startsWith("lang:")) {
        engine.language = Locale.forLanguageTag(voiceId.removePrefix("lang:"))
      } else if (voiceId.isNotEmpty()) {
        val all = try { engine.voices } catch (_: Throwable) { null }
        val want = all?.firstOrNull { it != null && it.name == voiceId }
        if (want != null) engine.voice = want
      }
      // Android's own range is 0.1-6 for both. Outside 0.5-2 most engines stop
      // being intelligible, and the reader's own slider already caps at 4.
      engine.setSpeechRate(rate.coerceIn(0.1f, 4f))
      engine.setPitch(pitch.coerceIn(0.5f, 2f))

      val params = Bundle()
      params.putFloat(TextToSpeech.Engine.KEY_PARAM_VOLUME, volume.coerceIn(0f, 1f))
      params.putString(TextToSpeech.Engine.KEY_PARAM_UTTERANCE_ID, id)

      val rc = engine.speak(text, TextToSpeech.QUEUE_FLUSH, params, id)
      if (rc != TextToSpeech.SUCCESS) return ""
    } catch (_: Throwable) {
      return ""
    }
    return id
  }

  /** Stop immediately. Events already queued for the stopped utterance are dropped. */
  @JvmStatic
  fun stop() {
    current = ""
    events.clear()
    try { tts?.stop() } catch (_: Throwable) {}
  }

  /**
   * Everything that has happened since the last call, as a JSON array, or null.
   *
   * Null rather than `[]` so the poller can tell nothing-happened from
   * something-happened without parsing, which is the common case many times a
   * second for the length of every sentence.
   */
  @JvmStatic
  fun drain(): String? {
    if (events.isEmpty()) return null
    val out = JSONArray()
    while (true) {
      val e = events.poll() ?: break
      out.put(JSONObject(e))
    }
    if (out.length() == 0) return null
    return out.toString()
  }

  /** Let the engine go. The activity calls this on destroy. */
  @JvmStatic
  fun shutdown() {
    current = ""
    events.clear()
    try { tts?.shutdown() } catch (_: Throwable) {}
    tts = null
    state = 0
  }
}
