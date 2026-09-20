package dev.lastseen.probe

import android.Manifest
import android.annotation.SuppressLint
import android.content.pm.PackageManager
import android.util.Log
import android.view.ViewGroup
import android.webkit.JavascriptInterface
import android.webkit.PermissionRequest
import android.webkit.WebChromeClient
import android.webkit.WebView
import androidx.appcompat.app.AppCompatActivity
import java.util.concurrent.CompletableFuture
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.TimeoutException
import java.util.concurrent.atomic.AtomicInteger

/**
 * The WebView side of the camera-ownership test (task 6c). A 1x1 WebView on a secure origin (https://localhost) tries
 * `getUserMedia` and reports the outcome as data. It is NOT a UI: the app has no web layer, this exists only because the
 * future frontend may run in a WebView and camera ownership has to be decided against a real one.
 *
 * Permission handling (task 3): WebChromeClient.onPermissionRequest grants a request only if the matching Android runtime
 * permission is already granted, and records what the page asked for.
 */
@SuppressLint("SetJavaScriptEnabled")
class WebProbe(private val activity: AppCompatActivity) {
    @Volatile private var web: WebView? = null
    private val pending = ConcurrentHashMap<Int, CompletableFuture<String>>()
    private val ids = AtomicInteger(0)
    @Volatile private var lastRequested: List<String> = emptyList()
    @Volatile private var lastDecision = "none"

    private fun granted(p: String) = activity.checkSelfPermission(p) == PackageManager.PERMISSION_GRANTED

    private inner class Bridge {
        @JavascriptInterface
        fun result(id: Int, json: String) {
            pending.remove(id)?.complete(json)
        }
    }

    /** Creates the WebView on the UI thread and waits until the page has loaded. */
    fun open(timeoutMs: Long = 8000) {
        if (web != null) return
        val loaded = CountDownLatch(1)
        // the page's own script marks readiness by calling Android.result(0, "ready"); register the waiter before loading
        pending[0] = CompletableFuture<String>().also { f -> f.thenRun { loaded.countDown() } }
        activity.runOnUiThread {
            val w = WebView(activity)
            w.settings.javaScriptEnabled = true
            w.settings.mediaPlaybackRequiresUserGesture = false
            w.addJavascriptInterface(Bridge(), "Android")
            w.webChromeClient = object : WebChromeClient() {
                override fun onPermissionRequest(request: PermissionRequest) {
                    val asked = request.resources.toList()
                    lastRequested = asked
                    val ok = asked.all {
                        when (it) {
                            PermissionRequest.RESOURCE_VIDEO_CAPTURE -> granted(Manifest.permission.CAMERA)
                            PermissionRequest.RESOURCE_AUDIO_CAPTURE -> granted(Manifest.permission.RECORD_AUDIO)
                            else -> false
                        }
                    }
                    lastDecision = if (ok) "granted" else "denied (Android runtime permission missing or unknown resource)"
                    activity.runOnUiThread { if (ok) request.grant(request.resources) else request.deny() }
                }
            }
            activity.addContentView(w, ViewGroup.LayoutParams(1, 1))
            w.loadDataWithBaseURL("https://localhost/", PAGE, "text/html", "utf-8", null)
            web = w
        }
        if (!loaded.await(timeoutMs, TimeUnit.MILLISECONDS)) throw TimeoutException("WebView page did not load")
    }

    fun close() {
        val w = web ?: return
        web = null
        activity.runOnUiThread {
            runCatching { w.evaluateJavascript("stopAll()", null) }
            (w.parent as? ViewGroup)?.removeView(w)
            w.destroy()
        }
    }

    /** kind: "audio" or "video". Never throws: failures are recorded as `ok=false` data. */
    fun attempt(kind: String, keepOpen: Boolean, timeoutMs: Long = 15_000): JSObject {
        val w = web ?: return JSObject().put("ok", false).put("error", JSObject().put("name", "NoWebView").put("message", "open() was not called"))
        val id = ids.incrementAndGet()
        val fut = CompletableFuture<String>()
        pending[id] = fut
        lastRequested = emptyList()
        lastDecision = "none"
        activity.runOnUiThread { w.evaluateJavascript("attempt($id, '$kind', $keepOpen)", null) }
        return try {
            parseObject(fut.get(timeoutMs, TimeUnit.MILLISECONDS)).put("permissionRequested", JSArray(lastRequested)).put("permissionDecision", lastDecision)
        } catch (t: Throwable) {
            pending.remove(id)
            Log.w(TAG, "web attempt $kind failed", t)
            JSObject().put("ok", false).put("error", JSObject().put("name", t.javaClass.simpleName).put("message", "no answer from the page: $t"))
                .put("permissionRequested", JSArray(lastRequested)).put("permissionDecision", lastDecision)
        }
    }

    fun releaseStreams() {
        val w = web ?: return
        activity.runOnUiThread { w.evaluateJavascript("stopAll()", null) }
    }

    fun devices(timeoutMs: Long = 5000): JSObject {
        val w = web ?: return JSObject().put("error", "open() was not called")
        val id = ids.incrementAndGet()
        val fut = CompletableFuture<String>()
        pending[id] = fut
        activity.runOnUiThread { w.evaluateJavascript("devices($id)", null) }
        return try { parseObject(fut.get(timeoutMs, TimeUnit.MILLISECONDS)) } catch (t: Throwable) { pending.remove(id); JSObject().put("error", t.toString()) }
    }

    private companion object {
        /** Tiny page: getUserMedia attempts reported back through the Android JS interface. */
        const val PAGE = """<!doctype html><html><body><script>
var kept = [];
function stopAll() { kept.forEach(function (s) { s.getTracks().forEach(function (t) { t.stop(); }); }); kept = []; }
function report(id, o) { Android.result(id, JSON.stringify(o)); }
async function attempt(id, kind, keepOpen) {
  var t0 = Date.now();
  var constraints = kind === 'audio' ? { audio: true } : { video: true };
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    return report(id, { ok: false, ms: 0, error: { name: 'NotSupported', message: 'getUserMedia unavailable (insecure context?)' } });
  }
  try {
    var s = await navigator.mediaDevices.getUserMedia(constraints);
    var tracks = s.getTracks().map(function (t) { return { kind: t.kind, label: t.label, readyState: t.readyState, settings: t.getSettings() }; });
    if (keepOpen) kept.push(s); else s.getTracks().forEach(function (t) { t.stop(); });
    report(id, { ok: true, ms: Date.now() - t0, error: null, tracks: tracks });
  } catch (e) {
    report(id, { ok: false, ms: Date.now() - t0, error: { name: e.name || 'Error', message: e.message || String(e) }, tracks: [] });
  }
}
async function devices(id) {
  try {
    var d = await navigator.mediaDevices.enumerateDevices();
    var n = function (k) { return d.filter(function (x) { return x.kind === k; }).length; };
    report(id, { audioinput: n('audioinput'), videoinput: n('videoinput'), audiooutput: n('audiooutput') });
  } catch (e) { report(id, { audioinput: 0, videoinput: 0, audiooutput: 0, error: String(e) }); }
}
Android.result(0, 'ready');
</script></body></html>"""
    }
}
