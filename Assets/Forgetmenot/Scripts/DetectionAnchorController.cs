using System;
using System.Collections.Generic;
using System.Linq;
using UnityEngine;
using UnityEngine.Events;
using UnityEngine.XR.ARFoundation;
using UnityEngine.XR.ARSubsystems;

namespace Forgetmenot
{
    [Serializable]
    public class AnchorCreatedEvent : UnityEvent<Transform, DetectionResult> { }

    public class DetectionAnchorController : MonoBehaviour
    {
        [SerializeField] ARRaycastManager m_RaycastManager;
        [SerializeField] ARAnchorManager m_AnchorManager;
        [SerializeField] Camera m_XrCamera;
        [SerializeField] GameObject m_MarkerPrefab;
        [SerializeField] bool m_MirrorImageX;
        [SerializeField, Range(0f, 0.4f)] float m_InnerSampleOffset = 0.2f;
        [SerializeField] AnchorCreatedEvent m_OnAnchorCreated = new();

        readonly List<ARRaycastHit> m_Hits = new();
        ARAnchor m_CurrentAnchor;

        public Transform currentTarget => m_CurrentAnchor == null ? null : m_CurrentAnchor.transform;
        public AnchorCreatedEvent onAnchorCreated => m_OnAnchorCreated;

        void Awake()
        {
            m_RaycastManager ??= FindAnyObjectByType<ARRaycastManager>();
            m_AnchorManager ??= FindAnyObjectByType<ARAnchorManager>();
            m_XrCamera ??= Camera.main;
        }

        public async void HandleDetections(DetectionFrameResult frame)
        {
            if (frame == null || frame.detections == null || frame.detections.Length == 0)
                return;

            // The detector already filters by target. Prefer the most confident instance.
            DetectionResult detection = frame.detections.OrderByDescending(item => item.confidence).First();
            List<Vector3> worldHits = CollectWorldHits(detection, frame.image_width, frame.image_height);
            if (worldHits.Count == 0)
            {
                Debug.LogWarning("Detection found, but no mapped surface was hit. Aim at the object again.", this);
                return;
            }

            Vector3 position = CoordinateMedian(worldHits);
            var pose = new Pose(position, Quaternion.identity);
            var result = await m_AnchorManager.TryAddAnchorAsync(pose);
            if (!result.status.IsSuccess())
            {
                Debug.LogError($"Could not create object anchor: {result.status}", this);
                return;
            }

            if (m_CurrentAnchor != null)
                m_AnchorManager.TryRemoveAnchor(m_CurrentAnchor);

            m_CurrentAnchor = result.value;
            if (m_MarkerPrefab != null)
            {
                GameObject marker = Instantiate(m_MarkerPrefab, m_CurrentAnchor.transform);
                marker.transform.SetLocalPositionAndRotation(Vector3.zero, Quaternion.identity);
            }

            m_OnAnchorCreated.Invoke(m_CurrentAnchor.transform, detection);
        }

        List<Vector3> CollectWorldHits(DetectionResult detection, int imageWidth, int imageHeight)
        {
            var box = detection.bbox;
            float centerX = detection.center.x;
            float centerY = detection.center.y;
            float dx = (box.x2 - box.x1) * m_InnerSampleOffset;
            float dy = (box.y2 - box.y1) * m_InnerSampleOffset;
            var imagePoints = new[]
            {
                new Vector2(centerX, centerY),
                new Vector2(centerX - dx, centerY),
                new Vector2(centerX + dx, centerY),
                new Vector2(centerX, centerY - dy),
                new Vector2(centerX, centerY + dy),
            };

            var results = new List<Vector3>();
            foreach (Vector2 imagePoint in imagePoints)
            {
                Vector2 screenPoint = DetectionCoordinateMapper.ImageToScreen(
                    imagePoint,
                    new Vector2(imageWidth, imageHeight),
                    new Vector2(Screen.width, Screen.height),
                    m_MirrorImageX);

                // Prefer a depth-mesh collider when one exists, then fall back to AR planes.
                Ray ray = m_XrCamera.ScreenPointToRay(screenPoint);
                if (Physics.Raycast(ray, out RaycastHit physicsHit))
                {
                    results.Add(physicsHit.point);
                    continue;
                }

                m_Hits.Clear();
                if (m_RaycastManager.Raycast(screenPoint, m_Hits, TrackableType.PlaneWithinPolygon))
                    results.Add(m_Hits[0].pose.position);
            }
            return results;
        }

        static Vector3 CoordinateMedian(List<Vector3> points)
        {
            float Median(IEnumerable<float> values)
            {
                float[] sorted = values.OrderBy(value => value).ToArray();
                int middle = sorted.Length / 2;
                return sorted.Length % 2 == 1
                    ? sorted[middle]
                    : (sorted[middle - 1] + sorted[middle]) * 0.5f;
            }

            return new Vector3(
                Median(points.Select(point => point.x)),
                Median(points.Select(point => point.y)),
                Median(points.Select(point => point.z)));
        }
    }
}
