using UnityEngine;

namespace Depth
{
    // World-anchored marker at a located object, plus an arrow at the edge of the view pointing
    // toward it while it is out of sight.
    public class TargetIndicator : MonoBehaviour
    {
        public float markerSize = 0.1f;
        [Tooltip("World height of the label text, meters.")]
        public float labelHeight = 0.05f;
        public Color color = new Color(1f, 0.6f, 0f);
        [Tooltip("Distance in front of the camera the arrow floats at.")]
        public float arrowDistance = 1f;
        [Tooltip("How far from the view center the arrow sits, at arrowDistance.")]
        public float arrowRadius = 0.3f;
        [Tooltip("Viewport margin: the marker counts as out of view within this fraction of the screen edge.")]
        public float viewMargin = 0.08f;

        GameObject marker;
        GameObject arrow;
        Camera cam;

        public void Show(ObjectPose3D pose)
        {
            Clear();
            marker = new GameObject("TargetMarker");
            marker.transform.position = pose.worldPos;

            var ball = Solid(PrimitiveType.Sphere, "Ball", marker.transform);
            ball.transform.localScale = Vector3.one * markerSize;

            var label = new GameObject("Label").AddComponent<TextMesh>();
            label.transform.SetParent(marker.transform, false);
            label.font = Resources.GetBuiltinResource<Font>("LegacyRuntime.ttf");
            label.GetComponent<MeshRenderer>().sharedMaterial = label.font.material;
            label.text = string.Format("{0} {1:0.0} m", pose.label, pose.depth);
            label.anchor = TextAnchor.LowerCenter;
            label.alignment = TextAlignment.Center;
            label.fontSize = 64;
            label.color = color;
            // TextMesh's native size is unintuitive, so scale it to a fixed height above the ball.
            float native = label.GetComponent<MeshRenderer>().bounds.size.y;
            float scale = native > 0f ? labelHeight / native : 0.01f;
            label.transform.localScale = Vector3.one * scale;
            label.transform.localPosition = new Vector3(0f, markerSize * 0.75f, 0f);

            arrow = new GameObject("TargetArrow");
            var shaft = Solid(PrimitiveType.Cube, "Shaft", arrow.transform);
            shaft.transform.localScale = new Vector3(0.015f, 0.015f, 0.08f);
            var tip = Solid(PrimitiveType.Sphere, "Tip", arrow.transform);
            tip.transform.localPosition = new Vector3(0f, 0f, 0.05f);
            tip.transform.localScale = Vector3.one * 0.04f;
            arrow.SetActive(false);
        }

        public void Clear()
        {
            if (marker != null) Destroy(marker);
            if (arrow != null) Destroy(arrow);
        }

        void LateUpdate()
        {
            if (marker == null) return;
            if (cam == null) cam = Camera.main != null ? Camera.main : FindFirstObjectByType<Camera>();
            if (cam == null) return;

            // Face the label toward the viewer.
            var label = marker.transform.Find("Label");
            label.rotation = Quaternion.LookRotation(label.position - cam.transform.position);

            var vp = cam.WorldToViewportPoint(marker.transform.position);
            bool inView = vp.z > 0f
                && vp.x > viewMargin && vp.x < 1f - viewMargin
                && vp.y > viewMargin && vp.y < 1f - viewMargin;
            arrow.SetActive(!inView);
            if (inView) return;

            // Direction to the target within the camera's screen plane. Directly behind gives ~0, so point right.
            var local = cam.transform.InverseTransformPoint(marker.transform.position);
            var dir = new Vector2(local.x, local.y);
            dir = dir.sqrMagnitude < 1e-6f ? Vector2.right : dir.normalized;

            var t = cam.transform;
            var dirWorld = t.right * dir.x + t.up * dir.y;
            arrow.transform.position = t.position + t.forward * arrowDistance + dirWorld * arrowRadius;
            arrow.transform.rotation = Quaternion.LookRotation(dirWorld, t.forward);
        }

        void OnDestroy()
        {
            Clear();
        }

        GameObject Solid(PrimitiveType type, string name, Transform parent)
        {
            var go = GameObject.CreatePrimitive(type);
            go.name = name;
            Destroy(go.GetComponent<Collider>());
            go.GetComponent<Renderer>().material.color = color;
            if (parent != null) go.transform.SetParent(parent, false);
            return go;
        }
    }
}
