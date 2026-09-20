using System.Linq;
using UnityEngine;

namespace Forgetmenot
{
    public sealed class FixedDepthArrowController : MonoBehaviour
    {
        [SerializeField] PhoneObjectDetector m_Detector;
        [SerializeField] Camera m_Camera;
        [SerializeField] Transform m_Arrow;
        [SerializeField, Min(0.1f)] float m_FixedDepthMeters = 2f;
        [SerializeField] bool m_MirrorImageX;

        void Awake()
        {
            m_Camera ??= Camera.main;
            m_Detector ??= FindAnyObjectByType<PhoneObjectDetector>();
        }

        void OnEnable()
        {
            if (m_Detector != null)
                m_Detector.onDetections.AddListener(UpdateArrow);
            SetVisible(false);
        }

        void OnDisable()
        {
            if (m_Detector != null)
                m_Detector.onDetections.RemoveListener(UpdateArrow);
        }

        void UpdateArrow(DetectionFrameResult frame)
        {
            DetectionResult detection = frame?.detections?
                .OrderByDescending(item => item.confidence)
                .FirstOrDefault();
            if (detection == null || m_Camera == null || frame.image_width <= 0 || frame.image_height <= 0)
            {
                SetVisible(false);
                return;
            }

            float normalizedX = (float)detection.center.x / frame.image_width;
            float normalizedY = 1f - (float)detection.center.y / frame.image_height;
            if (m_MirrorImageX)
                normalizedX = 1f - normalizedX;

            Vector3 screenPoint = new Vector3(
                normalizedX * Screen.width,
                normalizedY * Screen.height,
                m_FixedDepthMeters);
            Vector3 target = m_Camera.ScreenToWorldPoint(screenPoint);

            if (m_Arrow != null)
            {
                m_Arrow.position = target;
                Vector3 direction = target - m_Camera.transform.position;
                if (direction.sqrMagnitude > 0.001f)
                    m_Arrow.rotation = Quaternion.LookRotation(direction.normalized, Vector3.up);
            }
            SetVisible(true);
        }

        void SetVisible(bool visible)
        {
            if (m_Arrow != null)
                m_Arrow.gameObject.SetActive(visible);
        }
    }
}
