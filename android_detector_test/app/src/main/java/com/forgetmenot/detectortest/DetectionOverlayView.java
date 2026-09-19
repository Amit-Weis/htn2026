package com.forgetmenot.detectortest;

import android.content.Context;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.Paint;
import android.graphics.RectF;
import android.util.AttributeSet;
import android.view.View;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.List;
import java.util.Locale;

/** Draws detector pixel coordinates over a PreviewView using center-crop scaling. */
public final class DetectionOverlayView extends View {
    private static final class Item {
        final String label;
        final float confidence;
        final RectF box;

        Item(String label, float confidence, RectF box) {
            this.label = label;
            this.confidence = confidence;
            this.box = box;
        }
    }

    private final Paint boxPaint = new Paint();
    private final Paint textPaint = new Paint();
    private final Paint textBackgroundPaint = new Paint();
    private final Paint centerPaint = new Paint();
    private final List<Item> items = new ArrayList<>();
    private int imageWidth;
    private int imageHeight;

    public DetectionOverlayView(Context context, AttributeSet attributes) {
        super(context, attributes);
        boxPaint.setColor(Color.rgb(76, 220, 114));
        boxPaint.setStyle(Paint.Style.STROKE);
        boxPaint.setStrokeWidth(6f);
        textPaint.setColor(Color.WHITE);
        textPaint.setTextSize(42f);
        textPaint.setAntiAlias(true);
        textBackgroundPaint.setColor(0xcc000000);
        centerPaint.setColor(Color.RED);
        centerPaint.setStyle(Paint.Style.FILL);
    }

    public DetectionOverlayView(Context context) {
        this(context, null);
    }

    public void setDetectionJson(String json) {
        items.clear();
        try {
            JSONObject root = new JSONObject(json);
            imageWidth = root.getInt("image_width");
            imageHeight = root.getInt("image_height");
            JSONArray detections = root.getJSONArray("detections");
            for (int index = 0; index < detections.length(); index++) {
                JSONObject detection = detections.getJSONObject(index);
                JSONObject box = detection.getJSONObject("bbox");
                items.add(new Item(
                        detection.getString("class_name"),
                        (float) detection.getDouble("confidence"),
                        new RectF(
                                box.getInt("x1"), box.getInt("y1"),
                                box.getInt("x2"), box.getInt("y2"))));
            }
        } catch (Exception exception) {
            items.clear();
        }
        postInvalidateOnAnimation();
    }

    @Override
    protected void onDraw(Canvas canvas) {
        super.onDraw(canvas);
        if (imageWidth <= 0 || imageHeight <= 0)
            return;

        float scale = Math.max(getWidth() / (float) imageWidth, getHeight() / (float) imageHeight);
        float offsetX = (getWidth() - imageWidth * scale) * 0.5f;
        float offsetY = (getHeight() - imageHeight * scale) * 0.5f;
        for (Item item : items) {
            RectF box = new RectF(
                    item.box.left * scale + offsetX,
                    item.box.top * scale + offsetY,
                    item.box.right * scale + offsetX,
                    item.box.bottom * scale + offsetY);
            canvas.drawRect(box, boxPaint);
            canvas.drawCircle(box.centerX(), box.centerY(), 8f, centerPaint);

            String label = String.format(
                    Locale.US, "%s %.0f%%", item.label.toUpperCase(Locale.US), item.confidence * 100f);
            float labelWidth = textPaint.measureText(label);
            float labelTop = Math.max(0f, box.top - 52f);
            canvas.drawRect(box.left, labelTop, box.left + labelWidth + 20f, labelTop + 52f,
                    textBackgroundPaint);
            canvas.drawText(label, box.left + 10f, labelTop + 40f, textPaint);
        }
    }
}
