package dev.lastseen.probe

import androidx.appcompat.app.AppCompatActivity

/** What the exclusivity results mean, as a pure function so it can be unit tested. */
object ExclusivitySummary {
    /**
     * @param nativeHeld the native camera opened in direction 1
     * @param webAudioOk / [webVideoOk] the WebView getUserMedia outcome while native streamed (null = not attempted)
     * @param nativeSurvivedWebVideo native frames kept coming after the WebView asked for the camera
     * @param nativeOpenedWhileWebHolds native opened and streamed while the WebView held the camera (null = not attempted)
     */
    fun build(
        nativeHeld: Boolean,
        webAudioOk: Boolean?,
        webVideoOk: Boolean?,
        nativeSurvivedWebVideo: Boolean,
        nativeOpenedWhileWebHolds: Boolean?,
    ): JSObject = JSObject()
        .put("webAudioWhileNativeCamera", webAudioOk ?: JSONNULL)
        .put("webVideoWhileNativeCamera", webVideoOk ?: JSONNULL)
        .put("nativeKeepsStreamingWhenWebOpensCamera", if (nativeHeld) nativeSurvivedWebVideo else JSONNULL)
        .put("nativeCanOpenWhileWebHoldsCamera", nativeOpenedWhileWebHolds ?: JSONNULL)
        .put(
            "verdict",
            when {
                !nativeHeld -> "inconclusive: the native camera could not be opened"
                webVideoOk == true -> "WebView CAN open the camera while native streams: ownership must be enforced in code (never open it in the WebView)"
                else -> "WebView is refused the camera while native streams: native owns the camera"
            },
        )
}

/**
 * Task 6c. Does the WebView still get the camera / microphone while the native camera streams, and the other way round?
 * Both directions are recorded, and the native frame counter is read between steps so "the WebView was refused" and
 * "the WebView got it and starved the native stream" are distinguishable.
 * Same JSON shape as the original web-driven probe (`exclusivity.nativeFirst`, `.webFirst`, `.summary`).
 */
object ExclusivityProbe {
    fun run(activity: AppCompatActivity, web: WebProbe, log: (String) -> Unit): JSObject {
        val out = JSObject()
        if (!CameraProbe.hasCameraPermission(activity)) return out.put("error", "CAMERA permission not granted")
        web.open()
        out.put("devices", web.devices())

        // Direction 1: native camera streams; can the WebView get the microphone / the camera?
        log("exclusivity: native camera first")
        val d1 = JSObject()
        val s1 = CameraStreamer(activity)
        val err1 = s1.startAndWait()
        val held = err1 == null
        d1.put("nativeHold", JSObject().put("held", held).put("error", err1 ?: JSONNULL))
        var webAudioOk: Boolean? = null
        var webVideoOk: Boolean? = null
        var survived = false
        if (held) {
            Thread.sleep(1500)
            val before = s1.frames.get()
            val audio = web.attempt("audio", false)
            Thread.sleep(800)
            val afterAudio = s1.frames.get()
            val video = web.attempt("video", false)
            Thread.sleep(1500)
            val afterVideo = s1.frames.get()
            webAudioOk = audio.optBoolean("ok")
            webVideoOk = video.optBoolean("ok")
            survived = afterVideo > afterAudio
            d1.put("framesBefore", before).put("webAudio", audio).put("framesAfterWebAudio", afterAudio)
                .put("webVideo", video).put("framesAfterWebVideo", afterVideo)
                .put("nativeStillStreamingAfterWebAudio", afterAudio > before)
                .put("nativeStillStreamingAfterWebVideo", survived)
            s1.stop()
            Thread.sleep(700)
        }
        out.put("nativeFirst", d1)

        // Direction 2: the WebView holds the camera; can native open it?
        log("exclusivity: WebView camera first")
        val d2 = JSObject()
        val webFirst = web.attempt("video", true)
        d2.put("webVideo", webFirst)
        var nativeOpened: Boolean? = null
        if (webFirst.optBoolean("ok")) {
            Thread.sleep(800)
            val s2 = CameraStreamer(activity)
            val err2 = s2.startAndWait()
            d2.put("nativeHold", JSObject().put("held", err2 == null).put("error", err2 ?: JSONNULL))
            Thread.sleep(1500)
            val frames = s2.frames.get()
            d2.put("nativeFrames", frames)
            nativeOpened = err2 == null && frames > 0
            s2.stop()
            web.releaseStreams()
            Thread.sleep(500)
        }
        out.put("webFirst", d2)
        web.close()

        return out.put("summary", ExclusivitySummary.build(held, webAudioOk, webVideoOk, survived, nativeOpened))
    }
}
