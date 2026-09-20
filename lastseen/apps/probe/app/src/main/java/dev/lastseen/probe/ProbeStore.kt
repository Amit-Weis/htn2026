package dev.lastseen.probe

import android.content.Context
import android.util.Log
import java.io.File

const val TAG = "LastseenProbe"

/**
 * Where probe results live. App-specific external storage is used first because `adb pull` can read it without root:
 *   /sdcard/Android/data/dev.lastseen.probe/files/probe/
 * (falls back to the internal files dir, readable with `adb shell run-as dev.lastseen.probe` on debug builds).
 */
object ProbeStore {
    fun dir(ctx: Context): File {
        val base = ctx.getExternalFilesDir(null) ?: ctx.filesDir
        return File(base, "probe").also { it.mkdirs() }
    }

    fun save(ctx: Context, name: String, text: String): File {
        val f = File(dir(ctx), safeName(name))
        f.writeText(text)
        Log.i(TAG, "saved ${f.absolutePath} (${f.length()} bytes)")
        return f
    }

    fun append(ctx: Context, name: String, text: String): File {
        val f = File(dir(ctx), safeName(name))
        f.appendText(text)
        return f
    }

    fun list(ctx: Context): List<File> = dir(ctx).listFiles()?.sortedBy { it.name } ?: emptyList()

    fun read(ctx: Context, name: String): String? = File(dir(ctx), safeName(name)).takeIf { it.isFile }?.readText()

    /** No path separators: results always stay inside the probe directory. */
    private fun safeName(name: String) = name.replace(Regex("[^A-Za-z0-9._-]"), "_")
}
