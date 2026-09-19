package com.htn.dualcam;

import android.content.ContentResolver;
import android.content.ContentValues;
import android.content.Context;
import android.graphics.Bitmap;
import android.graphics.ImageFormat;
import android.hardware.camera2.CameraAccessException;
import android.hardware.camera2.CameraCaptureSession;
import android.hardware.camera2.CameraCharacteristics;
import android.hardware.camera2.CameraDevice;
import android.hardware.camera2.CameraManager;
import android.hardware.camera2.CaptureRequest;
import android.hardware.camera2.params.OutputConfiguration;
import android.hardware.camera2.params.SessionConfiguration;
import android.hardware.camera2.params.StreamConfigurationMap;
import android.media.Image;
import android.media.ImageReader;
import android.net.Uri;
import android.os.Handler;
import android.os.HandlerThread;
import android.provider.MediaStore;
import android.util.Log;
import android.util.Size;

import java.io.OutputStream;
import java.nio.ByteBuffer;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.Comparator;
import java.util.List;
import java.util.Set;

/**
 * Captures one frame from each physical camera of the back logical multi-camera
 * in a single Camera2 session and saves them side by side as one JPEG.
 *
 * Usage from Unity: construct with the activity, call capture(), then poll()
 * until it returns non-null ("OK:..." or "ERR:...").
 */
public class DualCamCapture {
    private static final String TAG = "DualCam";
    private static final int WARMUP_FRAMES = 20;       // let AE/AF converge before grabbing
    private static final long TIMEOUT_MS = 10000;
    private static final long MAX_SKEW_NS = 33000000L; // ~1 frame at 30 fps
    private static final int MAX_SIZE_CANDIDATES = 4;

    private final Context context;
    private final CameraManager manager;

    private volatile String result;
    private volatile boolean busy;

    // Everything below is only touched on the handler thread.
    private HandlerThread thread;
    private Handler handler;
    private CameraDevice device;
    private CameraCaptureSession session;
    private final ImageReader[] readers = new ImageReader[2];
    private final Image[] latest = new Image[2];
    private String[] physIds;
    private List<Size> sizes;
    private int sizeIdx;
    private int frames;
    private int rotation;
    private long lastSkewNs;
    private boolean done;

    public DualCamCapture(Context context) {
        this.context = context;
        this.manager = (CameraManager) context.getSystemService(Context.CAMERA_SERVICE);
    }

    /** Human-readable list of camera IDs, facing, and physical IDs. Also logged. */
    public String listCameras() {
        StringBuilder sb = new StringBuilder();
        try {
            for (String id : manager.getCameraIdList()) {
                CameraCharacteristics c = manager.getCameraCharacteristics(id);
                Integer facing = c.get(CameraCharacteristics.LENS_FACING);
                sb.append("id=").append(id)
                  .append(" facing=").append(facing == null ? "?" : facing == CameraCharacteristics.LENS_FACING_BACK ? "back" : facing == CameraCharacteristics.LENS_FACING_FRONT ? "front" : "external")
                  .append(" logical=").append(isLogical(c))
                  .append(" physical=").append(c.getPhysicalCameraIds())
                  .append('\n');
            }
        } catch (Exception e) {
            sb.append("listCameras failed: ").append(e);
        }
        Log.i(TAG, sb.toString());
        return sb.toString();
    }

    /** Starts an async capture. No-op if one is already running. */
    public synchronized void capture(int maxPixels, int rotationDegrees) {
        if (busy) return;
        busy = true;
        result = null;
        done = false;
        rotation = rotationDegrees;
        thread = new HandlerThread("DualCam");
        thread.start();
        handler = new Handler(thread.getLooper());
        final int maxPx = maxPixels;
        handler.post(new Runnable() {
            public void run() {
                try {
                    begin(maxPx);
                } catch (Throwable t) {
                    fail(t.toString());
                }
            }
        });
        handler.postDelayed(new Runnable() {
            public void run() {
                fail("timeout (frames=" + frames + ", last skew=" + lastSkewNs / 1000000.0 + " ms)");
            }
        }, TIMEOUT_MS);
    }

    /** Null while pending, else "OK:<where saved>" or "ERR:<reason>". */
    public String poll() {
        return result;
    }

    private static boolean isLogical(CameraCharacteristics c) {
        int[] caps = c.get(CameraCharacteristics.REQUEST_AVAILABLE_CAPABILITIES);
        if (caps == null) return false;
        for (int cap : caps) {
            if (cap == CameraCharacteristics.REQUEST_AVAILABLE_CAPABILITIES_LOGICAL_MULTI_CAMERA) return true;
        }
        return false;
    }

    private void begin(int maxPixels) throws CameraAccessException {
        String logicalId = null;
        CameraCharacteristics chars = null;
        for (String id : manager.getCameraIdList()) {
            CameraCharacteristics c = manager.getCameraCharacteristics(id);
            Integer facing = c.get(CameraCharacteristics.LENS_FACING);
            Set<String> phys = c.getPhysicalCameraIds();
            if (facing != null && facing == CameraCharacteristics.LENS_FACING_BACK
                    && isLogical(c) && phys.size() >= 2) {
                logicalId = id;
                chars = c;
                String[] arr = phys.toArray(new String[0]);
                Arrays.sort(arr);
                physIds = new String[] { arr[0], arr[1] };
                break;
            }
        }
        if (logicalId == null) {
            fail("no back logical multi-camera visible to this app. Cameras:\n" + listCameras());
            return;
        }
        Log.i(TAG, "using logical " + logicalId + " physical " + Arrays.toString(physIds));

        sizes = pickSizes(chars, maxPixels);
        sizeIdx = 0;
        manager.openCamera(logicalId, new CameraDevice.StateCallback() {
            public void onOpened(CameraDevice cam) {
                device = cam;
                trySize();
            }
            public void onDisconnected(CameraDevice cam) {
                fail("camera disconnected");
            }
            public void onError(CameraDevice cam, int error) {
                fail("camera error " + error);
            }
        }, handler);
    }

    /** Largest YUV sizes under maxPixels that match the sensor aspect ratio, biggest first. */
    private static List<Size> pickSizes(CameraCharacteristics chars, int maxPixels) {
        StreamConfigurationMap map = chars.get(CameraCharacteristics.SCALER_STREAM_CONFIGURATION_MAP);
        android.graphics.Rect active = chars.get(CameraCharacteristics.SENSOR_INFO_ACTIVE_ARRAY_SIZE);
        double aspect = (double) active.width() / active.height();
        List<Size> out = new ArrayList<Size>();
        for (Size s : map.getOutputSizes(ImageFormat.YUV_420_888)) {
            if ((long) s.getWidth() * s.getHeight() <= maxPixels
                    && Math.abs((double) s.getWidth() / s.getHeight() - aspect) < 0.02) {
                out.add(s);
            }
        }
        Collections.sort(out, new Comparator<Size>() {
            public int compare(Size a, Size b) {
                return Long.compare((long) b.getWidth() * b.getHeight(), (long) a.getWidth() * a.getHeight());
            }
        });
        return out.size() > MAX_SIZE_CANDIDATES ? out.subList(0, MAX_SIZE_CANDIDATES) : out;
    }

    private void trySize() {
        if (sizeIdx >= sizes.size()) {
            fail("session configuration failed for all candidate sizes " + sizes);
            return;
        }
        Size s = sizes.get(sizeIdx);
        Log.i(TAG, "configuring " + s);
        closeReaders();
        frames = 0;

        List<OutputConfiguration> cfgs = new ArrayList<OutputConfiguration>();
        for (int i = 0; i < 2; i++) {
            final int idx = i;
            readers[i] = ImageReader.newInstance(s.getWidth(), s.getHeight(), ImageFormat.YUV_420_888, 3);
            readers[i].setOnImageAvailableListener(new ImageReader.OnImageAvailableListener() {
                public void onImageAvailable(ImageReader r) {
                    onImage(idx, r);
                }
            }, handler);
            OutputConfiguration oc = new OutputConfiguration(readers[i].getSurface());
            oc.setPhysicalCameraId(physIds[i]);
            cfgs.add(oc);
        }

        SessionConfiguration sc = new SessionConfiguration(
                SessionConfiguration.SESSION_REGULAR, cfgs,
                new java.util.concurrent.Executor() {
                    public void execute(Runnable r) {
                        handler.post(r);
                    }
                },
                new CameraCaptureSession.StateCallback() {
                    public void onConfigured(CameraCaptureSession sess) {
                        session = sess;
                        try {
                            CaptureRequest.Builder b = device.createCaptureRequest(CameraDevice.TEMPLATE_PREVIEW);
                            b.addTarget(readers[0].getSurface());
                            b.addTarget(readers[1].getSurface());
                            b.set(CaptureRequest.CONTROL_AF_MODE, CaptureRequest.CONTROL_AF_MODE_CONTINUOUS_PICTURE);
                            sess.setRepeatingRequest(b.build(), null, handler);
                        } catch (Throwable t) {
                            fail(t.toString());
                        }
                    }
                    public void onConfigureFailed(CameraCaptureSession sess) {
                        Log.w(TAG, "configure failed at " + sizes.get(sizeIdx));
                        sizeIdx++;
                        trySize();
                    }
                });
        try {
            device.createCaptureSession(sc);
        } catch (Throwable t) {
            fail(t.toString());
        }
    }

    private void onImage(int idx, ImageReader reader) {
        Image img = reader.acquireLatestImage();
        if (img == null) return;
        if (done) {
            img.close();
            return;
        }
        if (latest[idx] != null) latest[idx].close();
        latest[idx] = img;
        if (idx == 0) frames++;
        if (frames < WARMUP_FRAMES || latest[0] == null || latest[1] == null) return;
        lastSkewNs = Math.abs(latest[0].getTimestamp() - latest[1].getTimestamp());
        if (lastSkewNs <= MAX_SKEW_NS) finish();
    }

    private void finish() {
        done = true;
        try {
            session.stopRepeating();
        } catch (Throwable ignored) {
        }
        String r;
        try {
            Image a = latest[0], b = latest[1];
            int sw = a.getWidth(), sh = a.getHeight();
            boolean swap = rotation == 90 || rotation == 270;
            int dw = swap ? sh : sw, dh = swap ? sw : sh;

            Bitmap out = Bitmap.createBitmap(dw * 2, dh, Bitmap.Config.ARGB_8888);
            int[] half = new int[dw * dh];
            yuvToRgb(a, rotation, half, dw, dh);
            out.setPixels(half, 0, dw, 0, 0, dw, dh);
            yuvToRgb(b, rotation, half, dw, dh);
            out.setPixels(half, 0, dw, dw, 0, dw, dh);

            String where = saveJpeg(out);
            r = "OK:" + where + " (" + out.getWidth() + "x" + out.getHeight()
                    + ", cams " + physIds[0] + "|" + physIds[1]
                    + ", skew " + lastSkewNs / 1000000.0 + " ms)";
            out.recycle();
        } catch (Throwable t) {
            r = "ERR:" + t;
        }
        complete(r);
    }

    private String saveJpeg(Bitmap bmp) throws java.io.IOException {
        ContentResolver cr = context.getContentResolver();
        String name = "dualcam_" + System.currentTimeMillis() + ".jpg";
        ContentValues v = new ContentValues();
        v.put(MediaStore.Images.Media.DISPLAY_NAME, name);
        v.put(MediaStore.Images.Media.MIME_TYPE, "image/jpeg");
        v.put(MediaStore.Images.Media.RELATIVE_PATH, "Pictures/DualCam");
        v.put(MediaStore.Images.Media.IS_PENDING, 1);
        Uri uri = cr.insert(MediaStore.Images.Media.EXTERNAL_CONTENT_URI, v);
        if (uri == null) throw new java.io.IOException("MediaStore insert failed");
        OutputStream os = cr.openOutputStream(uri);
        try {
            bmp.compress(Bitmap.CompressFormat.JPEG, 95, os);
        } finally {
            os.close();
        }
        v.clear();
        v.put(MediaStore.Images.Media.IS_PENDING, 0);
        cr.update(uri, v, null, null);
        return "Pictures/DualCam/" + name;
    }

    /** YUV_420_888 -> ARGB, rotated clockwise by rot (0/90/180/270) into dst (dw x dh). */
    private static void yuvToRgb(Image img, int rot, int[] dst, int dw, int dh) {
        Image.Plane[] p = img.getPlanes();
        byte[] yb = toBytes(p[0].getBuffer());
        byte[] ub = toBytes(p[1].getBuffer());
        byte[] vb = toBytes(p[2].getBuffer());
        int yRow = p[0].getRowStride();
        int uvRow = p[1].getRowStride();
        int uvPix = p[1].getPixelStride();
        int sw = img.getWidth(), sh = img.getHeight();

        for (int y = 0; y < dh; y++) {
            for (int x = 0; x < dw; x++) {
                int sx, sy;
                switch (rot) {
                    case 90:  sx = y;          sy = sh - 1 - x; break;
                    case 180: sx = sw - 1 - x; sy = sh - 1 - y; break;
                    case 270: sx = sw - 1 - y; sy = x;          break;
                    default:  sx = x;          sy = y;          break;
                }
                int Y = yb[sy * yRow + sx] & 0xff;
                int ui = (sy >> 1) * uvRow + (sx >> 1) * uvPix;
                int U = (ub[ui] & 0xff) - 128;
                int V = (vb[ui] & 0xff) - 128;
                int r = clamp(Y + ((359 * V) >> 8));
                int g = clamp(Y - ((88 * U + 183 * V) >> 8));
                int b = clamp(Y + ((454 * U) >> 8));
                dst[y * dw + x] = 0xff000000 | (r << 16) | (g << 8) | b;
            }
        }
    }

    private static byte[] toBytes(ByteBuffer buf) {
        byte[] out = new byte[buf.remaining()];
        buf.get(out);
        return out;
    }

    private static int clamp(int v) {
        return v < 0 ? 0 : (v > 255 ? 255 : v);
    }

    private void fail(String msg) {
        if (done) return;
        done = true;
        Log.e(TAG, msg);
        complete("ERR:" + msg);
    }

    private void complete(String r) {
        result = r;
        Log.i(TAG, r);
        handler.removeCallbacksAndMessages(null);
        for (int i = 0; i < 2; i++) {
            if (latest[i] != null) {
                latest[i].close();
                latest[i] = null;
            }
        }
        if (session != null) {
            session.close();
            session = null;
        }
        if (device != null) {
            device.close();
            device = null;
        }
        closeReaders();
        thread.quitSafely();
        busy = false;
    }

    private void closeReaders() {
        for (int i = 0; i < 2; i++) {
            if (readers[i] != null) {
                readers[i].close();
                readers[i] = null;
            }
        }
    }
}
