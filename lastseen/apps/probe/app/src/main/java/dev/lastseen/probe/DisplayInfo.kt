package dev.lastseen.probe

import android.app.Activity
import android.content.Context
import android.content.res.Configuration
import android.hardware.display.DisplayManager
import android.os.Build
import android.util.DisplayMetrics
import android.view.Display

/**
 * Every display Android knows about. The glasses may show up as a second (presentation-capable) display or as a plain
 * mirror of the phone screen; `displayCount > 1` / `presentationDisplayIds` tells which (docs/probe-results.md section 8).
 */
object DisplayInfo {
    fun describe(ctx: Context, activity: Activity? = null): JSObject {
        val dm = ctx.getSystemService(Context.DISPLAY_SERVICE) as DisplayManager
        val displays = JSArray()
        for (d in dm.displays) {
            val m = DisplayMetrics()
            @Suppress("DEPRECATION") d.getRealMetrics(m)
            val o = JSObject().put("id", d.displayId).put("name", d.name).put("widthPx", m.widthPixels).put("heightPx", m.heightPixels)
                .put("densityDpi", m.densityDpi).put("refreshRateHz", d.refreshRate.toDouble()).put("rotation", d.rotation)
                .put("state", d.state).put("isDefault", d.displayId == Display.DEFAULT_DISPLAY)
                .put("flags", d.flags)
                .put("isPresentationCapable", d.flags and Display.FLAG_PRESENTATION != 0)
            if (Build.VERSION.SDK_INT >= 30) o.put("isHdr", d.isHdr)
            displays.put(o)
        }
        val presentation = JSArray()
        dm.getDisplays(DisplayManager.DISPLAY_CATEGORY_PRESENTATION).forEach { presentation.put(it.displayId) }
        val out = JSObject().put("displays", displays).put("presentationDisplayIds", presentation).put("displayCount", displays.length())
        if (activity != null) {
            val dmet = activity.resources.displayMetrics
            val cfg = activity.resources.configuration
            val bounds = if (Build.VERSION.SDK_INT >= 30) activity.windowManager.currentWindowMetrics.bounds else null
            out.put(
                "activityWindow",
                JSObject().put("widthPx", bounds?.width() ?: dmet.widthPixels).put("heightPx", bounds?.height() ?: dmet.heightPixels)
                    .put("density", dmet.density.toDouble())
                    .put("widthDp", cfg.screenWidthDp).put("heightDp", cfg.screenHeightDp)
                    .put("orientation", if (cfg.orientation == Configuration.ORIENTATION_LANDSCAPE) "landscape" else "portrait"),
            )
        }
        return out
    }
}
