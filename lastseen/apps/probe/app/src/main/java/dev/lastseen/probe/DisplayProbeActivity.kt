package dev.lastseen.probe

import android.content.Context
import android.content.res.Configuration
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.Path
import android.graphics.Typeface
import android.os.Build
import android.os.Bundle
import android.os.SystemClock
import android.text.Layout
import android.text.StaticLayout
import android.text.TextPaint
import android.view.View
import android.view.WindowManager
import androidx.appcompat.app.AppCompatActivity
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import kotlin.math.min

/**
 * Task 7. A pure black, immersive, full-bleed screen for judging what the Xreal glasses show (checklist: docs/probe-results.md
 * section 8): corner markers reveal cropping, the grid and frame reveal aspect ratio and pillarboxing, the rotating arrow
 * shows motion, the swatches show whether black is see-through, the font ladder shows readable sizes.
 * Orientation is NOT locked: rotate the phone and watch what the glasses do.
 */
class DisplayProbeActivity : AppCompatActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        if (Build.VERSION.SDK_INT >= 28) {
            // draw under the camera cut-out so the corner markers show the true corners
            window.attributes = window.attributes.also { it.layoutInDisplayCutoutMode = WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES }
        }
        WindowCompat.setDecorFitsSystemWindows(window, false)
        setContentView(DisplayProbeView(this))
        hideBars()
    }

    override fun onWindowFocusChanged(hasFocus: Boolean) {
        super.onWindowFocusChanged(hasFocus)
        if (hasFocus) hideBars()
    }

    private fun hideBars() {
        val c = WindowInsetsControllerCompat(window, window.decorView)
        c.systemBarsBehavior = WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
        c.hide(WindowInsetsCompat.Type.systemBars())
    }
}

class DisplayProbeView(context: Context) : View(context) {
    private val d = resources.displayMetrics.density
    private val green = Color.parseColor("#39ff14")
    private val paint = Paint(Paint.ANTI_ALIAS_FLAG)
    private val text = TextPaint(Paint.ANTI_ALIAS_FLAG).apply { color = Color.WHITE }
    private val arrow = Path().apply {
        // same arrow as the original web probe, in a 200 x 200 box centred on the origin
        moveTo(0f, -85f); lineTo(55f, 5f); lineTo(18f, 5f); lineTo(18f, 80f); lineTo(-18f, 80f); lineTo(-18f, 5f); lineTo(-55f, 5f); close()
    }
    private val infoPaint = TextPaint(Paint.ANTI_ALIAS_FLAG).apply { color = Color.WHITE; textSize = 14 * d; setShadowLayer(4f, 0f, 0f, Color.BLACK) }
    private val ladderSizes = intArrayOf(24, 32, 48, 64)
    private val swatchLabels = listOf("#000000", "#202020", "#808080", "#ffffff")
    private val swatchFill = swatchLabels.map { Color.parseColor(it) }
    private val swatchInk = intArrayOf(Color.WHITE, Color.WHITE, Color.BLACK, Color.BLACK)
    private val swatchBorder = Color.parseColor("#555555")
    private val cornerColors = intArrayOf(Color.parseColor("#ff3b3b"), green, Color.parseColor("#3b8bff"), Color.parseColor("#ffd23b"))
    // allocation-free onDraw: an allocation per frame can cause GC jank, which is exactly what the arrow is there to reveal
    private var infoLayout: StaticLayout? = null

    init {
        setBackgroundColor(Color.BLACK)
        keepScreenOn = true
    }

    override fun onSizeChanged(w: Int, h: Int, oldw: Int, oldh: Int) {
        super.onSizeChanged(w, h, oldw, oldh)
        rebuildInfo(w, h)
    }

    override fun onConfigurationChanged(newConfig: Configuration?) {
        super.onConfigurationChanged(newConfig)
        rebuildInfo(width, height)
    }

    private fun rebuildInfo(w: Int, h: Int) {
        val t = describe(w, h)
        val infoW = (w - 128 * d).toInt().coerceAtLeast(1)
        infoLayout = StaticLayout.Builder.obtain(t, 0, t.length, infoPaint, infoW).setAlignment(Layout.Alignment.ALIGN_NORMAL).build()
    }

    private fun describe(w: Int, h: Int): String {
        val orient = if (w > h) "landscape" else "portrait"
        val aspect = maxOf(w, h).toFloat() / minOf(w, h).coerceAtLeast(1)
        val displays = runCatching {
            val info = DisplayInfo.describe(context)
            val list = info.getJSONArray("displays")
            (0 until list.length()).joinToString(" | ") { i -> list.getJSONObject(i).let { "#${it.getInt("id")} ${it.getInt("widthPx")}x${it.getInt("heightPx")} @${Math.round(it.getDouble("refreshRateHz"))}Hz" } }
        }.getOrDefault("?")
        return "viewport $w x $h px  =  ${Math.round(w / d)} x ${Math.round(h / d)} dp  (density $d)\n" +
            "$orient  aspect ${"%.3f".format(aspect)}:1\n" +
            "Android displays: $displays"
    }

    override fun onDraw(c: Canvas) {
        val w = width.toFloat()
        val h = height.toFloat()
        val cx = w / 2
        val cy = h / 2
        c.drawColor(Color.BLACK)

        // grid: 100 dp cells, centred (the lines through the centre are the "cross")
        paint.style = Paint.Style.STROKE
        paint.strokeWidth = 1f
        paint.color = Color.argb(56, 57, 255, 20)
        val step = 100 * d
        var x = cx % step
        while (x < w) { c.drawLine(x, 0f, x, h, paint); x += step }
        var y = cy % step
        while (y < h) { c.drawLine(0f, y, w, y, paint); y += step }
        paint.color = Color.argb(180, 255, 255, 255)
        paint.strokeWidth = 2 * d
        c.drawLine(0f, cy, w, cy, paint)
        c.drawLine(cx, 0f, cx, h, paint)

        // frame
        paint.color = Color.WHITE
        paint.strokeWidth = 3 * d
        c.drawRect(1.5f * d, 1.5f * d, w - 1.5f * d, h - 1.5f * d, paint)

        // rotating arrow: 38% of the short side, one turn per 30 s
        val box = 0.38f * min(w, h)
        paint.style = Paint.Style.FILL
        paint.color = green
        c.save()
        c.translate(cx, cy)
        c.rotate((SystemClock.uptimeMillis() % 30_000L) / 30_000f * 360f)
        c.scale(box / 200f, box / 200f)
        c.drawPath(arrow, paint)
        c.restore()

        // corner markers
        val m = 56 * d
        text.typeface = Typeface.create(Typeface.MONOSPACE, Typeface.BOLD)
        text.textSize = 18 * d
        text.color = Color.BLACK
        text.textAlign = Paint.Align.CENTER
        corner(c, 0f, 0f, m, cornerColors[0], "TL")
        corner(c, w - m, 0f, m, cornerColors[1], "TR")
        corner(c, 0f, h - m, m, cornerColors[2], "BL")
        corner(c, w - m, h - m, m, cornerColors[3], "BR")

        // info block (wraps to the width)
        infoLayout?.let { c.save(); c.translate(64 * d, 64 * d); it.draw(c); c.restore() }

        // font ladder, bottom left; sizes are dp (= CSS px at the WebView's 160 dpi baseline)
        text.textAlign = Paint.Align.LEFT
        var baseline = h - 64 * d
        for (i in ladderSizes.indices) { // bottom-up: 24 lowest
            val px = ladderSizes[i]
            text.textSize = px * d
            text.color = if (px >= 48) green else Color.WHITE
            c.drawText(LADDER_TEXT[i], 24 * d, baseline, text)
            baseline -= px * d * 1.25f
        }

        // swatches, bottom right
        text.textSize = 11 * d
        text.textAlign = Paint.Align.CENTER
        var sx = w - 64 * d - 4 * 74 * d - 3 * 6 * d
        for (i in swatchLabels.indices) {
            paint.style = Paint.Style.FILL
            paint.color = swatchFill[i]
            val top = h - 64 * d - 74 * d
            c.drawRect(sx, top, sx + 74 * d, top + 74 * d, paint)
            paint.style = Paint.Style.STROKE
            paint.strokeWidth = 1f
            paint.color = swatchBorder
            c.drawRect(sx, top, sx + 74 * d, top + 74 * d, paint)
            text.color = swatchInk[i]
            c.drawText(swatchLabels[i], sx + 37 * d, top + 74 * d - 6 * d, text)
            sx += 80 * d
        }

        postInvalidateOnAnimation()
    }

    private companion object {
        val LADDER_TEXT = arrayOf("24 keys · desk", "32 keys · desk", "48 keys · desk", "64 keys · desk")
    }

    private fun corner(c: Canvas, x: Float, y: Float, size: Float, color: Int, label: String) {
        paint.style = Paint.Style.FILL
        paint.color = color
        c.drawRect(x, y, x + size, y + size, paint)
        c.drawText(label, x + size / 2, y + size / 2 + text.textSize / 3, text)
    }
}
