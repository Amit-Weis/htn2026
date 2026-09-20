package dev.lastseen.probe

import android.Manifest
import android.annotation.SuppressLint
import android.content.Context
import android.content.pm.PackageManager
import android.graphics.Bitmap
import android.graphics.ImageFormat
import android.graphics.Matrix
import android.hardware.camera2.CameraCharacteristics
import android.hardware.camera2.CameraDevice
import android.hardware.camera2.CameraManager
import android.os.Build
import android.os.Handler
import android.os.HandlerThread
import android.util.Log
import android.util.Size
import androidx.appcompat.app.AppCompatActivity
import androidx.camera.core.Camera
import androidx.camera.core.CameraSelector
import androidx.camera.core.ImageAnalysis
import androidx.camera.core.ImageProxy
import androidx.camera.core.resolutionselector.ResolutionSelector
import androidx.camera.core.resolutionselector.ResolutionStrategy
import androidx.camera.lifecycle.ProcessCameraProvider
import androidx.core.content.ContextCompat
import java.io.ByteArrayOutputStream
import java.util.concurrent.CompletableFuture
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.CountDownLatch
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import kotlin.math.atan
import kotlin.math.max
import kotlin.math.min
import kotlin.math.roundToInt

/**
 * A CameraX YUV analysis stream on the back camera. This is the "native camera" in every A0 camera probe:
 * the fps test, the JPEG encode test, the exclusivity test and the soak test all use it, one at a time.
 */
class CameraStreamer(private val activity: AppCompatActivity) {
    private val executor = Executors.newSingleThreadExecutor()
    private var provider: ProcessCameraProvider? = null
    private var camera: Camera? = null

    val frames = AtomicInteger(0)
    val intervalsMs = CopyOnWriteArrayList<Double>()
    @Volatile private var lastNs = 0L
    @Volatile var streaming = false
        private set
    @Volatile var analysisSize: Size? = null
        private set
    @Volatile var rotationDegrees = 0
        private set
    @Volatile private var jpegRequest: Pair<Int, CompletableFuture<JSObject>>? = null

    /** Opens the back camera. [done] gets null on success or the failure. Must not be called on the main thread's critical path. */
    fun start(width: Int = 1280, height: Int = 720, done: (Throwable?) -> Unit) {
        val future = ProcessCameraProvider.getInstance(activity)
        future.addListener({
            try {
                val p = future.get()
                provider = p
                val analysis = ImageAnalysis.Builder()
                    .setResolutionSelector(
                        ResolutionSelector.Builder()
                            .setResolutionStrategy(ResolutionStrategy(Size(width, height), ResolutionStrategy.FALLBACK_RULE_CLOSEST_HIGHER_THEN_LOWER))
                            .build(),
                    )
                    .setBackpressureStrategy(ImageAnalysis.STRATEGY_KEEP_ONLY_LATEST)
                    .setOutputImageFormat(ImageAnalysis.OUTPUT_IMAGE_FORMAT_YUV_420_888)
                    .build()
                analysis.setAnalyzer(executor) { img -> onFrame(img) }
                p.unbindAll()
                camera = p.bindToLifecycle(activity, CameraSelector.DEFAULT_BACK_CAMERA, analysis)
                streaming = true
                done(null)
            } catch (t: Throwable) {
                Log.w(TAG, "camera start failed", t)
                done(t)
            }
        }, ContextCompat.getMainExecutor(activity))
    }

    fun stop() {
        streaming = false
        activity.runOnUiThread {
            try { provider?.unbindAll() } catch (t: Throwable) { Log.w(TAG, "unbind failed", t) }
        }
        jpegRequest?.second?.completeExceptionally(IllegalStateException("camera stopped"))
        jpegRequest = null
    }

    fun resetCounters() {
        frames.set(0)
        intervalsMs.clear()
        lastNs = 0L
    }

    private fun onFrame(img: ImageProxy) {
        try {
            val now = System.nanoTime()
            if (lastNs != 0L && intervalsMs.size < 20_000) intervalsMs.add((now - lastNs) / 1e6)
            lastNs = now
            frames.incrementAndGet()
            analysisSize = Size(img.width, img.height)
            rotationDegrees = img.imageInfo.rotationDegrees
            jpegRequest?.let { (w, fut) ->
                jpegRequest = null
                try { fut.complete(encodeJpeg(img, w)) } catch (t: Throwable) { fut.completeExceptionally(t) }
            }
        } finally {
            img.close()
        }
    }

    /** Encodes the NEXT analysis frame as an upright JPEG [targetWidth] px wide, quality 60, and times it. */
    fun jpegSample(targetWidth: Int, timeoutMs: Long = 5000): JSObject {
        val fut = CompletableFuture<JSObject>()
        jpegRequest = targetWidth to fut
        return fut.get(timeoutMs, TimeUnit.MILLISECONDS)
    }

    private fun encodeJpeg(img: ImageProxy, targetWidth: Int): JSObject {
        val t0 = System.nanoTime()
        val src = img.toBitmap()
        val m = Matrix().apply { postRotate(img.imageInfo.rotationDegrees.toFloat()) }
        val upright = Bitmap.createBitmap(src, 0, 0, src.width, src.height, m, true)
        val h = (upright.height * targetWidth.toFloat() / upright.width).roundToInt()
        val scaled = Bitmap.createScaledBitmap(upright, targetWidth, h, true)
        val t1 = System.nanoTime()
        val out = ByteArrayOutputStream()
        scaled.compress(Bitmap.CompressFormat.JPEG, 60, out)
        val t2 = System.nanoTime()
        return JSObject()
            .put("width", scaled.width).put("height", scaled.height).put("quality", 60)
            .put("bytes", out.size())
            .put("convertScaleMs", (t1 - t0) / 1e6).put("compressMs", (t2 - t1) / 1e6).put("totalEncodeMs", (t2 - t0) / 1e6)
            .put("sourceWidth", img.width).put("sourceHeight", img.height).put("rotationDegrees", img.imageInfo.rotationDegrees)
    }

    /** fps and per-frame interval stats over what was collected since [resetCounters]. */
    fun stats(): JSObject {
        // skip the first 3 intervals (auto-exposure / pipeline warm-up) so fps is steady-state
        val all = intervalsMs.toList()
        val iv = (if (all.size > 8) all.drop(3) else all).sorted()
        val n = frames.get()
        val o = JSObject().put("frames", n)
        if (iv.isNotEmpty()) {
            val mean = iv.average()
            o.put("meanFrameIntervalMs", mean).put("fps", 1000.0 / mean)
                .put("minFrameIntervalMs", iv.first()).put("maxFrameIntervalMs", iv.last())
                .put("p95FrameIntervalMs", iv[min(iv.size - 1, (iv.size * 0.95).toInt())])
        }
        analysisSize?.let { o.put("analysisWidth", it.width).put("analysisHeight", it.height) }
        return o.put("rotationDegrees", rotationDegrees)
    }
}

/** Opens the back camera and waits for it. Returns null on success, else why it failed. */
fun CameraStreamer.startAndWait(timeoutMs: Long = 8000): String? {
    val latch = CountDownLatch(1)
    var err: Throwable? = null
    start { err = it; latch.countDown() }
    latch.await(timeoutMs, TimeUnit.MILLISECONDS)
    return if (err == null && streaming) null else "${err ?: "timeout"}"
}

object CameraProbe {
    fun hasCameraPermission(ctx: Context) = ctx.checkSelfPermission(Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED

    private fun fovDeg(sensorMm: Double, focalMm: Double) = Math.toDegrees(2 * atan(sensorMm / (2 * focalMm)))

    /** Camera2 characteristics for every camera id: facing, focal length, estimated FOV, sizes, logical/physical. No permission needed. */
    fun describe(ctx: Context): JSObject {
        val mgr = ctx.getSystemService(Context.CAMERA_SERVICE) as CameraManager
        val cams = JSArray()
        val backIds = mutableListOf<String>()
        for (id in mgr.cameraIdList) {
            val c = mgr.getCameraCharacteristics(id)
            val facing = when (c.get(CameraCharacteristics.LENS_FACING)) {
                CameraCharacteristics.LENS_FACING_BACK -> "back"
                CameraCharacteristics.LENS_FACING_FRONT -> "front"
                CameraCharacteristics.LENS_FACING_EXTERNAL -> "external"
                else -> "unknown"
            }
            if (facing == "back") backIds += id
            val o = JSObject().put("id", id).put("facing", facing)
            val focals = c.get(CameraCharacteristics.LENS_INFO_AVAILABLE_FOCAL_LENGTHS)
            val sensor = c.get(CameraCharacteristics.SENSOR_INFO_PHYSICAL_SIZE)
            val active = c.get(CameraCharacteristics.SENSOR_INFO_ACTIVE_ARRAY_SIZE)
            o.put("sensorOrientation", c.get(CameraCharacteristics.SENSOR_ORIENTATION))
            if (focals != null) o.put("focalLengthsMm", JSArray(focals.map { it.toDouble() }))
            if (sensor != null) o.put("sensorPhysicalSizeMm", JSObject().put("w", sensor.width.toDouble()).put("h", sensor.height.toDouble()))
            if (active != null) o.put("activeArrayPx", JSObject().put("w", active.width()).put("h", active.height()))
            if (focals != null && focals.isNotEmpty() && sensor != null) {
                val f = focals[0].toDouble()
                val long = max(sensor.width, sensor.height).toDouble()
                val short = min(sensor.width, sensor.height).toDouble()
                // Full-sensor estimates. A 16:9 stream crops the short side, so the real FOV on the short side is smaller.
                o.put("fovLongSideDeg", fovDeg(long, f)).put("fovShortSideDeg", fovDeg(short, f))
                o.put("fovNote", "with the phone UPRIGHT (portrait) the horizontal FOV of the frame is the SHORT side; CAMERA_HFOV_DEG should be fovShortSideDeg (smaller if the stream crops it)")
            }
            val caps = c.get(CameraCharacteristics.REQUEST_AVAILABLE_CAPABILITIES)
            o.put("logicalMultiCamera", caps?.contains(CameraCharacteristics.REQUEST_AVAILABLE_CAPABILITIES_LOGICAL_MULTI_CAMERA) == true)
            if (Build.VERSION.SDK_INT >= 28) o.put("physicalCameraIds", JSArray(c.physicalCameraIds.toList()))
            val map = c.get(CameraCharacteristics.SCALER_STREAM_CONFIGURATION_MAP)
            if (map != null) {
                val yuv = map.getOutputSizes(ImageFormat.YUV_420_888)?.sortedByDescending { it.width.toLong() * it.height } ?: emptyList()
                val jpg = map.getOutputSizes(ImageFormat.JPEG)?.sortedByDescending { it.width.toLong() * it.height } ?: emptyList()
                o.put("yuvSizes", JSArray(yuv.map { "${it.width}x${it.height}" }))
                o.put("jpegLargest", jpg.firstOrNull()?.let { "${it.width}x${it.height}" } ?: JSONNULL)
                o.put("has640x480", yuv.any { it.width == 640 && it.height == 480 })
                o.put("has1280x720", yuv.any { it.width == 1280 && it.height == 720 })
                o.put("has1920x1080", yuv.any { it.width == 1920 && it.height == 1080 })
            }
            cams.put(o)
        }
        val concurrent = JSArray()
        if (Build.VERSION.SDK_INT >= 30) {
            for (set in mgr.concurrentCameraIds) concurrent.put(JSArray(set.toList()))
        }
        return JSObject().put("cameras", cams).put("backCameraIds", JSArray(backIds))
            .put("multipleBackCameras", backIds.size > 1)
            .put("concurrentCameraIdSets", concurrent)
            .put("concurrentApiAvailable", Build.VERSION.SDK_INT >= 30)
    }

    /**
     * Actually tries to open two cameras at the same time with Camera2 (CameraX must be unbound first). Never throws.
     * Prefers a pair of back cameras; otherwise records why it could not.
     */
    @SuppressLint("MissingPermission") // CAMERA is checked on the first line, and everything is inside try/catch
    fun openTwoAtOnce(ctx: Context): JSObject {
        val out = JSObject()
        try {
            if (!hasCameraPermission(ctx)) return out.put("attempted", false).put("note", "CAMERA permission not granted")
            val mgr = ctx.getSystemService(Context.CAMERA_SERVICE) as CameraManager
            val ids = mgr.cameraIdList.toList()
            val back = ids.filter { mgr.getCameraCharacteristics(it).get(CameraCharacteristics.LENS_FACING) == CameraCharacteristics.LENS_FACING_BACK }
            val pair = when {
                back.size >= 2 -> back[0] to back[1]
                back.size == 1 && ids.size >= 2 -> back[0] to ids.first { it != back[0] }
                else -> null
            } ?: return out.put("attempted", false).put("note", "fewer than two camera ids are exposed to apps (${ids.size})")
            out.put("attempted", true).put("pair", JSArray(listOf(pair.first, pair.second)))
                .put("pairIsBackBack", back.size >= 2)

            val thread = HandlerThread("probe-cam2").also { it.start() }
            val handler = Handler(thread.looper)
            val latch = CountDownLatch(2)
            val results = ConcurrentHashMap<String, String>()
            val opened = CopyOnWriteArrayList<CameraDevice>()
            for (id in listOf(pair.first, pair.second)) {
                try {
                    mgr.openCamera(id, object : CameraDevice.StateCallback() {
                        override fun onOpened(d: CameraDevice) { opened += d; results[id] = "opened"; latch.countDown() }
                        override fun onDisconnected(d: CameraDevice) { results[id] = "disconnected"; d.close(); latch.countDown() }
                        override fun onError(d: CameraDevice, e: Int) { results[id] = "error code $e"; d.close(); latch.countDown() }
                    }, handler)
                } catch (t: Throwable) {
                    results[id] = "threw $t"; latch.countDown()
                }
            }
            val finished = latch.await(5, TimeUnit.SECONDS)
            val bothOpen = results.values.count { it == "opened" } == 2
            opened.forEach { runCatching { it.close() } }
            thread.quitSafely()
            out.put("finishedInTime", finished).put("bothOpenedAtOnce", bothOpen)
                .put("perCamera", JSObject().also { o -> results.forEach { (k, v) -> o.put(k, v) } })
        } catch (t: Throwable) {
            out.put("error", t.toString())
        }
        return out
    }
}
