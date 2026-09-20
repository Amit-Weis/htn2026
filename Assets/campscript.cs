using System.Collections.Generic;
using UnityEngine;
using UnityEngine.UI;
using Forgetmenot;

[DefaultExecutionOrder(100)]
public class HackerCardHud : MonoBehaviour
{
    public enum Corner { TopRight, TopLeft, BottomRight, BottomLeft }

    [Header("References")]
    [SerializeField] Camera viewCam;
    [SerializeField] PhoneObjectDetector detector;
    [SerializeField] RectTransform panel;   // the Canvas RectTransform to place
    [SerializeField] RectTransform feedRect; // the RawImage rect the boxes live in

    [Header("Placement")]
    [SerializeField] Corner corner = Corner.TopRight;
    [SerializeField, Min(0.3f)] float distance = 1.5f;
    [SerializeField, Range(0.05f, 0.6f)] float heightFrac = 0.25f;
    [SerializeField, Range(0f, 0.25f)] float margin = 0.06f;
    [SerializeField] float pixelsPerMetre = 1000f;
    [SerializeField] bool autoPlace = true;

    [Header("Box mapping")]
    [Tooltip("Must match the RawImage uvRect. Height -1 means flipped.")]
    [SerializeField] bool feedFlippedVertically = true;
    [Tooltip("Must match the RawImage uvRect. Width -1 means mirrored.")]
    [SerializeField] bool feedMirroredHorizontally = false;

    [Header("Boxes")]
    [SerializeField] Color boxColor = new Color(0.72f, 0.35f, 1f, 1f);
    [SerializeField, Min(1f)] float boxThickness = 4f;
    [SerializeField] bool showConfidence = true;
    [SerializeField] Font labelFont;
    [SerializeField, Min(1)] int labelFontSize = 18;

    readonly List<BoxView> pool = new();
    int lastImgW, lastImgH;
    float lastFov, lastAspect, lastHeightFrac, lastMargin, lastDistance;
    int lastCorner = -1;

    class BoxView
    {
        public RectTransform root;
        public Text label;
    }

    // ------------------------------------------------------------- lifecycle

    void OnEnable()
    {
        if (detector == null)
        {
            Debug.LogError("[HackerCardHud] detector not assigned.", this);
            return;
        }
        if (feedRect == null)
        {
            Debug.LogError("[HackerCardHud] feedRect not assigned.", this);
            return;
        }
        detector.onDetections.AddListener(OnFrame);
    }

    void OnDisable()
    {
        if (detector != null) detector.onDetections.RemoveListener(OnFrame);
    }

    void LateUpdate()
    {
        if (!autoPlace || viewCam == null || panel == null || lastImgW <= 0) return;

        bool changed =
            !Mathf.Approximately(lastFov, viewCam.fieldOfView) ||
            !Mathf.Approximately(lastAspect, viewCam.aspect) ||
            !Mathf.Approximately(lastHeightFrac, heightFrac) ||
            !Mathf.Approximately(lastMargin, margin) ||
            !Mathf.Approximately(lastDistance, distance) ||
            lastCorner != (int)corner;

        if (changed) Place(lastImgW, lastImgH);
    }

    // ----------------------------------------------------------- positioning
    public void Place(int imgW, int imgH)
    {
        if (viewCam == null || panel == null || imgW <= 0 || imgH <= 0) return;

        lastFov = viewCam.fieldOfView;
        lastAspect = viewCam.aspect;
        lastHeightFrac = heightFrac;
        lastMargin = margin;
        lastDistance = distance;
        lastCorner = (int)corner;

        float aspect = (float)imgW / imgH;
        float viewH = 2f * distance * Mathf.Tan(viewCam.fieldOfView * 0.5f * Mathf.Deg2Rad);
        float viewW = viewH * viewCam.aspect;

        float h = viewH * heightFrac;
        float w = h * aspect;

        float x = viewW * 0.5f - w * 0.5f - viewW * margin;
        float y = viewH * 0.5f - h * 0.5f - viewH * margin;

        if (corner == Corner.TopLeft || corner == Corner.BottomLeft) x = -x;
        if (corner == Corner.BottomLeft || corner == Corner.BottomRight) y = -y;

        panel.sizeDelta = new Vector2(w * pixelsPerMetre, h * pixelsPerMetre);
        panel.localScale = Vector3.one / pixelsPerMetre;
        panel.localRotation = Quaternion.identity;
        panel.localPosition = new Vector3(x, y, distance);
    }

    // --------------------------------------------------------------- overlay

    void OnFrame(DetectionFrameResult frame)
    {
        if (frame == null || feedRect == null) return;

        int w = frame.image_width, h = frame.image_height;
        if (w <= 0 || h <= 0) return;

        if (w != lastImgW || h != lastImgH)
        {
            lastImgW = w;
            lastImgH = h;
            if (autoPlace) Place(w, h);
        }

        var dets = frame.detections ?? new DetectionResult[0];

        for (int i = 0; i < dets.Length; i++)
        {
            var d = dets[i];
            if (d == null) continue;

            var view = Get(i);

            // Image pixels are top-down; UI anchors are bottom-up.
            float ax1 = Mathf.Clamp01((float)d.bbox.x1 / w);
            float ax2 = Mathf.Clamp01((float)d.bbox.x2 / w);
            float ay1 = Mathf.Clamp01(1f - (float)d.bbox.y2 / h);
            float ay2 = Mathf.Clamp01(1f - (float)d.bbox.y1 / h);

            if (feedFlippedVertically)
            {
                float t = ay1;
                ay1 = 1f - ay2;
                ay2 = 1f - t;
            }
            if (feedMirroredHorizontally)
            {
                float t = ax1;
                ax1 = 1f - ax2;
                ax2 = 1f - t;
            }

            view.root.anchorMin = new Vector2(Mathf.Min(ax1, ax2), Mathf.Min(ay1, ay2));
            view.root.anchorMax = new Vector2(Mathf.Max(ax1, ax2), Mathf.Max(ay1, ay2));
            view.root.offsetMin = Vector2.zero;
            view.root.offsetMax = Vector2.zero;
            view.root.gameObject.SetActive(true);

            if (view.label != null)
            {
                view.label.enabled = showConfidence;
                view.label.text = $"{d.class_name} {d.confidence:0.00}";
                view.label.color = boxColor;
            }
        }

        for (int i = dets.Length; i < pool.Count; i++)
            pool[i].root.gameObject.SetActive(false);
    }

    BoxView Get(int index)
    {
        while (pool.Count <= index)
        {
            var rootGo = new GameObject($"Box{pool.Count}", typeof(RectTransform));
            var root = rootGo.GetComponent<RectTransform>();
            root.SetParent(feedRect, false);

            Edge(root, new Vector2(0f, 1f), new Vector2(1f, 1f), new Vector2(0f, boxThickness));
            Edge(root, new Vector2(0f, 0f), new Vector2(1f, 0f), new Vector2(0f, boxThickness));
            Edge(root, new Vector2(0f, 0f), new Vector2(0f, 1f), new Vector2(boxThickness, 0f));
            Edge(root, new Vector2(1f, 0f), new Vector2(1f, 1f), new Vector2(boxThickness, 0f));

            Text label = null;
            if (labelFont != null)
            {
                var labelGo = new GameObject("Label", typeof(Text));
                var labelRt = labelGo.GetComponent<RectTransform>();
                labelRt.SetParent(root, false);
                labelRt.anchorMin = new Vector2(0f, 1f);
                labelRt.anchorMax = new Vector2(1f, 1f);
                labelRt.pivot = new Vector2(0f, 0f);
                labelRt.offsetMin = new Vector2(0f, 2f);
                labelRt.offsetMax = new Vector2(0f, labelFontSize + 6f);

                label = labelGo.GetComponent<Text>();
                label.font = labelFont;
                label.fontSize = labelFontSize;
                label.alignment = TextAnchor.LowerLeft;
                label.horizontalOverflow = HorizontalWrapMode.Overflow;
                label.verticalOverflow = VerticalWrapMode.Overflow;
                label.raycastTarget = false;
            }

            pool.Add(new BoxView { root = root, label = label });
        }
        return pool[index];
    }

    void Edge(RectTransform parent, Vector2 anchorMin, Vector2 anchorMax, Vector2 size)
    {
        var go = new GameObject("Edge", typeof(Image));
        var rt = go.GetComponent<RectTransform>();
        rt.SetParent(parent, false);
        rt.anchorMin = anchorMin;
        rt.anchorMax = anchorMax;
        rt.pivot = new Vector2(0.5f, 0.5f);
        rt.anchoredPosition = Vector2.zero;
        rt.sizeDelta = size;

        var img = go.GetComponent<Image>();
        img.color = boxColor;
        img.raycastTarget = false;
    }
}