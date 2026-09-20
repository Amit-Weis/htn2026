package dev.lastseen.probe

import android.content.Context
import android.content.pm.PackageManager
import android.hardware.Sensor
import android.hardware.SensorEvent
import android.hardware.SensorEventListener
import android.hardware.SensorManager
import android.os.Build
import android.os.Handler
import android.os.HandlerThread

/** Task 6a: which motion sensors exist, their advertised rates, and the rates actually achieved. */
object SensorProbe {
    private val TYPES = linkedMapOf(
        "rotation_vector" to Sensor.TYPE_ROTATION_VECTOR,
        "game_rotation_vector" to Sensor.TYPE_GAME_ROTATION_VECTOR,
        "step_detector" to Sensor.TYPE_STEP_DETECTOR,
        "accelerometer" to Sensor.TYPE_ACCELEROMETER,
        "gyroscope" to Sensor.TYPE_GYROSCOPE,
        "magnetometer" to Sensor.TYPE_MAGNETIC_FIELD,
    )

    /** Streamed for the requested duration. The step detector only fires when someone walks. */
    private val STREAMED = listOf("rotation_vector", "step_detector", "accelerometer")

    private fun reportingMode(m: Int) = when (m) {
        Sensor.REPORTING_MODE_CONTINUOUS -> "continuous"
        Sensor.REPORTING_MODE_ON_CHANGE -> "on_change"
        Sensor.REPORTING_MODE_ONE_SHOT -> "one_shot"
        Sensor.REPORTING_MODE_SPECIAL_TRIGGER -> "special_trigger"
        else -> "unknown($m)"
    }

    fun describe(ctx: Context): JSArray {
        val sm = ctx.getSystemService(Context.SENSOR_SERVICE) as SensorManager
        val out = JSArray()
        for ((name, type) in TYPES) {
            val s = sm.getDefaultSensor(type)
            val o = JSObject().put("key", name).put("androidType", type).put("present", s != null)
            if (s != null) {
                val minDelay = s.minDelay // microseconds; 0 for on-change / special sensors
                o.put("name", s.name).put("vendor", s.vendor).put("version", s.version)
                    .put("minDelayUs", minDelay)
                    .put("maxRateHzAdvertised", if (minDelay > 0) 1_000_000.0 / minDelay else JSONNULL)
                    .put("maxDelayUs", s.maxDelay)
                    .put("maxRange", s.maximumRange.toDouble())
                    .put("resolution", s.resolution.toDouble())
                    .put("powerMa", s.power.toDouble())
                    .put("reportingMode", reportingMode(s.reportingMode))
                    .put("wakeUp", s.isWakeUpSensor)
                    .put("fifoMaxEventCount", s.fifoMaxEventCount)
            }
            out.put(o)
        }
        return out
    }

    private class Counter {
        var n = 0
        var firstNs = 0L
        var lastNs = 0L
        var maxGapNs = 0L
        fun record(ns: Long) {
            if (n == 0) firstNs = ns else maxGapNs = maxOf(maxGapNs, ns - lastNs)
            lastNs = ns
            n++
        }
    }

    /** Blocks for [seconds]; call from a worker thread. */
    fun stream(ctx: Context, seconds: Int): JSObject {
        val sm = ctx.getSystemService(Context.SENSOR_SERVICE) as SensorManager
        val counters = STREAMED.associateWith { Counter() }
        val byType = TYPES.filterKeys { it in STREAMED }.entries.associate { (k, t) -> t to k }
        val thread = HandlerThread("probe-sensors").also { it.start() }
        val handler = Handler(thread.looper)
        val listener = object : SensorEventListener {
            override fun onSensorChanged(e: SensorEvent) {
                byType[e.sensor.type]?.let { counters[it]?.record(e.timestamp) }
            }
            override fun onAccuracyChanged(s: Sensor?, a: Int) {}
        }

        val registered = JSObject()
        val notes = JSObject()
        for (key in STREAMED) {
            val s = sm.getDefaultSensor(TYPES.getValue(key))
            if (s == null) { registered.put(key, false); notes.put(key, "sensor not present"); continue }
            try {
                // 0 = as fast as the hardware allows (Android 12+ caps at 200 Hz without HIGH_SAMPLING_RATE_SENSORS)
                registered.put(key, sm.registerListener(listener, s, 0, 0, handler))
            } catch (t: Throwable) {
                registered.put(key, false); notes.put(key, "register failed: $t")
            }
        }
        val t0 = System.nanoTime()
        try { Thread.sleep(seconds * 1000L) } catch (_: InterruptedException) {}
        val wallS = (System.nanoTime() - t0) / 1e9
        sm.unregisterListener(listener)
        thread.quitSafely()

        val result = JSObject().put("seconds", wallS)
        for ((key, c) in counters) {
            val spanS = if (c.n > 1) (c.lastNs - c.firstNs) / 1e9 else 0.0
            val o = JSObject().put("registered", registered.optBoolean(key)).put("events", c.n)
                .put("hzWall", c.n / wallS)
                .put("hzSensorClock", if (spanS > 0) (c.n - 1) / spanS else JSONNULL)
                .put("maxGapMs", c.maxGapNs / 1e6)
            notes.optString(key, "").takeIf { it.isNotEmpty() }?.let { o.put("note", it) }
            if (key == "step_detector") {
                val granted = Build.VERSION.SDK_INT < 29 ||
                    ctx.checkSelfPermission(android.Manifest.permission.ACTIVITY_RECOGNITION) == PackageManager.PERMISSION_GRANTED
                o.put("activityRecognitionGranted", granted)
                o.put("note", if (!granted) "ACTIVITY_RECOGNITION not granted: the step detector delivers nothing" else "needs the wearer to WALK during the test; 0 events while still is expected")
            }
            result.put(key, o)
        }
        return result
    }
}
