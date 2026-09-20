package dev.lastseen.probe

import android.content.Context
import android.content.Intent
import android.media.session.MediaSession
import android.media.session.PlaybackState
import android.os.Build
import android.util.Log
import android.view.KeyEvent

/**
 * Task 6e. Forwards hardware key events from the Activity to JS with epoch-millisecond timestamps.
 *
 * Two independent paths, because a Bluetooth clicker may arrive by either:
 *  - "activity":     Activity.dispatchKeyEvent (phone buttons, HID keyboards/clickers that send key events)
 *  - "mediaSession": an active MediaSession (headset hook / play-pause style media buttons)
 * Each forwarded event says which path saw it, so the probe shows which one a given clicker uses.
 */
class KeysProbe(private val ctx: Context, private val emit: (JSObject) -> Unit) {
    private companion object {
        // KeyEvent.isMediaSessionKey() is API 31+; the app supports API 24
        val MEDIA_KEYS = setOf(
            KeyEvent.KEYCODE_MEDIA_PLAY, KeyEvent.KEYCODE_MEDIA_PAUSE, KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE, KeyEvent.KEYCODE_MEDIA_STOP,
            KeyEvent.KEYCODE_MEDIA_NEXT, KeyEvent.KEYCODE_MEDIA_PREVIOUS, KeyEvent.KEYCODE_MEDIA_REWIND, KeyEvent.KEYCODE_MEDIA_FAST_FORWARD,
        )
    }

    @Volatile var active = false
        private set
    private var session: MediaSession? = null
    private var seq = 0

    fun start(withMediaSession: Boolean) {
        stop()
        active = true
        if (withMediaSession) startSession()
        Log.i(TAG, "keys probe started (mediaSession=$withMediaSession)")
    }

    fun stop() {
        active = false
        runCatching { session?.isActive = false; session?.release() }
        session = null
    }

    /** Volume, media and headset keys are consumed while probing so the system volume UI does not cover the screen. */
    private fun consumes(code: Int) = code == KeyEvent.KEYCODE_VOLUME_UP || code == KeyEvent.KEYCODE_VOLUME_DOWN ||
        code == KeyEvent.KEYCODE_VOLUME_MUTE || code == KeyEvent.KEYCODE_HEADSETHOOK || code in MEDIA_KEYS

    /** Returns true if the event was consumed. Never consumes BACK/HOME so the probe can always be left. */
    fun onKey(e: KeyEvent, source: String): Boolean {
        if (!active) return false
        if (e.keyCode == KeyEvent.KEYCODE_BACK) return false
        if (e.action == KeyEvent.ACTION_DOWN && e.repeatCount > 0) return consumes(e.keyCode) // auto-repeat: swallow, do not forward
        emit(
            JSObject()
                .put("t", System.currentTimeMillis()) // epoch ms, the contract's clock
                .put("keyCode", e.keyCode)
                .put("keyName", KeyEvent.keyCodeToString(e.keyCode))
                .put("action", if (e.action == KeyEvent.ACTION_DOWN) "down" else "up")
                .put("source", source)
                .put("deviceId", e.deviceId)
                .put("inputSource", e.source)
                .put("seq", ++seq),
        )
        return consumes(e.keyCode)
    }

    private fun startSession() {
        val s = MediaSession(ctx, "LastseenKeys")
        s.setCallback(object : MediaSession.Callback() {
            override fun onMediaButtonEvent(mediaButtonIntent: Intent): Boolean {
                val ev: KeyEvent? = if (Build.VERSION.SDK_INT >= 33) {
                    mediaButtonIntent.getParcelableExtra(Intent.EXTRA_KEY_EVENT, KeyEvent::class.java)
                } else {
                    @Suppress("DEPRECATION")
                    mediaButtonIntent.getParcelableExtra(Intent.EXTRA_KEY_EVENT)
                }
                if (ev != null) onKey(ev, "mediaSession")
                return true
            }
        })
        // A session only receives media buttons if the system thinks it is playing.
        s.setPlaybackState(
            PlaybackState.Builder()
                .setActions(PlaybackState.ACTION_PLAY or PlaybackState.ACTION_PAUSE or PlaybackState.ACTION_PLAY_PAUSE or PlaybackState.ACTION_SKIP_TO_NEXT or PlaybackState.ACTION_SKIP_TO_PREVIOUS)
                .setState(PlaybackState.STATE_PLAYING, 0L, 1f)
                .build(),
        )
        s.isActive = true
        session = s
    }
}
