using TMPro;
using UnityEngine;

namespace Forgetmenot
{
    public class AnchorNavigationGuide : MonoBehaviour
    {
        [SerializeField] Camera m_XrCamera;
        [SerializeField] Transform m_DirectionIndicator;
        [SerializeField] TMP_Text m_DistanceText;
        [SerializeField, Min(0.05f)] float m_ArrivalDistance = 0.5f;

        Transform m_Target;

        void Awake() => m_XrCamera ??= Camera.main;

        public void SetTarget(Transform target, DetectionResult _)
        {
            m_Target = target;
            if (m_DirectionIndicator != null)
                m_DirectionIndicator.gameObject.SetActive(target != null);
        }

        void Update()
        {
            if (m_Target == null || m_XrCamera == null)
                return;

            Vector3 offset = m_Target.position - m_XrCamera.transform.position;
            float distance = offset.magnitude;
            if (m_DirectionIndicator != null && offset.sqrMagnitude > 0.001f)
                m_DirectionIndicator.rotation = Quaternion.LookRotation(offset.normalized, Vector3.up);

            if (m_DistanceText != null)
                m_DistanceText.text = distance <= m_ArrivalDistance
                    ? "Object location reached"
                    : $"{distance:F1} m";
        }
    }
}
