package dev.lastseen.probe

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Color
import android.graphics.Typeface
import android.os.Build
import android.os.Bundle
import android.util.Log
import android.util.TypedValue
import android.view.KeyEvent
import android.view.View
import android.view.WindowManager
import android.widget.Button
import android.widget.CheckBox
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import androidx.appcompat.app.AppCompatActivity
import androidx.core.app.ActivityCompat
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean

/**
 * The whole UI of the hardware-probe app: a column of buttons and a log. No web layer, no Capacitor.
 *
 * Automation: `adb shell am start -n dev.lastseen.probe/.ProbeActivity --ez probe_autorun true [--ei probe_soak_minutes N]`
 * runs every automated probe and logs `PROBE_DONE <report path>` (scripts/android.mjs probe does this and pulls the files).
 */
class ProbeActivity : AppCompatActivity() {
    private lateinit var logView: TextView
    private lateinit var scroll: ScrollView
    private lateinit var status: TextView
    private lateinit var mediaSessionBox: CheckBox
    private val buttons = mutableListOf<Button>()
    private val worker = Executors.newSingleThreadExecutor()
    private val busy = AtomicBoolean(false)
    private lateinit var runner: ProbeRunner
    private var permissionLatch: CountDownLatch? = null

    private val keys = KeysProbe(this) { onKeyEvent(it) }
    private var keysFile: String? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        // The phone hangs on the wearer's chest: keep the screen on while the app is open. Orientation is deliberately not locked.
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        runner = ProbeRunner(this) { log(it) }
        setContentView(buildUi())
        log("Lastseen probe ${BuildInfo.line()}")
        handleIntent(intent)
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        handleIntent(intent)
    }

    override fun onDestroy() {
        keys.stop()
        runner.cancelSoak()
        worker.shutdownNow()
        super.onDestroy()
    }

    private fun handleIntent(i: Intent?) {
        if (i?.getBooleanExtra("probe_autorun", false) == true) {
            val soak = i.getIntExtra("probe_soak_minutes", 0)
            i.removeExtra("probe_autorun")
            log("autorun requested (soak $soak min)")
            runProbe("all") { runner.runAll(soak) }
        }
    }

    // ------------------------------------------------------------------ hardware keys (task 6e)

    /** Forwards every key the Activity sees to the key probe first; it consumes volume/media keys while probing. */
    override fun dispatchKeyEvent(event: KeyEvent): Boolean {
        if (keys.onKey(event, "activity")) return true
        return super.dispatchKeyEvent(event)
    }

    private fun onKeyEvent(e: JSObject) {
        log("key ${e.optString("action")} ${e.optString("keyName")} (${e.optInt("keyCode")}) via ${e.optString("source")} t=${e.optLong("t")}")
        keysFile?.let { name -> ProbeStore.append(this, name, e.toString() + "\n") }
    }

    private fun toggleKeys(b: Button) {
        if (keys.active) {
            keys.stop()
            b.text = "Start key probe"
            log("key probe stopped; ${keysFile ?: ""} saved")
        } else {
            keysFile = "keys-${System.currentTimeMillis()}.jsonl"
            ProbeStore.save(this, keysFile!!, "")
            keys.start(mediaSessionBox.isChecked)
            b.text = "Stop key probe"
            log("key probe started (mediaSession=${mediaSessionBox.isChecked}); press volume / media / clicker buttons")
        }
    }

    // ------------------------------------------------------------------ permissions

    /** Asks for whatever is missing (blocks the caller, which must not be the UI thread) and reports each state. */
    fun requestAllPermissions(): JSObject {
        val wanted = buildList {
            add(Manifest.permission.CAMERA)
            add(Manifest.permission.RECORD_AUDIO)
            if (Build.VERSION.SDK_INT >= 33) add(Manifest.permission.POST_NOTIFICATIONS)
            if (Build.VERSION.SDK_INT >= 29) add(Manifest.permission.ACTIVITY_RECOGNITION)
        }
        val missing = wanted.filter { checkSelfPermission(it) != PackageManager.PERMISSION_GRANTED }
        if (missing.isNotEmpty()) {
            val latch = CountDownLatch(1)
            permissionLatch = latch
            runOnUiThread { ActivityCompat.requestPermissions(this, missing.toTypedArray(), 42) }
            if (!latch.await(60, TimeUnit.SECONDS)) log("permission dialog not answered within 60 s")
        }
        fun state(p: String) = if (Build.VERSION.SDK_INT < 33 && p == Manifest.permission.POST_NOTIFICATIONS) "granted" else if (checkSelfPermission(p) == PackageManager.PERMISSION_GRANTED) "granted" else "denied"
        return JSObject().put("camera", state(Manifest.permission.CAMERA)).put("microphone", state(Manifest.permission.RECORD_AUDIO))
            .put("notifications", state(Manifest.permission.POST_NOTIFICATIONS)).put("activityRecognition", state(Manifest.permission.ACTIVITY_RECOGNITION))
    }

    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        permissionLatch?.countDown()
    }

    // ------------------------------------------------------------------ running probes

    /** One probe at a time; the result is logged and saved as probe-<name>-<epoch>.json (runAll saves its own report). */
    private fun runProbe(name: String, block: () -> JSObject) {
        if (!busy.compareAndSet(false, true)) {
            log("busy: wait for the running probe to finish")
            return
        }
        runOnUiThread { setButtons(false); status.text = "running: $name" }
        worker.execute {
            try {
                log("== $name start")
                val result = block()
                if (name != "all") ProbeStore.save(this, "probe-$name-${System.currentTimeMillis()}.json", result.toString(2))
                log("== $name done" + (ProbeRunner.errorOf(result)?.let { " (error: $it)" } ?: ""))
                log(summary(name, result))
            } catch (t: Throwable) {
                Log.e(TAG, "$name crashed", t)
                log("== $name FAILED: $t")
            } finally {
                busy.set(false)
                runOnUiThread { setButtons(true); status.text = "idle" }
            }
        }
    }

    private fun summary(name: String, r: JSObject): String = when (name) {
        "all" -> r.optJSONArray("steps")?.let { a -> (0 until a.length()).joinToString("\n") { i -> a.getJSONObject(i).let { s -> "  ${s.optString("name")}: ${s.optString("status")}" } } } ?: ""
        else -> r.toString(2).let { if (it.length > 1500) it.take(1500) + "\n... (full JSON saved on the device)" else it }
    }

    private fun setButtons(enabled: Boolean) = buttons.forEach { it.isEnabled = enabled }

    /** Appends to the on-screen log and logcat (tag LastseenProbe). Safe from any thread. */
    fun log(line: String) {
        Log.i(TAG, line)
        runOnUiThread {
            logView.append(line + "\n")
            if (logView.length() > 20_000) logView.text = logView.text.takeLast(15_000)
            scroll.post { scroll.fullScroll(View.FOCUS_DOWN) }
        }
    }

    // ------------------------------------------------------------------ UI

    private fun dp(v: Int) = TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, v.toFloat(), resources.displayMetrics).toInt()

    private fun button(label: String, onClick: (Button) -> Unit): Button = Button(this).apply {
        text = label
        isAllCaps = false
        setOnClickListener { onClick(this) }
    }

    private fun probeButton(label: String, name: String, block: () -> JSObject) = button(label) { runProbe(name, block) }.also { buttons += it }

    private fun buildUi(): View {
        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(12), dp(12), dp(12), dp(12))
            setBackgroundColor(Color.parseColor("#101418"))
        }
        root.addView(TextView(this).apply { text = "Lastseen hardware probe"; setTextColor(Color.WHITE); textSize = 20f; typeface = Typeface.DEFAULT_BOLD })
        status = TextView(this).apply { text = "idle"; setTextColor(Color.parseColor("#39ff14")) }
        root.addView(status)

        fun row(vararg views: View) = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            views.forEach { addView(it, LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f)) }
        }.also { root.addView(it) }

        row(
            probeButton("Run all probes", "all") { runner.runAll(0) },
            probeButton("Run all + 10 min soak", "all") { runner.runAll(10) },
        )
        row(
            probeButton("Sensors (5 s)", "sensors") { runner.sensors(5) },
            probeButton("Camera", "camera") { runner.camera(30) },
            probeButton("Exclusivity", "exclusivity") { runner.exclusivity() },
        )
        row(
            probeButton("Soak 10 min", "soak") { runner.soak(10) },
            button("Stop soak") { runner.cancelSoak() },
        )
        row(
            button("Start FG service") { runProbe("foreground-service") { runner.startService().also { log("service notification: pull down the shade, press Stop") } } },
            button("Stop FG service") { runner.stopService(); log("service stopped") },
        )
        mediaSessionBox = CheckBox(this).apply { text = "also listen via MediaSession"; setTextColor(Color.WHITE) }
        row(button("Start key probe") { toggleKeys(it) }, mediaSessionBox)
        row(
            button("Display probe (glasses)") { startActivity(Intent(this, DisplayProbeActivity::class.java)) },
            button("Files") {
                val files = ProbeStore.list(this)
                log("${ProbeStore.dir(this)}\n" + files.joinToString("\n") { "  ${it.name} (${it.length()} B)" })
            },
        )

        logView = TextView(this).apply { setTextColor(Color.parseColor("#d0d7de")); typeface = Typeface.MONOSPACE; textSize = 11f; setTextIsSelectable(true) }
        scroll = ScrollView(this).apply { addView(logView) }
        root.addView(scroll, LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, 0, 1f))
        return root
    }
}

/** One line for the log header so a pasted log says what build it came from. */
private object BuildInfo {
    fun line() = "${Build.MANUFACTURER} ${Build.MODEL}, Android ${Build.VERSION.RELEASE} (API ${Build.VERSION.SDK_INT})"
}
