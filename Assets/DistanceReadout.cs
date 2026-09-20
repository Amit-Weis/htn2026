using System.Collections.Generic;
using TMPro;
using UnityEngine;
using UnityEngine.UI;
#if UNITY_EDITOR
using UnityEditor;
#endif

/// <summary>
/// AirTag-style "Finding Keys / 0.7 m" readout.
/// Goes on the FindingGroup root. Renders in edit mode as well as play mode.
/// Fastest setup: GameObject -> UI -> Distance Readout.
/// </summary>
[ExecuteAlways]
[DisallowMultipleComponent]
public class DistanceReadout : MonoBehaviour
{
    [Header("Measured between")]
    public Transform from;            // usually the camera / player
    public Transform to;              // the tracked object

    [Header("Refs")]
    public TMP_Text labelText;        // "Finding Keys"
    public TMP_Text distanceText;     // "0.7 m"
    public Image pillBackground;      // Image on the Pill child

    [Header("Label")]
    public string verb = "Finding";
    public string targetName = "Keys";
    public Color targetColor = new Color(0.31f, 0.76f, 0.97f); // #4FC3F7
    public Color labelColor = Color.white;

    [Header("Distance")]
    public bool horizontalOnly = false;
    [Tooltip("Show cm instead of m below this distance. 0 = always metres.")]
    public float centimetreThreshold = 0f;
    [Tooltip("Seconds for the number to catch up. 0 = instant.")]
    public float smoothTime = 0.15f;
    [Tooltip("Shown in edit mode when From/To aren't set yet.")]
    public float previewDistance = 0.7f;

    [Header("Pill look")]
    public Vector2 pillSize = new Vector2(192f, 64f);
    public Color pillColor = new Color(1f, 1f, 1f, 0.12f);
    public Color numberColor = new Color(0.72f, 0.72f, 0.72f, 1f);
    public float labelGap = 10f;

    static readonly Dictionary<int, Sprite> SpriteCache = new Dictionary<int, Sprite>();

    float _shown;
    float _vel;

    void OnEnable()
    {
        AutoWire();
        Rebuild();
        _shown = CurrentDistance();
    }

    void OnValidate()
    {
#if UNITY_EDITOR
        // Deferred: you can't build assets or destroy things from inside OnValidate.
        EditorApplication.delayCall += () =>
        {
            if (this == null) return;
            AutoWire();
            Rebuild();
        };
#endif
    }

    void Update()
    {
        float target = CurrentDistance();

        if (Application.isPlaying && smoothTime > 0f)
            _shown = Mathf.SmoothDamp(_shown, target, ref _vel, smoothTime);
        else
            _shown = target;

        if (distanceText) distanceText.text = Format(_shown);
    }

    float CurrentDistance()
    {
        if (!from || !to) return previewDistance;   // keeps the preview readable
        Vector3 d = to.position - from.position;
        if (horizontalOnly) d.y = 0f;
        return d.magnitude;
    }

    string Format(float metres)
    {
        if (centimetreThreshold > 0f && metres < centimetreThreshold)
            return Mathf.RoundToInt(metres * 100f) + " cm";
        return metres.ToString("0.0") + " m";
    }

    /// <summary>Finds the child objects by name if the fields are empty.</summary>
    void AutoWire()
    {
        if (!pillBackground)
        {
            var pill = transform.Find("Pill");
            if (pill) pillBackground = pill.GetComponent<Image>();
        }
        if (!labelText)
        {
            var l = transform.Find("Label");
            if (l) labelText = l.GetComponent<TMP_Text>();
        }
        if (!distanceText && pillBackground)
        {
            var d = pillBackground.transform.Find("Distance");
            if (d) distanceText = d.GetComponent<TMP_Text>();
        }
    }

    [ContextMenu("Rebuild")]
    public void Rebuild()
    {
        // ---- pill ----
        if (pillBackground)
        {
            var pr = pillBackground.rectTransform;
            Center(pr);
            pr.sizeDelta = pillSize;
            pr.anchoredPosition = Vector2.zero;

            pillBackground.sprite = GetCapsule(Mathf.RoundToInt(pillSize.y));
            pillBackground.type = Image.Type.Sliced;
            pillBackground.pixelsPerUnitMultiplier = 1f;
            pillBackground.color = pillColor;
            pillBackground.raycastTarget = false;
        }

        // ---- number ----
        if (distanceText)
        {
            var dr = distanceText.rectTransform;
            dr.anchorMin = Vector2.zero;
            dr.anchorMax = Vector2.one;
            dr.offsetMin = Vector2.zero;
            dr.offsetMax = Vector2.zero;
            distanceText.alignment = TextAlignmentOptions.Center;
            distanceText.color = numberColor;
            distanceText.enableWordWrapping = false;
            distanceText.raycastTarget = false;
            distanceText.text = Format(CurrentDistance());
        }

        // ---- label ----
        if (labelText)
        {
            var lr = labelText.rectTransform;
            Center(lr);
            lr.sizeDelta = new Vector2(pillSize.x * 1.6f, 26f);
            lr.anchoredPosition = new Vector2(0f, pillSize.y * 0.5f + labelGap + 13f);
            labelText.alignment = TextAlignmentOptions.Center;
            labelText.color = labelColor;
            labelText.enableWordWrapping = false;
            labelText.richText = true;
            labelText.raycastTarget = false;

            string hex = ColorUtility.ToHtmlStringRGB(targetColor);
            labelText.text = $"{verb} <color=#{hex}><b>{targetName}</b></color>";
        }
    }

    static void Center(RectTransform rt)
    {
        rt.anchorMin = rt.anchorMax = rt.pivot = new Vector2(0.5f, 0.5f);
        rt.localScale = Vector3.one;
        rt.localRotation = Quaternion.identity;
    }

    /// <summary>Call this when you start tracking something else.</summary>
    public void SetTarget(Transform t, string displayName)
    {
        to = t;
        targetName = displayName;
        Rebuild();
    }

    // ------------------------------------------------------------------
    // Runtime-generated capsule sprite (9-sliced, so no asset to import).
    // ------------------------------------------------------------------
    static Sprite GetCapsule(int height)
    {
        height = Mathf.Max(8, height);
        if (SpriteCache.TryGetValue(height, out var cached) && cached) return cached;

        int r = height / 2;
        int size = r * 2;

        var tex = new Texture2D(size, size, TextureFormat.RGBA32, false)
        {
            filterMode = FilterMode.Bilinear,
            wrapMode = TextureWrapMode.Clamp,
            hideFlags = HideFlags.HideAndDontSave,
            name = "CapsuleTex_" + height
        };

        var px = new Color32[size * size];
        float rr = r - 0.5f;

        for (int y = 0; y < size; y++)
            for (int x = 0; x < size; x++)
            {
                float cx = x < r ? r - 0.5f : size - r - 0.5f;
                float cy = y < r ? r - 0.5f : size - r - 0.5f;
                float d = Vector2.Distance(new Vector2(x, y), new Vector2(cx, cy));
                float a = Mathf.Clamp01(rr - d + 0.5f);   // 1px antialiased edge
                px[y * size + x] = new Color(1f, 1f, 1f, a);
            }

        tex.SetPixels32(px);
        tex.Apply();

        var sprite = Sprite.Create(
            tex,
            new Rect(0, 0, size, size),
            new Vector2(0.5f, 0.5f),
            100f, 0, SpriteMeshType.FullRect,
            new Vector4(r, r, r, r));              // 9-slice border
        sprite.name = "Capsule_" + height;
        sprite.hideFlags = HideFlags.HideAndDontSave;

        SpriteCache[height] = sprite;
        return sprite;
    }

#if UNITY_EDITOR
    // ------------------------------------------------------------------
    // GameObject -> UI -> Distance Readout : builds the whole group.
    // ------------------------------------------------------------------
    [MenuItem("GameObject/UI/Distance Readout", false, 10)]
    static void CreateFromMenu(MenuCommand cmd)
    {
        var parent = cmd.context as GameObject;

        // UI only renders under a Canvas, so make sure we land under one.
        if (!parent || !parent.GetComponentInParent<Canvas>())
        {
            var canvas = Object.FindObjectOfType<Canvas>();
            if (!canvas)
            {
                Debug.LogWarning("DistanceReadout: no Canvas in the scene. " +
                                 "Create one (GameObject > UI > Canvas) and run this again.");
                return;
            }
            parent = canvas.gameObject;
        }

        var root = new GameObject("FindingGroup", typeof(RectTransform));
        GameObjectUtility.SetParentAndAlign(root, parent);
        var rootRect = (RectTransform)root.transform;
        rootRect.anchorMin = rootRect.anchorMax = new Vector2(0.5f, 0f);
        rootRect.pivot = new Vector2(0.5f, 0f);
        rootRect.sizeDelta = new Vector2(240f, 120f);
        rootRect.anchoredPosition = new Vector2(0f, 90f);

        var label = new GameObject("Label", typeof(RectTransform), typeof(TextMeshProUGUI));
        label.transform.SetParent(root.transform, false);
        var labelTmp = label.GetComponent<TextMeshProUGUI>();
        labelTmp.fontSize = 18f;

        var pill = new GameObject("Pill", typeof(RectTransform), typeof(Image));
        pill.transform.SetParent(root.transform, false);

        var dist = new GameObject("Distance", typeof(RectTransform), typeof(TextMeshProUGUI));
        dist.transform.SetParent(pill.transform, false);
        var distTmp = dist.GetComponent<TextMeshProUGUI>();
        distTmp.fontSize = 40f;
        distTmp.characterSpacing = 5f;

        var readout = root.AddComponent<DistanceReadout>();
        readout.labelText = labelTmp;
        readout.distanceText = distTmp;
        readout.pillBackground = pill.GetComponent<Image>();
        readout.Rebuild();

        Undo.RegisterCreatedObjectUndo(root, "Create Distance Readout");
        Selection.activeGameObject = root;
    }
#endif
}