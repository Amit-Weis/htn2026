package dev.lastseen.probe

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class JsonTest {
    @Test fun chainablePut() {
        val o = JSObject().put("a", 1).put("b", "x").put("c", true).put("d", 2.5).put("e", 7L)
        assertEquals(1, o.getInt("a"))
        assertEquals("x", o.getString("b"))
        assertTrue(o.getBoolean("c"))
        assertEquals(2.5, o.getDouble("d"), 0.0)
        assertEquals(7L, o.getLong("e"))
    }

    @Test fun nonFiniteNumbersBecomeNullInsteadOfThrowing() {
        val o = JSObject().put("nan", Double.NaN).put("inf", Double.POSITIVE_INFINITY).put("boxed", Double.NaN as Any?)
        assertTrue(o.isNull("nan"))
        assertTrue(o.isNull("inf"))
        assertTrue(o.isNull("boxed"))
        assertTrue(o.has("nan")) // stored as JSON null, not dropped
    }

    @Test fun arrayCopiesACollection() {
        val a = JSArray(listOf("back", "front"))
        assertEquals(2, a.length())
        assertEquals("front", a.getString(1))
    }

    @Test fun parseObjectRoundTrips() {
        val o = parseObject("""{"ok":false,"ms":12,"error":{"name":"NotAllowedError","message":"denied"},"tracks":[]}""")
        assertFalse(o.getBoolean("ok"))
        assertEquals("NotAllowedError", o.getJSONObject("error").getString("name"))
        assertEquals(0, o.getJSONArray("tracks").length())
    }

    @Test fun errorOfIgnoresJsonNull() {
        assertNull(ProbeRunner.errorOf(JSObject().put("error", JSONNULL)))
        assertNull(ProbeRunner.errorOf(JSObject().put("x", 1)))
        assertNull(ProbeRunner.errorOf(null))
        assertEquals("boom", ProbeRunner.errorOf(JSObject().put("error", "boom")))
    }
}

class ExclusivitySummaryTest {
    @Test fun inconclusiveWhenNativeNeverOpened() {
        val s = ExclusivitySummary.build(nativeHeld = false, webAudioOk = null, webVideoOk = null, nativeSurvivedWebVideo = false, nativeOpenedWhileWebHolds = null)
        assertTrue(s.getString("verdict").startsWith("inconclusive"))
        assertTrue(s.isNull("nativeKeepsStreamingWhenWebOpensCamera"))
    }

    @Test fun webAllowedMeansEnforceInCode() {
        val s = ExclusivitySummary.build(true, webAudioOk = true, webVideoOk = true, nativeSurvivedWebVideo = false, nativeOpenedWhileWebHolds = false)
        assertTrue(s.getString("verdict").startsWith("WebView CAN open the camera"))
        assertFalse(s.getBoolean("nativeKeepsStreamingWhenWebOpensCamera"))
        assertFalse(s.getBoolean("nativeCanOpenWhileWebHoldsCamera"))
    }

    @Test fun webRefusedMeansNativeOwnsTheCamera() {
        val s = ExclusivitySummary.build(true, webAudioOk = true, webVideoOk = false, nativeSurvivedWebVideo = true, nativeOpenedWhileWebHolds = null)
        assertTrue(s.getString("verdict").startsWith("WebView is refused"))
        assertTrue(s.getBoolean("webAudioWhileNativeCamera"))
        assertFalse(s.getBoolean("webVideoWhileNativeCamera"))
        assertTrue(s.isNull("nativeCanOpenWhileWebHoldsCamera"))
    }
}
