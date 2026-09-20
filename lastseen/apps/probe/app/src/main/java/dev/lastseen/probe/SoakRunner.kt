package dev.lastseen.probe

import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.os.BatteryManager
import android.os.Build
import android.os.PowerManager
import android.util.Log
import java.io.File
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.TimeZone
import java.util.concurrent.Executors
import java.util.concurrent.ScheduledFuture
import java.util.concurrent.TimeUnit

/**
 * Task 6f. While the camera streams, log one CSV row every 10 s: fps, thermal status, battery temperature and level.
 * The file is flushed row by row so a crash (or the OS killing the app when it overheats) still leaves data behind.
 */
class SoakRunner(
    private val ctx: Context,
    private val streamer: CameraStreamer,
    private val emit: (String, JSObject) -> Unit,
) {
    companion object {
        const val HEADER = "time_iso,elapsed_s,fps,frames_in_window,thermal_status,thermal_status_name,thermal_headroom_10s,battery_temp_c,battery_level_pct,battery_current_ua,charging\n"
        private val THERMAL = listOf("NONE", "LIGHT", "MODERATE", "SEVERE", "CRITICAL", "EMERGENCY", "SHUTDOWN")
    }

    private val exec = Executors.newSingleThreadScheduledExecutor()
    private var task: ScheduledFuture<*>? = null
    @Volatile var running = false
        private set
    @Volatile var file: File? = null
        private set
    @Volatile var rows = 0
        private set
    @Volatile var totalRows = 0
        private set

    private var startMs = 0L
    private var lastFrames = 0
    private var lastTickMs = 0L
    private val iso = SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss'Z'", Locale.US).apply { timeZone = TimeZone.getTimeZone("UTC") }

    fun start(minutes: Int) {
        if (running) return
        running = true
        totalRows = minutes * 6
        rows = 0
        startMs = System.currentTimeMillis()
        lastTickMs = startMs
        lastFrames = streamer.frames.get()
        val name = "soak-${SimpleDateFormat("yyyyMMdd-HHmmss", Locale.US).format(Date(startMs))}.csv"
        file = ProbeStore.save(ctx, name, HEADER)
        Log.i(TAG, "soak started: $minutes min -> ${file?.absolutePath}")
        task = exec.scheduleAtFixedRate({ tick() }, 10, 10, TimeUnit.SECONDS)
    }

    fun stop(reason: String = "stopped") {
        task?.cancel(false)
        task = null
        if (running) {
            running = false
            emit("soakDone", JSObject().put("reason", reason).put("rows", rows).put("path", file?.absolutePath ?: ""))
            Log.i(TAG, "soak $reason after $rows rows")
        }
        exec.shutdown()
    }

    private fun tick() {
        try {
            val now = System.currentTimeMillis()
            val frames = streamer.frames.get()
            val dtS = (now - lastTickMs) / 1000.0
            val fps = if (dtS > 0) (frames - lastFrames) / dtS else 0.0
            val inWindow = frames - lastFrames
            lastFrames = frames
            lastTickMs = now

            val pm = ctx.getSystemService(Context.POWER_SERVICE) as PowerManager
            val thermal = if (Build.VERSION.SDK_INT >= 29) pm.currentThermalStatus else -1
            val headroom = if (Build.VERSION.SDK_INT >= 30) pm.getThermalHeadroom(10) else Float.NaN
            val bat: Intent? = ctx.registerReceiver(null, IntentFilter(Intent.ACTION_BATTERY_CHANGED))
            val tempC = (bat?.getIntExtra(BatteryManager.EXTRA_TEMPERATURE, Int.MIN_VALUE) ?: Int.MIN_VALUE).let { if (it == Int.MIN_VALUE) Double.NaN else it / 10.0 }
            val level = bat?.getIntExtra(BatteryManager.EXTRA_LEVEL, -1) ?: -1
            val scale = bat?.getIntExtra(BatteryManager.EXTRA_SCALE, 100) ?: 100
            val pct = if (level >= 0) level * 100.0 / scale else Double.NaN
            val status = bat?.getIntExtra(BatteryManager.EXTRA_STATUS, -1) ?: -1
            val charging = status == BatteryManager.BATTERY_STATUS_CHARGING || status == BatteryManager.BATTERY_STATUS_FULL
            val bm = ctx.getSystemService(Context.BATTERY_SERVICE) as BatteryManager
            val currentUa = bm.getIntProperty(BatteryManager.BATTERY_PROPERTY_CURRENT_NOW)

            val row = listOf(
                iso.format(Date(now)), "%.0f".format(Locale.US, (now - startMs) / 1000.0), "%.2f".format(Locale.US, fps), inWindow,
                thermal, if (thermal in THERMAL.indices) THERMAL[thermal] else "n/a",
                if (headroom.isNaN()) "" else "%.2f".format(Locale.US, headroom),
                if (tempC.isNaN()) "" else "%.1f".format(Locale.US, tempC),
                if (pct.isNaN()) "" else "%.0f".format(Locale.US, pct),
                currentUa, charging,
            ).joinToString(",") + "\n"
            ProbeStore.append(ctx, file!!.name, row)
            rows++
            emit(
                "soakRow",
                JSObject().put("row", rows).put("of", totalRows).put("elapsedS", (now - startMs) / 1000.0).put("fps", fps)
                    .put("thermalStatus", thermal).put("thermalName", if (thermal in THERMAL.indices) THERMAL[thermal] else "n/a")
                    .put("batteryTempC", tempC).put("batteryPct", pct).put("charging", charging),
            )
            if (rows >= totalRows) stop("finished")
        } catch (t: Throwable) {
            Log.w(TAG, "soak tick failed", t)
        }
    }
}
