package com.forgetmenot.detectortest;

import android.Manifest;
import android.content.pm.PackageManager;
import android.graphics.Bitmap;
import android.graphics.Matrix;
import android.hardware.camera2.CameraCharacteristics;
import android.os.Bundle;
import android.os.SystemClock;
import android.util.Log;
import android.util.Size;
import android.view.Gravity;
import android.view.ViewGroup;
import android.widget.FrameLayout;
import android.widget.TextView;

import androidx.activity.ComponentActivity;
import androidx.activity.result.ActivityResultLauncher;
import androidx.activity.result.contract.ActivityResultContracts;
import androidx.annotation.NonNull;
import androidx.camera.core.CameraSelector;
import androidx.camera.core.CameraInfo;
import androidx.camera.core.ImageAnalysis;
import androidx.camera.core.ImageProxy;
import androidx.camera.core.Preview;
import androidx.camera.camera2.interop.Camera2CameraInfo;
import androidx.camera.camera2.interop.ExperimentalCamera2Interop;
import androidx.camera.lifecycle.ProcessCameraProvider;
import androidx.camera.view.PreviewView;
import androidx.core.content.ContextCompat;

import com.forgetmenot.cv.MediaPipeDetector;
import com.google.common.util.concurrent.ListenableFuture;

import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicLong;
import java.util.Collections;

public final class MainActivity extends ComponentActivity {
    private static final String TAG = "ForgetmenotDetection";
    private static final String TARGET_CLASS = "hacker_card";
    private static final long INFERENCE_INTERVAL_MS = 0L;

    private final ExecutorService analysisExecutor = Executors.newSingleThreadExecutor();
    private final AtomicBoolean inferenceRunning = new AtomicBoolean(false);
    private final AtomicLong frameCounter = new AtomicLong();
    private PreviewView previewView;
    private DetectionOverlayView overlayView;
    private TextView statusView;
    private MediaPipeDetector detector;
    private long nextInferenceTimeMs;
    private float selectedFocalLengthMm = Float.NaN;

    private final ActivityResultLauncher<String> permissionLauncher = registerForActivityResult(
            new ActivityResultContracts.RequestPermission(), granted -> {
                if (granted) startCamera();
                else statusView.setText("Camera permission is required");
            });

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        createUi();
        detector = new MediaPipeDetector(this, 0.3f);
        if (ContextCompat.checkSelfPermission(this, Manifest.permission.CAMERA)
                == PackageManager.PERMISSION_GRANTED) {
            startCamera();
        } else {
            permissionLauncher.launch(Manifest.permission.CAMERA);
        }
    }

    private void createUi() {
        FrameLayout root = new FrameLayout(this);
        previewView = new PreviewView(this);
        previewView.setScaleType(PreviewView.ScaleType.FILL_CENTER);
        root.addView(previewView, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));

        overlayView = new DetectionOverlayView(this);
        root.addView(overlayView, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));

        statusView = new TextView(this);
        statusView.setTextColor(0xffffffff);
        statusView.setBackgroundColor(0xaa000000);
        statusView.setTextSize(16f);
        statusView.setPadding(24, 16, 24, 16);
        statusView.setText("Starting camera…");
        FrameLayout.LayoutParams statusLayout = new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        statusLayout.gravity = Gravity.TOP;
        root.addView(statusView, statusLayout);

        setContentView(root);
    }

    private void startCamera() {
        ListenableFuture<ProcessCameraProvider> providerFuture = ProcessCameraProvider.getInstance(this);
        providerFuture.addListener(() -> {
            try {
                ProcessCameraProvider provider = providerFuture.get();
                Preview preview = new Preview.Builder().build();
                preview.setSurfaceProvider(previewView.getSurfaceProvider());

                ImageAnalysis analysis = new ImageAnalysis.Builder()
                        .setTargetResolution(new Size(640, 480))
                        .setBackpressureStrategy(ImageAnalysis.STRATEGY_KEEP_ONLY_LATEST)
                        .build();
                analysis.setAnalyzer(analysisExecutor, this::analyzeFrame);

                provider.unbindAll();
                provider.bindToLifecycle(
                        this, createUltraWideCameraSelector(), preview, analysis);
                String cameraLabel = Float.isNaN(selectedFocalLengthMm)
                        ? "rear camera"
                        : "ultrawide · " + selectedFocalLengthMm + "mm";
                statusView.setText("Looking for hacker card · " + cameraLabel);
            } catch (Exception exception) {
                Log.e(TAG, "Could not start camera", exception);
                statusView.setText("Camera failed: " + exception.getMessage());
            }
        }, ContextCompat.getMainExecutor(this));
    }

    @androidx.annotation.OptIn(markerClass = ExperimentalCamera2Interop.class)
    private CameraSelector createUltraWideCameraSelector() {
        return new CameraSelector.Builder()
                .requireLensFacing(CameraSelector.LENS_FACING_BACK)
                .addCameraFilter(cameraInfos -> {
                    CameraInfo bestCamera = null;
                    float shortestFocalLength = Float.MAX_VALUE;

                    for (CameraInfo cameraInfo : cameraInfos) {
                        float[] focalLengths = Camera2CameraInfo.from(cameraInfo)
                                .getCameraCharacteristic(
                                        CameraCharacteristics.LENS_INFO_AVAILABLE_FOCAL_LENGTHS);
                        if (focalLengths == null) continue;
                        for (float focalLength : focalLengths) {
                            if (focalLength < shortestFocalLength) {
                                shortestFocalLength = focalLength;
                                bestCamera = cameraInfo;
                            }
                        }
                    }

                    if (bestCamera == null) {
                        selectedFocalLengthMm = Float.NaN;
                        return cameraInfos;
                    }
                    selectedFocalLengthMm = shortestFocalLength;
                    return Collections.singletonList(bestCamera);
                })
                .build();
    }

    private void analyzeFrame(@NonNull ImageProxy image) {
        long now = SystemClock.elapsedRealtime();
        if (now < nextInferenceTimeMs || !inferenceRunning.compareAndSet(false, true)) {
            image.close();
            return;
        }
        nextInferenceTimeMs = now + INFERENCE_INTERVAL_MS;

        try {
            int sourceRotation = image.getImageInfo().getRotationDegrees();
            Bitmap upright = rotate(image.toBitmap(), sourceRotation);
            byte[] rgba = toRgba(upright);
            long frameId = frameCounter.incrementAndGet();
            long timestampMs = image.getImageInfo().getTimestamp() / 1_000_000L;
            long inferenceStartedMs = SystemClock.elapsedRealtime();
            String json = detector.detectRgba(
                    rgba, upright.getWidth(), upright.getHeight(), TARGET_CLASS,
                    frameId, timestampMs, 0, false);
            long inferenceMs = Math.max(1L, SystemClock.elapsedRealtime() - inferenceStartedMs);
            float inferenceFps = 1000f / inferenceMs;
            upright.recycle();

            Log.d(TAG, json);
            runOnUiThread(() -> {
                overlayView.setDetectionJson(json);
                statusView.setText("Looking for: " + TARGET_CLASS + " · "
                        + inferenceMs + " ms · " + String.format("%.1f FPS", inferenceFps));
            });
        } catch (Exception exception) {
            Log.e(TAG, "Detection failed", exception);
            runOnUiThread(() -> statusView.setText("Detection failed: " + exception.getMessage()));
        } finally {
            inferenceRunning.set(false);
            image.close();
        }
    }

    private static Bitmap rotate(Bitmap source, int degrees) {
        if (degrees == 0)
            return source;
        Matrix matrix = new Matrix();
        matrix.postRotate(degrees);
        Bitmap rotated = Bitmap.createBitmap(
                source, 0, 0, source.getWidth(), source.getHeight(), matrix, true);
        source.recycle();
        return rotated;
    }

    private static byte[] toRgba(Bitmap bitmap) {
        int[] pixels = new int[bitmap.getWidth() * bitmap.getHeight()];
        bitmap.getPixels(pixels, 0, bitmap.getWidth(), 0, 0, bitmap.getWidth(), bitmap.getHeight());
        byte[] rgba = new byte[pixels.length * 4];
        for (int index = 0, offset = 0; index < pixels.length; index++, offset += 4) {
            int pixel = pixels[index];
            rgba[offset] = (byte) ((pixel >> 16) & 0xff);
            rgba[offset + 1] = (byte) ((pixel >> 8) & 0xff);
            rgba[offset + 2] = (byte) (pixel & 0xff);
            rgba[offset + 3] = (byte) ((pixel >> 24) & 0xff);
        }
        return rgba;
    }

    @Override
    protected void onDestroy() {
        if (detector != null)
            detector.close();
        analysisExecutor.shutdown();
        super.onDestroy();
    }
}
