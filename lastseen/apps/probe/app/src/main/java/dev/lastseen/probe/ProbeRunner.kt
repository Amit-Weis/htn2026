package dev.lastseen.probe

import android.Manifest
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.os.BatteryManager
import android.os.Build
import android.os.PowerManager
import android.util.Log
import android.webkit.WebView
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import org.json.JSONObject
import java.io.File
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.TimeZone
import java.util.concurrent.CompletableFuture
import java.util.concurrent.TimeUnit
import java.util.concurrent.TimeoutException

/**
 * Milestone A0 hardware probes, one method per probe (tasks 6a-6f) plus [runAll], which runs them in order and writes
 * the single JSON report the pipeline pulls. It measures; it builds no product feature.
 *
 * Every method blocks: call it from a background thread. None throws: failures come back as `error` fields, and
 * [runAll] records a failed step as data and carries on with the next one.
 */
class ProbeRunner(private val activity: ProbeActivity, private val ui: (String) -> Unit) {
    private val ctx: Context = activity
    @Volatile private var soakRunner: SoakRunner? = null

    companion object {
        val STEP_NAMES = listOf("device", "permissions", "display", "sensors", "camera", "exclusivity", "foregroundService", "soak", "save")
        private const val KEYS_NOTE = "hardware keys need a human: open the app, tick the checkbox if you also want the MediaSession path, press 'Start key probe', then press the buttons / Bluetooth clicker. Events are also saved to keys-*.jsonl"

        fun isoUtc(d: Date = Date()): String = SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", Locale.US).apply { timeZone = TimeZone.getTimeZone("UTC") }.format(d)

        /** The `error` field of a probe result, or null (org.json turns a stored null into the string "null", so read it raw). */
        fun errorOf(o: JSONObject?): String? {
            val v = o?.opt("error")
            return if (v == null || v === JSONNULL) null else v.toString().ifEmpty { null }
        }
    }

    private fun granted(p: String) = ctx.checkSelfPermission(p) == android.content.pm.PackageManager.PERMISSION_GRANTED

    fun cancelSoak() {
        soakRunner?.stop("stopped by user")
    }

    // ------------------------------------------------------------------ device

    fun deviceInfo(): JSObject {
        val o = JSObject()
            .put("manufacturer", Build.MANUFACTURER).put("model", Build.MODEL).put("device", Build.DEVICE)
            .put("androidRelease", Build.VERSION.RELEASE).put("sdkInt", Build.VERSION.SDK_INT)
            .put("abis", JSArray(Build.SUPPORTED_ABIS.toList()))
            .put("buildFingerprint", Build.FINGERPRINT)
            .put("cores", Runtime.getRuntime().availableProcessors())
        if (Build.VERSION.SDK_INT >= 26) WebView.getCurrentWebViewPackage()?.let { o.put("webView", "${it.packageName} ${it.versionName}") }
        val pm = ctx.getSystemService(Context.POWER_SERVICE) as PowerManager
        if (Build.VERSION.SDK_INT >= 29) o.put("thermalStatus", pm.currentThermalStatus)
        val bat: Intent? = ctx.registerReceiver(null, IntentFilter(Intent.ACTION_BATTERY_CHANGED))
        o.put("batteryTempC", (bat?.getIntExtra(BatteryManager.EXTRA_TEMPERATURE, 0) ?: 0) / 10.0)
        o.put(
            "permissions",
            JSObject()
                .put("camera", granted(Manifest.permission.CAMERA))
                .put("microphone", granted(Manifest.permission.RECORD_AUDIO))
                .put("notifications", if (Build.VERSION.SDK_INT >= 33) granted(Manifest.permission.POST_NOTIFICATIONS) else true)
                .put("activityRecognition", if (Build.VERSION.SDK_INT >= 29) granted(Manifest.permission.ACTIVITY_RECOGNITION) else true),
        )
        return o
    }

    // ------------------------------------------------------------------ 6a sensors

    fun sensors(seconds: Int = 5): JSObject =
        JSObject().put("sensors", SensorProbe.describe(ctx)).put("stream", SensorProbe.stream(ctx, seconds))

    // ------------------------------------------------------------------ 6b camera

    /** Enumerate cameras, stream [wanted] frames, encode a 640 px JPEG, then try to open two cameras at once. */
    fun camera(wanted: Int = 30): JSObject {
        val out = JSObject()
        out.put("info", runCatching { CameraProbe.describe(ctx) }.getOrElse { JSObject().put("error", it.toString()) })
        if (!CameraProbe.hasCameraPermission(ctx)) return out.put("stream", JSObject().put("error", "CAMERA permission not granted"))

        val s = CameraStreamer(activity)
        val err = s.startAndWait()
        if (err != null) return out.put("stream", JSObject().put("error", "could not open the back camera: $err"))
        val deadline = System.currentTimeMillis() + 10_000
        while (s.frames.get() < wanted + 3 && System.currentTimeMillis() < deadline) Thread.sleep(20)
        out.put("stream", s.stats().put("requestedFrames", wanted))

        // encode timing: several samples, the first one is the cold path
        val samples = JSArray()
        repeat(5) { runCatching { samples.put(s.jpegSample(640)) }.onFailure { e -> samples.put(JSObject().put("error", e.toString())) } }
        out.put("jpeg640", samples)
        s.stop()
        Thread.sleep(700) // let unbindAll finish before Camera2 opens cameras directly
        return out.put("concurrent", CameraProbe.openTwoAtOnce(ctx))
    }

    // ------------------------------------------------------------------ 6c exclusivity

    fun exclusivity(): JSObject {
        val web = WebProbe(activity)
        return try {
            ExclusivityProbe.run(activity, web, ui)
        } catch (t: Throwable) {
            Log.e(TAG, "exclusivity failed", t)
            web.close()
            JSObject().put("error", t.toString())
        }
    }

    // ------------------------------------------------------------------ 6d foreground service

    /** Starts the camera+microphone foreground service, checks it 1.5 s later, and stops it. Use [startService] to leave it running. */
    fun foregroundService(): JSObject {
        val started = startService()
        Thread.sleep(1500)
        val status = JSObject().put("running", ProbeForegroundService.running).put("startedAtMs", ProbeForegroundService.startedAtMs)
            .put("error", ProbeForegroundService.lastError ?: JSONNULL)
        stopService()
        return JSObject().put("started", started).put("statusAfter1500ms", status)
    }

    fun startService(): JSObject {
        val out = JSObject().put("sdkInt", Build.VERSION.SDK_INT)
            .put("cameraGranted", granted(Manifest.permission.CAMERA))
            .put("microphoneGranted", granted(Manifest.permission.RECORD_AUDIO))
            .put("notificationsEnabled", NotificationManagerCompat.from(ctx).areNotificationsEnabled())
        ProbeForegroundService.lastError = null
        try {
            ContextCompat.startForegroundService(ctx, Intent(ctx, ProbeForegroundService::class.java))
        } catch (t: Throwable) {
            return out.put("started", false).put("error", "startForegroundService threw: $t")
        }
        val deadline = System.currentTimeMillis() + 4000
        while (!ProbeForegroundService.running && ProbeForegroundService.lastError == null && System.currentTimeMillis() < deadline) Thread.sleep(50)
        return out.put("started", ProbeForegroundService.running).put("error", ProbeForegroundService.lastError ?: JSONNULL)
    }

    fun stopService() {
        ctx.stopService(Intent(ctx, ProbeForegroundService::class.java))
    }

    // ------------------------------------------------------------------ 6f soak

    /** Runs the camera loop for [minutes], one CSV row every 10 s (see [SoakRunner]); blocks until it finishes or [cancelSoak]. */
    fun soak(minutes: Int): JSObject {
        if (!CameraProbe.hasCameraPermission(ctx)) return JSObject().put("error", "CAMERA permission not granted")
        val s = CameraStreamer(activity)
        s.startAndWait()?.let { return JSObject().put("error", "could not open the back camera: $it") }
        val done = CompletableFuture<JSObject>()
        val runner = SoakRunner(ctx, s) { event, data ->
            if (event == "soakRow") {
                ui("soak ${data.optInt("row")}/${data.optInt("of")}  ${"%.1f".format(Locale.US, data.optDouble("fps"))} fps  thermal ${data.optString("thermalName")}  battery ${data.opt("batteryTempC")} C")
            } else if (event == "soakDone") done.complete(data)
        }
        soakRunner = runner
        runner.start(minutes)
        val result = try {
            done.get(minutes * 60L + 30, TimeUnit.SECONDS)
        } catch (_: TimeoutException) {
            runner.stop("timed out waiting for the soak to finish")
            done.getNow(JSObject().put("reason", "timed out"))
        }
        soakRunner = null
        s.stop()
        return JSObject().put("started", JSObject().put("started", true).put("minutes", minutes).put("path", runner.file?.absolutePath ?: "")).put("done", result)
    }

    // ------------------------------------------------------------------ everything, in order

    /** Runs every automated probe in order and saves `probe-report-<iso>.json` (rewritten after each step). */
    fun runAll(soakMinutes: Int): JSObject {
        val startedAt = isoUtc()
        val report = JSObject().put("schema", 1).put("startedAt", startedAt).put("app", "dev.lastseen.probe")
            .put("keys", JSObject().put("note", KEYS_NOTE))
        val steps = STEP_NAMES.associateWith { JSObject().put("name", it).put("status", "pending") }
        report.put("steps", JSArray().also { a -> steps.values.forEach { a.put(it) } })
        val fileName = "probe-report-${startedAt.replace(Regex("[:.]"), "-")}.json"
        fun persist() = ProbeStore.save(ctx, fileName, report.toString(2))

        fun stage(name: String, skip: String? = null, fn: () -> Unit) {
            val s = steps.getValue(name)
            if (skip != null) {
                s.put("status", "skipped").put("note", skip)
                persist()
                return
            }
            s.put("status", "running")
            ui("> $name")
            val t0 = System.currentTimeMillis()
            try {
                fn()
                s.put("status", "ok")
            } catch (t: Throwable) {
                Log.e(TAG, "step $name failed", t)
                s.put("status", "failed").put("error", t.message ?: t.toString())
            }
            s.put("ms", System.currentTimeMillis() - t0)
            ui("  $name: ${s.optString("status")}${if (s.has("error")) " (${s.optString("error")})" else ""}")
            persist()
        }

        /** a probe result may carry its own `error` (nothing throws): surface it as a failed step */
        fun check(r: JSObject?, what: String) {
            errorOf(r)?.let { throw IllegalStateException("$what: $it") }
        }

        stage("device") { report.put("device", deviceInfo()) }
        stage("permissions") { report.put("permissions", activity.requestAllPermissions()) }
        stage("display") { report.put("display", JSObject().put("native", DisplayInfo.describe(ctx, activity))) }
        stage("sensors") { report.put("sensors", sensors(5).also { check(it, "sensors") }) }
        stage("camera") {
            val c = camera(30)
            report.put("camera", c)
            check(c, "camera")
            errorOf(c.optJSONObject("stream"))?.let { throw IllegalStateException(it) }
        }
        stage("exclusivity") {
            val e = exclusivity()
            report.put("exclusivity", e)
            check(e, "exclusivity")
        }
        stage("foregroundService") {
            val f = foregroundService()
            report.put("foregroundService", f)
            val started = f.optJSONObject("started")
            if (started?.optBoolean("started") != true) throw IllegalStateException("service did not start: ${started?.opt("error") ?: "unknown"}")
        }
        stage("soak", if (soakMinutes > 0) null else "soak not requested (use --soak N or the Soak button)") {
            val r = soak(soakMinutes)
            report.put("soak", r)
            check(r, "soak")
        }

        report.put("finishedAt", isoUtc())
        val path = File(ProbeStore.dir(ctx), fileName).absolutePath
        stage("save") { steps.getValue("save").put("note", path) }
        Log.i(TAG, "PROBE_DONE $path") // scripts/android.mjs waits for this line
        return report
    }
}
