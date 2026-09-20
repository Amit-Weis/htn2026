package com.forgetmenot.cv;

import android.content.Context;
import android.graphics.Bitmap;
import android.graphics.RectF;

import com.google.mediapipe.framework.image.BitmapImageBuilder;
import com.google.mediapipe.framework.image.MPImage;
import com.google.mediapipe.tasks.components.containers.Category;
import com.google.mediapipe.tasks.components.containers.Detection;
import com.google.mediapipe.tasks.core.BaseOptions;
import com.google.mediapipe.tasks.vision.core.RunningMode;
import com.google.mediapipe.tasks.vision.objectdetector.ObjectDetector;
import com.google.mediapipe.tasks.vision.objectdetector.ObjectDetectorResult;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.util.Locale;

/** Unity-facing MediaPipe adapter. Inference is intentionally synchronous and detect-once friendly. */
public final class MediaPipeDetector {
    private final ObjectDetector detector;

    public MediaPipeDetector(Context context, float scoreThreshold) {
        BaseOptions baseOptions = BaseOptions.builder()
                .setModelAssetPath("efficientdet_lite0.tflite")
                .build();
        ObjectDetector.ObjectDetectorOptions options = ObjectDetector.ObjectDetectorOptions.builder()
                .setBaseOptions(baseOptions)
                .setRunningMode(RunningMode.IMAGE)
                .setScoreThreshold(scoreThreshold)
                .setMaxResults(-1)
                .build();
        detector = ObjectDetector.createFromOptions(context, options);
    }

    public String detectRgba(byte[] rgba, int width, int height, String targetClass) {
        if (rgba == null || rgba.length != width * height * 4)
            throw new IllegalArgumentException("Expected width*height*4 RGBA bytes");

        int[] argb = new int[width * height];
        for (int pixel = 0, offset = 0; pixel < argb.length; pixel++, offset += 4) {
            int r = rgba[offset] & 0xff;
            int g = rgba[offset + 1] & 0xff;
            int b = rgba[offset + 2] & 0xff;
            int a = rgba[offset + 3] & 0xff;
            argb[pixel] = (a << 24) | (r << 16) | (g << 8) | b;
        }

        Bitmap bitmap = Bitmap.createBitmap(argb, width, height, Bitmap.Config.ARGB_8888);
        MPImage image = new BitmapImageBuilder(bitmap).build();
        ObjectDetectorResult result = detector.detect(image);
        try {
            return toJson(result, width, height, targetClass == null ? "" : targetClass.trim());
        } finally {
            image.close();
            bitmap.recycle();
        }
    }

    private static String toJson(
            ObjectDetectorResult result, int width, int height, String targetClass) {
        try {
            JSONObject root = new JSONObject();
            root.put("image_width", width);
            root.put("image_height", height);
            JSONArray output = new JSONArray();

            for (Detection detection : result.detections()) {
                if (detection.categories().isEmpty())
                    continue;
                Category category = detection.categories().get(0);
                String name = category.categoryName();
                if (!targetClass.isEmpty() && !name.toLowerCase(Locale.ROOT)
                        .equals(targetClass.toLowerCase(Locale.ROOT)))
                    continue;

                RectF box = detection.boundingBox();
                int x1 = Math.round(box.left);
                int y1 = Math.round(box.top);
                int x2 = Math.round(box.right);
                int y2 = Math.round(box.bottom);

                JSONObject jsonDetection = new JSONObject();
                jsonDetection.put("class_name", name);
                jsonDetection.put("confidence", category.score());
                jsonDetection.put("bbox", new JSONObject()
                        .put("x1", x1).put("y1", y1).put("x2", x2).put("y2", y2));
                jsonDetection.put("center", new JSONObject()
                        .put("x", (x1 + x2) / 2).put("y", (y1 + y2) / 2));
                output.put(jsonDetection);
            }
            root.put("detections", output);
            return root.toString();
        } catch (JSONException exception) {
            throw new IllegalStateException("Could not encode detection result", exception);
        }
    }

    public void close() {
        detector.close();
    }
}
