using System;
using Lastseen;
using UnityEngine;

namespace LastseenApp
{
    /// <summary>
    /// The HUD arrow for the glasses: a 3D arrow floating just below the line of sight that points, on the ground plane, toward the
    /// remembered object. angle = wrap180(bearing to target - where the wearer is looking), computed locally every frame from the
    /// dead-reckoned position and the glasses' head yaw (Camera.main), so head turns feel instant and never wait for the network.
    ///
    /// The glasses' yaw has an arbitrary origin, so the first time (and on Recenter) the offset between the chest heading and the
    /// head yaw is measured while the wearer looks straight ahead: same as the web layer's "recenter".
    /// When the agent only knows the object is "somewhere near the desk" (mode "zone") no arrow is drawn, just the words.
    /// </summary>
    public sealed class HudArrow : MonoBehaviour
    {
        public DeadReckoningTracker pose;
        public Color color = new Color(1f, 0.6f, 0f);
        public Color aheadColor = new Color(0.2f, 1f, 0.3f);
        [Tooltip("Meters in front of the eyes.")] public float distance = 0.9f;
        [Tooltip("Meters below the line of sight.")] public float drop = 0.18f;
        [Tooltip("Within this many degrees of straight ahead the arrow turns green.")] public double aheadDeg = 12;

        public TargetInfo Target { get; private set; }
        public double AngleDeg { get; private set; }
        public double DistanceM { get; private set; }

        GameObject arrow;
        TextMesh label;
        Renderer[] parts;
        Camera cam;
        double headOffsetDeg;
        bool calibrated;
        double smoothed;
        double lastAngle;

        public void SetTarget(TargetInfo t)
        {
            Target = t;
            EnsureBuilt();
            arrow.SetActive(t != null);
            label.gameObject.SetActive(t != null);
        }

        public void Clear()
        {
            SetTarget(null);
        }

        /// <summary>Wearer is looking straight ahead: make the head yaw agree with the chest heading now.</summary>
        public void Recenter()
        {
            if (pose == null) return;
            if (cam == null) cam = Camera.main;
            if (cam == null) return;
            headOffsetDeg = Geo.CalibrateHeadOffset(pose.Current.HeadingDeg, cam.transform.eulerAngles.y);
            calibrated = true;
        }

        void EnsureBuilt()
        {
            if (arrow != null) return;
            arrow = new GameObject("HudArrow");
            arrow.transform.SetParent(transform, false);
            Part(PrimitiveType.Cube, "Shaft", new Vector3(0.02f, 0.02f, 0.14f), Vector3.zero);
            var tip = Part(PrimitiveType.Cube, "Tip", new Vector3(0.06f, 0.02f, 0.06f), new Vector3(0f, 0f, 0.09f));
            tip.transform.localRotation = Quaternion.Euler(0f, 45f, 0f); // a diamond head
            parts = arrow.GetComponentsInChildren<Renderer>();

            label = new GameObject("HudLabel").AddComponent<TextMesh>();
            label.transform.SetParent(transform, false);
            label.font = Resources.GetBuiltinResource<Font>("LegacyRuntime.ttf");
            label.GetComponent<MeshRenderer>().sharedMaterial = label.font.material;
            label.anchor = TextAnchor.UpperCenter;
            label.alignment = TextAlignment.Center;
            label.fontSize = 64;
            label.characterSize = 0.004f;
            label.color = color;
            arrow.SetActive(false);
            label.gameObject.SetActive(false);
        }

        GameObject Part(PrimitiveType type, string name, Vector3 scale, Vector3 localPos)
        {
            var go = GameObject.CreatePrimitive(type);
            go.name = name;
            Destroy(go.GetComponent<Collider>());
            go.transform.SetParent(arrow.transform, false);
            go.transform.localScale = scale;
            go.transform.localPosition = localPos;
            return go;
        }

        void LateUpdate()
        {
            if (Target == null || pose == null) return;
            if (cam == null) cam = Camera.main;
            if (cam == null) return;
            if (!calibrated) Recenter();

            PoseSample p = pose.Current;
            long now = DeadReckoningTracker.NowMs();
            double headYaw = cam.transform.eulerAngles.y;
            double angle = Geo.ArrowAngle(Target.X, Target.Y, p.X, p.Y, p.HeadingDeg, true, now, headYaw, headOffsetDeg, now);
            double dt = Math.Max(0.001, Time.unscaledDeltaTime);
            smoothed = Geo.SmoothAngle(smoothed, angle, 1.0 - Math.Exp(-dt * 12.0));
            AngleDeg = smoothed;
            double dx = Target.X - p.X, dy = Target.Y - p.Y;
            DistanceM = Math.Sqrt(dx * dx + dy * dy);
            lastAngle = angle;

            // ground-plane forward of the head, so the arrow does not tilt when the wearer looks up or down
            Vector3 fwd = Vector3.ProjectOnPlane(cam.transform.forward, Vector3.up);
            if (fwd.sqrMagnitude < 1e-4f) fwd = Vector3.ProjectOnPlane(cam.transform.up, Vector3.up);
            fwd.Normalize();
            Vector3 anchor = cam.transform.position + fwd * distance + Vector3.down * drop;

            bool zone = Target.Mode == "zone";
            arrow.SetActive(!zone);
            if (!zone)
            {
                Vector3 dir = Quaternion.AngleAxis((float)smoothed, Vector3.up) * fwd;
                arrow.transform.position = anchor;
                arrow.transform.rotation = Quaternion.LookRotation(dir, Vector3.up);
                Color c = Math.Abs(smoothed) <= aheadDeg ? aheadColor : color;
                foreach (var r in parts) r.material.color = c;
            }

            label.transform.position = anchor + Vector3.down * 0.06f;
            label.transform.rotation = Quaternion.LookRotation(label.transform.position - cam.transform.position, Vector3.up);
            label.text = Describe(zone);
        }

        string Describe(bool zone)
        {
            string age = Target.AgeSec < 90 ? "just now" : Target.AgeSec < 5400 ? Mathf.RoundToInt((float)Target.AgeSec / 60f) + " min ago" : Mathf.RoundToInt((float)Target.AgeSec / 3600f) + " h ago";
            if (zone) return string.Format("{0}\nnear the {1}\n{2}", Target.Label, string.IsNullOrEmpty(Target.Zone) ? "…" : Target.Zone, age);
            string height = "";
            if (Target.HeightM.HasValue && Math.Abs(Target.HeightM.Value) >= 0.25) height = Target.HeightM.Value > 0 ? "  (higher up)" : "  (lower down)";
            return string.Format("{0}  {1:0.0} m{2}\n{3}", Target.Label, DistanceM, height, age);
        }

        /// <summary>The last unsmoothed arrow angle, for the on-screen debug line.</summary>
        public double RawAngleDeg { get { return lastAngle; } }
    }
}
