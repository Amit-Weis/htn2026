using System.Linq;
using UnityEngine;

namespace Forgetmenot
{
    /// <summary>
    /// Places a world object (TotemFloatingTorus) where the card was seen.
    ///
    /// Two placement modes:
    ///
    ///   * Fixed (useFixedPlacement, the default). The depth estimate from the
    ///     known-size model never agreed with reality, so this mode ignores it.
    ///     On the first accepted sighting the totem is dropped a fixed distance
    ///     straight ahead of the head, at table height, and then latched. No ray,
    ///     no FOV, no distance constant.
    ///
    ///   * Projected (useFixedPlacement off). The original pipeline:
    ///       bbox centre -> normalised image coords -> ray in phone-camera space
    ///       -> scale by distance -> phone space point -> head space -> world space,
    ///     using the head rotation as it was when the frame was captured, not as it
    ///     is now (inference takes ~100 ms and the user is turning).
    ///
    /// Assumptions, all of which come straight from the rig:
    ///   * the user rotates but does not walk, so orientation is the only thing
    ///     that has to be tracked between the sighting and now;
    ///   * the phone is strapped to the headset at a fixed offset, so the phone
    ///     camera pose is headPose * mountOffset.
    /// </summary>
    public sealed class LastSeenAnchor : MonoBehaviour
    {
        public enum PoseSource
        {
            /// Rotation of the XR eye camera. Correct on XREAL: already IMU fused.
            XrCamera,
            /// Raw Input.gyro attitude. Yaw is anchored to magnetic north, not to the
            /// scene, so this only agrees with what you see after an alignment pass.
            DeviceGyro
        }

        public enum ImageRotation { None, CW90, Rot180, CCW90 }

        [Header("References")]
        [SerializeField] Camera headCamera;
        [Tooltip("The TotemFloatingTorus instance. Must live at scene root, not under the camera.")]
        [SerializeField] Transform totem;
        [SerializeField] bool detachTotemOnStart = true;

        [Header("Fixed placement")]
        [Tooltip("Skip the depth math entirely: drop the totem a fixed distance ahead on first sighting.")]
        [SerializeField] bool useFixedPlacement = true;
        [Tooltip("Metres ahead of the head, measured horizontally (the head's pitch is ignored).")]
        [SerializeField, Min(0.05f)] float fixedForwardMeters = 0.5f;
        [Tooltip("Metres below eye level. ~0.5 puts it near table height for a seated user.")]
        [SerializeField] float dropBelowEyesMeters = 0.5f;
        [Tooltip("Once placed, never move it again, however many more sightings arrive.")]
        [SerializeField] bool latchFirstPlacement = true;

        [Header("Head pose")]
        [Tooltip("Used by the projected path only. Fixed placement always reads the live camera transform.")]
        [SerializeField] PoseSource poseSource = PoseSource.XrCamera;
        [Tooltip("Seconds between frame capture and this callback. The pose is rewound by this much.")]
        [SerializeField, Range(0f, 0.5f)] float captureLatencySeconds = 0.12f;
        [SerializeField, Min(8)] int poseHistorySize = 180;

        [Header("Phone mount, relative to the head camera (projected path only)")]
        [Tooltip("Where the phone camera lens sits. -Y is below the eyes, +Z is forward, metres.")]
        [SerializeField] Vector3 mountLocalPosition = Vector3.zero;
        [Tooltip("How the phone camera is aimed on the mount. X = pitch, positive is nose-down.")]
        [SerializeField] Vector3 mountLocalEuler = Vector3.zero;

        [Header("Phone camera (projected path only)")]
        [Tooltip("Horizontal FOV of the phone camera in degrees. Tune until the totem lands on the card.")]
        [SerializeField, Range(20f, 120f)] float horizontalFovDegrees = 66f;
        [Tooltip("Rotation the detector image needs to become upright in camera space.")]
        [SerializeField] ImageRotation imageRotation = ImageRotation.None;
        [Tooltip("On when the image is mirrored left-to-right.")]
        [SerializeField] bool mirrorX;
        [Tooltip("On when the image rows are flipped. CameraHud blits with a vertical flip, so this is usually on.")]
        [SerializeField] bool mirrorY = true;
        [Tooltip("On when the camera looks back along the head's -Z, e.g. phone mounted screen-out.")]
        [SerializeField] bool cameraFacesBackwards;
        [Tooltip("On if distance_m is depth along the camera axis, off if it is a straight-line range.")]
        [SerializeField] bool distanceIsAlongForward;

        [Header("Detection filtering")]
        [SerializeField, Range(0.05f, 1f)] float minConfidence = 0.3f;
        [Tooltip("Projected path only. Used when the detector sends no distance_m. From hacker_card_distance.json.")]
        [SerializeField] float normalizedWidthDistanceConstant = 0.033f;
        [Tooltip("Projected path only.")]
        [SerializeField] Vector2 distanceClampMeters = new Vector2(0.2f, 8f);
        [Tooltip("Projected path only. 0 snaps to every new sighting, 0.9 is heavy smoothing.")]
        [SerializeField, Range(0f, 0.95f)] float positionSmoothing = 0.4f;
        [Tooltip("Projected path only. A sighting after this long re-snaps instead of smoothing.")]
        [SerializeField, Min(0.1f)] float resnapAfterSeconds = 1.5f;

        [Header("Debug")]
        [Tooltip("Logs the placement decision for every accepted sighting.")]
        [SerializeField] bool logPlacement;

        struct PoseSample
        {
            public float time;
            public Quaternion rotation;
            public Vector3 position;
        }

        PoseSample[] history;
        int historyCount;
        int historyHead;

        bool hasAnchor;
        Vector3 anchorPosition;
        float lastSeenTime = float.NegativeInfinity;
        float lastDistance;

        public bool HasAnchor => hasAnchor;
        public Vector3 AnchorPosition => anchorPosition;
        public float LastDistanceMeters => lastDistance;
        public float SecondsSinceSeen => Time.unscaledTime - lastSeenTime;

        void Awake()
        {
            if (headCamera == null) headCamera = Camera.main;
            history = new PoseSample[Mathf.Max(8, poseHistorySize)];

            if (headCamera == null)
                Debug.LogError("[LastSeenAnchor] No head camera. Every placement will be wrong.", this);

            // The gyro is only ever consumed by the projected path.
            if (!useFixedPlacement && poseSource == PoseSource.DeviceGyro && SystemInfo.supportsGyroscope)
                Input.gyro.enabled = true;
        }

        void Start()
        {
            if (totem != null)
            {
                if (detachTotemOnStart && totem.parent != null)
                    totem.SetParent(null, true);
                totem.gameObject.SetActive(false);
            }
        }

        // ------------------------------------------------------------ pose history

        void LateUpdate()
        {
            if (useFixedPlacement) return; // nothing reads the history in this mode
            RecordPose();
        }

        void RecordPose()
        {
            if (headCamera == null) return;

            var sample = new PoseSample
            {
                time = Time.unscaledTime,
                position = headCamera.transform.position,
                rotation = poseSource == PoseSource.DeviceGyro
                    ? GyroAttitudeToUnity()
                    : headCamera.transform.rotation
            };

            history[historyHead] = sample;
            historyHead = (historyHead + 1) % history.Length;
            historyCount = Mathf.Min(historyCount + 1, history.Length);
        }

        static Quaternion GyroAttitudeToUnity()
        {
            // Android reports a right-handed attitude with the device Z out of the
            // screen. This is the standard conversion into Unity's left-handed frame.
            Quaternion attitude = Input.gyro.attitude;
            return Quaternion.Euler(90f, 0f, 0f) *
                   new Quaternion(attitude.x, attitude.y, -attitude.z, -attitude.w);
        }

        bool TryGetPoseAt(float time, out PoseSample pose)
        {
            pose = default;
            if (historyCount == 0) return false;

            PoseSample best = default;
            float bestDelta = float.MaxValue;

            for (int i = 0; i < historyCount; i++)
            {
                int index = (historyHead - 1 - i + history.Length) % history.Length;
                float delta = Mathf.Abs(history[index].time - time);
                if (delta < bestDelta)
                {
                    bestDelta = delta;
                    best = history[index];
                }
                else if (history[index].time < time)
                {
                    break; // walking backwards, it only gets worse from here
                }
            }

            pose = best;
            return true;
        }

        // -------------------------------------------------------------- detections

        /// <summary>Hook this up to the detector's onDetections UnityEvent.</summary>
        public void OnDetections(DetectionFrameResult frame)
        {
            if (frame == null || frame.image_width <= 0 || frame.image_height <= 0)
                return;

            // Confidence is the only gate in fixed mode. The projected path adds a
            // HasDistance requirement of its own below.
            DetectionResult best = frame.detections?
                .Where(item => item != null && item.confidence >= minConfidence)
                .OrderByDescending(item => item.confidence)
                .FirstOrDefault();

            if (best == null)
            {
                if (logPlacement)
                {
                    DetectionResult any = frame.detections?
                        .OrderByDescending(item => item.confidence).FirstOrDefault();
                    Debug.Log($"[Anchor] rejected n={frame.detections?.Length ?? 0} " +
                              $"conf={any?.confidence ?? -1f:0.00} (min {minConfidence})", this);
                }
                return;
            }

            // Seen counts even when the placement is latched, so RevealOnFirstSighting
            // and SecondsSinceSeen keep behaving the way they always did.
            lastSeenTime = Time.unscaledTime;

            if (useFixedPlacement)
            {
                if (hasAnchor && latchFirstPlacement)
                {
                    if (logPlacement)
                        Debug.Log($"[Anchor] latched, ignoring sighting conf={best.confidence:0.00}", this);
                    return;
                }

                anchorPosition = FixedPlacement();
                lastDistance = fixedForwardMeters;
            }
            else
            {
                frame.FillMissingDistances(normalizedWidthDistanceConstant);

                if (!best.HasDistance)
                    return;

                float distance = Mathf.Clamp(best.distance_m, distanceClampMeters.x, distanceClampMeters.y);

                if (!TryGetPoseAt(Time.unscaledTime - captureLatencySeconds, out PoseSample pose))
                    return;

                Vector3 world = ToWorld(best, frame, distance, pose);

                bool snap = !hasAnchor || SecondsSinceSeen > resnapAfterSeconds;
                anchorPosition = snap
                    ? world
                    : Vector3.Lerp(world, anchorPosition, positionSmoothing);

                lastDistance = distance;
            }

            hasAnchor = true;

            if (totem != null)
            {
                totem.position = anchorPosition;
                if (!totem.gameObject.activeSelf)
                    totem.gameObject.SetActive(true);
            }
        }

        /// <summary>
        /// A fixed point ahead of the head at table height. Reads the live camera
        /// transform rather than the pose history on purpose: the history can be
        /// gyro-derived, whose yaw is anchored to magnetic north rather than to the
        /// scene, which would scatter the totem to an arbitrary compass bearing.
        /// Capture latency does not matter either, because there is no ray to
        /// reconstruct — only "roughly where the user is facing".
        /// </summary>
        Vector3 FixedPlacement()
        {
            Transform head = headCamera != null ? headCamera.transform : transform;

            // Flatten the forward so looking down at the card does not bury the
            // totem in the floor, or looking up float it away.
            Vector3 forward = head.forward;
            forward.y = 0f;
            forward = forward.sqrMagnitude < 1e-6f
                ? Vector3.forward
                : forward.normalized;

            Vector3 world = head.position
                          + forward * fixedForwardMeters
                          - Vector3.up * dropBelowEyesMeters;

            if (logPlacement)
            {
                Debug.Log($"[Anchor] fixed placement world={world} " +
                          $"head={head.position} fwd={forward} " +
                          $"ahead={fixedForwardMeters:0.00} drop={dropBelowEyesMeters:0.00}", this);
            }

            return world;
        }

        Vector3 ToWorld(DetectionResult detection, DetectionFrameResult frame,
                        float distance, PoseSample pose)
        {
            // 1. normalised image coords, origin top-left, as the detector reports them
            float u = detection.center.x / (float)frame.image_width;
            float v = detection.center.y / (float)frame.image_height;
            float aspect = frame.image_width / (float)frame.image_height;

            if (mirrorX) u = 1f - u;
            if (mirrorY) v = 1f - v;

            switch (imageRotation)
            {
                case ImageRotation.CW90:
                    (u, v) = (1f - v, u);
                    aspect = 1f / aspect;
                    break;
                case ImageRotation.Rot180:
                    (u, v) = (1f - u, 1f - v);
                    break;
                case ImageRotation.CCW90:
                    (u, v) = (v, 1f - u);
                    aspect = 1f / aspect;
                    break;
            }

            // 2. pinhole ray in phone-camera space, +X right, +Y up, +Z forward
            float tanHalfH = Mathf.Tan(horizontalFovDegrees * 0.5f * Mathf.Deg2Rad);
            float tanHalfV = tanHalfH / Mathf.Max(0.0001f, aspect);
            var ray = new Vector3((2f * u - 1f) * tanHalfH, (1f - 2f * v) * tanHalfV, 1f);

            // 180 degree yaw: forward and right reverse, up is unchanged.
            if (cameraFacesBackwards)
                ray = new Vector3(-ray.x, ray.y, -ray.z);

            // 3. metres out along that ray
            Vector3 cameraSpace = distanceIsAlongForward ? ray * distance : ray.normalized * distance;

            // 4. phone camera -> head -> world, using the pose from capture time
            Vector3 headSpace = Quaternion.Euler(mountLocalEuler) * cameraSpace + mountLocalPosition;
            Vector3 world = pose.rotation * headSpace + pose.position;

            if (logPlacement)
            {
                Debug.Log($"[Anchor] uv=({u:0.00},{v:0.00}) ray={ray} d={distance:0.00} " +
                          $"cam={cameraSpace} head={headSpace} world={world} " +
                          $"posePos={pose.position} poseFwd={pose.rotation * Vector3.forward}", this);
            }

            return world;
        }

        // ------------------------------------------------------------------- utility

        /// <summary>Forget the placement. In fixed mode this also releases the latch.</summary>
        public void ClearAnchor()
        {
            hasAnchor = false;
            lastSeenTime = float.NegativeInfinity;
            if (totem != null)
                totem.gameObject.SetActive(false);
        }

        void OnDrawGizmosSelected()
        {
            if (!hasAnchor) return;
            Gizmos.color = Color.magenta;
            Gizmos.DrawWireSphere(anchorPosition, 0.05f);
            if (headCamera != null)
                Gizmos.DrawLine(headCamera.transform.position, anchorPosition);
        }
    }
}
