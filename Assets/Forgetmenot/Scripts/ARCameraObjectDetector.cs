using System;
using Unity.Collections;
using UnityEngine;
using UnityEngine.Events;
using UnityEngine.XR.ARFoundation;
using UnityEngine.XR.ARSubsystems;

namespace Forgetmenot
{
    [Serializable]
    public class DetectionFrameEvent : UnityEvent<DetectionFrameResult> { }

    [RequireComponent(typeof(ARCameraManager))]
    public class ARCameraObjectDetector : MonoBehaviour
    {
        [SerializeField] ARCameraManager m_CameraManager;
        [SerializeField] string m_TargetClass = "hacker_card";
        [SerializeField, Range(0.05f, 1f)] float m_ScoreThreshold = 0.3f;
        [SerializeField, Min(0.1f)] float m_InferenceIntervalSeconds = 0.4f;
        [SerializeField] bool m_StopAfterFirstMatch = true;
        [SerializeField] DetectionFrameEvent m_OnDetections = new();

        AndroidMediaPipeDetector m_Detector;
        float m_NextInferenceTime;
        bool m_IsLocked;

        public string targetClass
        {
            get => m_TargetClass;
            set => m_TargetClass = value ?? string.Empty;
        }

        public DetectionFrameEvent onDetections => m_OnDetections;

        void Awake()
        {
            if (m_CameraManager == null)
                m_CameraManager = GetComponent<ARCameraManager>();
        }

        void OnEnable()
        {
            m_Detector = new AndroidMediaPipeDetector(m_ScoreThreshold);
            m_CameraManager.frameReceived += OnCameraFrame;
        }

        void OnDisable()
        {
            m_CameraManager.frameReceived -= OnCameraFrame;
            m_Detector?.Dispose();
            m_Detector = null;
        }

        public void SearchAgain()
        {
            m_IsLocked = false;
            m_NextInferenceTime = 0f;
        }

        void OnCameraFrame(ARCameraFrameEventArgs _)
        {
            if (m_IsLocked || Time.unscaledTime < m_NextInferenceTime)
                return;

            m_NextInferenceTime = Time.unscaledTime + m_InferenceIntervalSeconds;
            if (!m_CameraManager.TryAcquireLatestCpuImage(out var image))
                return;

            using (image)
            {
                var conversion = new XRCpuImage.ConversionParams
                {
                    inputRect = new RectInt(0, 0, image.width, image.height),
                    outputDimensions = new Vector2Int(image.width, image.height),
                    outputFormat = TextureFormat.RGBA32,
                    transformation = XRCpuImage.Transformation.None
                };

                int size = image.GetConvertedDataSize(conversion);
                using var rgba = new NativeArray<byte>(size, Allocator.Temp);
                image.Convert(conversion, rgba);
                var result = m_Detector.Detect(rgba.ToArray(), image.width, image.height, m_TargetClass);
                m_OnDetections.Invoke(result);

                if (m_StopAfterFirstMatch && result.detections.Length > 0)
                    m_IsLocked = true;
            }
        }
    }
}
