package com.forgetmenot.cv;

import android.content.Context;
import android.graphics.Bitmap;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.Paint;
import android.graphics.RectF;

import ai.onnxruntime.OnnxTensor;
import ai.onnxruntime.OrtEnvironment;
import ai.onnxruntime.OrtException;
import ai.onnxruntime.OrtSession;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.io.IOException;
import java.io.InputStream;
import java.nio.FloatBuffer;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;

/** Unity-facing hacker-card detector. The historic class name is kept for API compatibility. */
public final class MediaPipeDetector {
    private static final String MODEL_ASSET = "hacker_card.onnx";
    private static final String LABEL = "hacker_card";
    private static final int INPUT_SIZE = 640;
    private static final float NMS_IOU_THRESHOLD = 0.45f;

    /**
     * Known-size range model, matching KnownSizeDistanceEstimator on the Python side:
     *
     *     distance_m = constant / (boxWidthPx / imageWidthPx)
     *
     * The constant is normalized_width_distance_constant from the calibration JSON,
     * i.e. referenceDistance * boxWidth / frameWidth at a measured distance. Because
     * the width is normalised this is resolution independent, so the downscaled
     * inference frame gives the same answer as a full-resolution one. It is NOT FOV
     * independent: recalibrate whenever the camera changes.
     *
     * This value is the fallback used by the two-argument constructor. Zero or less
     * disables the distance_m field entirely, which leaves the JSON contract exactly
     * as it was before.
     */
    private static final float DEFAULT_DISTANCE_CONSTANT = 0f;

    private final OrtEnvironment environment;
    private final OrtSession session;
    private final String inputName;
    private final float scoreThreshold;
    private final float distanceConstant;

    public MediaPipeDetector(Context context, float scoreThreshold) {
        this(context, scoreThreshold, DEFAULT_DISTANCE_CONSTANT);
    }

    public MediaPipeDetector(Context context, float scoreThreshold, float distanceConstant) {
        if (scoreThreshold < 0f || scoreThreshold > 1f)
            throw new IllegalArgumentException("scoreThreshold must be between 0 and 1");
        this.scoreThreshold = scoreThreshold;
        this.distanceConstant = distanceConstant;
        try (InputStream stream = context.getAssets().open(MODEL_ASSET)) {
            environment = OrtEnvironment.getEnvironment();
            OrtSession.SessionOptions options = new OrtSession.SessionOptions();
            options.setIntraOpNumThreads(Math.max(2, Math.min(4,
                    Runtime.getRuntime().availableProcessors() - 1)));
            session = environment.createSession(stream.readAllBytes(), options);
            inputName = session.getInputNames().iterator().next();
        } catch (IOException | OrtException exception) {
            throw new IllegalStateException("Could not load " + MODEL_ASSET, exception);
        }
    }

    /** The calibration constant in force, so Unity can log what it is actually running with. */
    public float getDistanceConstant() {
        return distanceConstant;
    }

    public String detectRgba(byte[] rgba, int width, int height, String targetClass) {
        return detectRgba(rgba, width, height, targetClass, 0L, 0L, 0, false);
    }

    public String detectRgba(byte[] rgba, int width, int height, String targetClass,
            long frameId, long timestampMs, int rotationDegrees, boolean mirrored) {
        if (width <= 0 || height <= 0 || rgba == null || rgba.length != width * height * 4)
            throw new IllegalArgumentException("Expected positive dimensions and width*height*4 RGBA bytes");
        String target = targetClass == null ? "" : targetClass.trim();
        if (!target.isEmpty() && !LABEL.equals(target.toLowerCase(Locale.ROOT)))
            return emptyJson(width, height, frameId, timestampMs, rotationDegrees, mirrored);

        float scale = Math.min((float) INPUT_SIZE / width, (float) INPUT_SIZE / height);
        int scaledWidth = Math.round(width * scale), scaledHeight = Math.round(height * scale);
        float padX = (INPUT_SIZE - scaledWidth) / 2f, padY = (INPUT_SIZE - scaledHeight) / 2f;
        Bitmap source = rgbaBitmap(rgba, width, height);
        Bitmap letterboxed = Bitmap.createBitmap(INPUT_SIZE, INPUT_SIZE, Bitmap.Config.ARGB_8888);
        Canvas canvas = new Canvas(letterboxed);
        canvas.drawColor(Color.rgb(114, 114, 114));
        canvas.drawBitmap(source, null, new RectF(padX, padY, padX + scaledWidth, padY + scaledHeight),
                new Paint(Paint.FILTER_BITMAP_FLAG));
        source.recycle();

        float[] input = toNchw(letterboxed);
        letterboxed.recycle();
        try (OnnxTensor tensor = OnnxTensor.createTensor(environment, FloatBuffer.wrap(input),
                new long[] {1, 3, INPUT_SIZE, INPUT_SIZE})) {
            Map<String, OnnxTensor> inputs = new HashMap<>();
            inputs.put(inputName, tensor);
            try (OrtSession.Result result = session.run(inputs)) {
                float[][][] output = (float[][][]) result.get(0).getValue();
                return toJson(nms(decode(output[0], scale, padX, padY, width, height)), width, height,
                        frameId, timestampMs, rotationDegrees, mirrored);
            }
        } catch (OrtException exception) {
            throw new IllegalStateException("Hacker-card inference failed", exception);
        }
    }

    private List<Candidate> decode(float[][] output, float scale, float padX, float padY,
            int width, int height) {
        List<Candidate> candidates = new ArrayList<>();
        for (int index = 0; index < output[4].length; index++) {
            float score = output[4][index];
            if (score < scoreThreshold) continue;
            float cx = output[0][index], cy = output[1][index];
            float boxWidth = output[2][index], boxHeight = output[3][index];
            float left = clamp((cx - boxWidth / 2f - padX) / scale, 0, width);
            float top = clamp((cy - boxHeight / 2f - padY) / scale, 0, height);
            float right = clamp((cx + boxWidth / 2f - padX) / scale, 0, width);
            float bottom = clamp((cy + boxHeight / 2f - padY) / scale, 0, height);
            if (right > left && bottom > top)
                candidates.add(new Candidate(new RectF(left, top, right, bottom), score));
        }
        return candidates;
    }

    private static List<Candidate> nms(List<Candidate> candidates) {
        candidates.sort(Comparator.comparingDouble((Candidate item) -> item.score).reversed());
        List<Candidate> kept = new ArrayList<>();
        for (Candidate candidate : candidates) {
            boolean overlaps = false;
            for (Candidate prior : kept) {
                if (iou(candidate.box, prior.box) > NMS_IOU_THRESHOLD) { overlaps = true; break; }
            }
            if (!overlaps) kept.add(candidate);
        }
        return kept;
    }

    private static float iou(RectF first, RectF second) {
        float intersection = Math.max(0, Math.min(first.right, second.right) - Math.max(first.left, second.left))
                * Math.max(0, Math.min(first.bottom, second.bottom) - Math.max(first.top, second.top));
        float union = first.width() * first.height() + second.width() * second.height() - intersection;
        return union <= 0 ? 0 : intersection / union;
    }

    private static Bitmap rgbaBitmap(byte[] rgba, int width, int height) {
        int[] argb = new int[width * height];
        for (int pixel = 0, offset = 0; pixel < argb.length; pixel++, offset += 4)
            argb[pixel] = ((rgba[offset + 3] & 0xff) << 24) | ((rgba[offset] & 0xff) << 16)
                    | ((rgba[offset + 1] & 0xff) << 8) | (rgba[offset + 2] & 0xff);
        return Bitmap.createBitmap(argb, width, height, Bitmap.Config.ARGB_8888);
    }

    private static float[] toNchw(Bitmap bitmap) {
        int plane = INPUT_SIZE * INPUT_SIZE;
        int[] pixels = new int[plane];
        bitmap.getPixels(pixels, 0, INPUT_SIZE, 0, 0, INPUT_SIZE, INPUT_SIZE);
        float[] input = new float[plane * 3];
        for (int index = 0; index < plane; index++) {
            int pixel = pixels[index];
            input[index] = ((pixel >> 16) & 0xff) / 255f;
            input[plane + index] = ((pixel >> 8) & 0xff) / 255f;
            input[2 * plane + index] = (pixel & 0xff) / 255f;
        }
        return input;
    }

    private String emptyJson(int width, int height, long frameId, long timestampMs,
            int rotationDegrees, boolean mirrored) {
        return toJson(new ArrayList<>(), width, height, frameId, timestampMs, rotationDegrees, mirrored);
    }

    private String toJson(List<Candidate> detections, int width, int height, long frameId,
            long timestampMs, int rotationDegrees, boolean mirrored) {
        try {
            JSONObject root = new JSONObject();
            root.put("frame_id", frameId).put("timestamp_ms", timestampMs)
                    .put("image_width", width).put("image_height", height)
                    .put("rotation_degrees", rotationDegrees).put("mirrored", mirrored);
            JSONArray output = new JSONArray();
            for (Candidate detection : detections) {
                int x1 = Math.round(detection.box.left), y1 = Math.round(detection.box.top);
                int x2 = Math.round(detection.box.right), y2 = Math.round(detection.box.bottom);
                JSONObject item = new JSONObject()
                        .put("class_name", LABEL)
                        .put("confidence", detection.score)
                        .put("bbox", new JSONObject().put("x1", x1).put("y1", y1).put("x2", x2).put("y2", y2))
                        .put("center", new JSONObject().put("x", (x1 + x2) / 2).put("y", (y1 + y2) / 2));

                float normalizedWidth = (x2 - x1) / (float) width;
                if (distanceConstant > 0f && normalizedWidth > 0f)
                    item.put("distance_m", distanceConstant / normalizedWidth);

                output.put(item);
            }
            return root.put("detections", output).toString();
        } catch (JSONException exception) {
            throw new IllegalStateException("Could not encode detection result", exception);
        }
    }

    private static float clamp(float value, float low, float high) {
        return Math.max(low, Math.min(high, value));
    }

    public void close() {
        try { session.close(); } catch (OrtException exception) {
            throw new IllegalStateException("Could not close hacker-card detector", exception);
        }
    }

    private static final class Candidate {
        final RectF box;
        final float score;
        Candidate(RectF box, float score) { this.box = box; this.score = score; }
    }
}
