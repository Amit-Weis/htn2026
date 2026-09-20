package dev.lastseen.probe

import org.json.JSONArray
import org.json.JSONObject

/** org.json.JSONObject.NULL, spelled once. */
val JSONNULL: Any = JSONObject.NULL

private fun finite(v: Any?): Any? = if ((v is Double && !v.isFinite()) || (v is Float && !v.isFinite())) JSONNULL else v

/**
 * A chainable JSONObject: `JSObject().put("a", 1).put("b", 2)`. org.json throws on NaN/Infinity, which a probe can
 * legitimately measure (no data yet), so non-finite numbers are stored as null instead.
 */
class JSObject : JSONObject() {
    override fun put(name: String, value: Any?): JSObject { super.put(name, finite(value)); return this }
    override fun put(name: String, value: Boolean): JSObject { super.put(name, value); return this }
    override fun put(name: String, value: Double): JSObject { super.put(name, finite(value)); return this }
    override fun put(name: String, value: Int): JSObject { super.put(name, value); return this }
    override fun put(name: String, value: Long): JSObject { super.put(name, value); return this }
}

class JSArray() : JSONArray() {
    constructor(items: Collection<*>) : this() { items.forEach { put(it) } }
    override fun put(value: Any?): JSArray { super.put(finite(value)); return this }
}

/** Parses a JSON object string into a [JSObject] (used for what the WebView page reports back). */
fun parseObject(text: String): JSObject {
    val src = JSONObject(text)
    val out = JSObject()
    for (k in src.keys()) out.put(k, src.opt(k))
    return out
}
