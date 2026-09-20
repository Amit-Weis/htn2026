using System;
using System.Linq;
using Unity.Collections;
using UnityEngine;
using UnityEngine.Events;
using UnityEngine.UI;
using UnityEngine.XR.ARFoundation;
using UnityEngine.XR.ARSubsystems;

namespace Forgetmenot
{
    [Serializable]
    public sealed class DetectionFrameEvent : UnityEvent<DetectionFrameResult> { }

    [RequireComponent(typeof(ARCameraManager))]
    public sealed class PhoneObjectDetector : MonoBehaviour
    {
        [SerializeField] ARCameraManager m_CameraManager;
        [SerializeField] string m_TargetClass = "cell phone";
        [SerializeField, Range(0.05f, 1f)] float m_ScoreThreshold = 0.3f;
        [SerializeField, Min(0.1f)] float m_InferenceIntervalSeconds = 0.5f;
        [SerializeField] bool m_LogCameraFrames = true;
        [SerializeField, Min(0.1f)] float m_FrameLogIntervalSeconds = 1f;
        [SerializeField] RawImage m_CameraPreview;
        [SerializeField] Text m_StatusText;
        [SerializeField] DetectionFrameEvent m_OnDetections = new();

        AndroidMediaPipeDetector m_Detector;
        float m_NextInferenceTime;
        float m_NextFrameLogTime;
        Texture2D m_PreviewTexture;
        Material m_PreviewMaterial;
        string m_StatusMessage = "Detector not started";

        public DetectionFrameEvent onDetections => m_OnDetections;

        void OnEnable()
        {
            SetStatus("Starting Beam Pro camera...");
            m_CameraManager ??= GetComponent<ARCameraManager>();
#if UNITY_ANDROID && !UNITY_EDITOR
            if (!UnityEngine.Android.Permission.HasUserAuthorizedPermission(
                    UnityEngine.Android.Permission.Camera))
                UnityEngine.Android.Permission.RequestUserPermission(
                    UnityEngine.Android.Permission.Camera);
#endif
            try
            {
                m_Detector = new AndroidMediaPipeDetector(m_ScoreThreshold);
                m_CameraManager.frameReceived += OnCameraFrame;
                SetStatus("Beam Pro camera requested through AR Foundation");
            }
            catch (Exception exception)
            {
                SetStatus($"ERROR: {exception.GetType().Name}");
                Debug.LogException(exception, this);
            }
        }

        void OnDisable()
        {
            if (m_CameraManager != null)
                m_CameraManager.frameReceived -= OnCameraFrame;
            m_Detector?.Dispose();
            m_Detector = null;
            if (m_PreviewTexture != null)
            {
                Destroy(m_PreviewTexture);
                m_PreviewTexture = null;
            }
            if (m_PreviewMaterial != null)
            {
                Destroy(m_PreviewMaterial);
                m_PreviewMaterial = null;
            }
        }

        void OnCameraFrame(ARCameraFrameEventArgs _)
        {
            if (m_Detector == null || Time.unscaledTime < m_NextInferenceTime)
                return;

            m_NextInferenceTime = Time.unscaledTime + m_InferenceIntervalSeconds;
            if (!m_CameraManager.TryAcquireLatestCpuImage(out XRCpuImage image))
            {
                Debug.LogWarning("ARCameraManager has no Beam Pro CPU image available.", this);
                SetStatus("Waiting for Beam Pro camera frame...");
                return;
            }

            using (image)
            {
                if (m_LogCameraFrames && Time.unscaledTime >= m_NextFrameLogTime)
                {
                    m_NextFrameLogTime = Time.unscaledTime + m_FrameLogIntervalSeconds;
                    Debug.Log($"[PhoneObjectDetector] Beam Pro RGB frame received: {image.width}x{image.height}", this);
                    SetStatus($"Camera OK: {image.width}x{image.height}");
                }

                try
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
                    byte[] bytes = rgba.ToArray();
                    UpdatePreview(bytes, image.width, image.height);
                    DetectionFrameResult result = m_Detector.Detect(
                        bytes, image.width, image.height, m_TargetClass);
                    m_OnDetections.Invoke(result);

                    DetectionResult best = result.detections
                        .OrderByDescending(item => item.confidence)
                        .FirstOrDefault();
                    if (best != null)
                    {
                        Debug.Log($"Detected {best.class_name} ({best.confidence:0.00})", this);
                        SetStatus($"Detected {best.class_name} ({best.confidence:0.00})");
                    }
                }
                catch (Exception exception)
                {
                    SetStatus($"ERROR: {exception.GetType().Name}");
                    Debug.LogException(exception, this);
                }
            }
        }

        void UpdatePreview(byte[] rgba, int width, int height)
        {
            if (m_CameraPreview == null)
                return;

            if (m_PreviewTexture == null || m_PreviewTexture.width != width || m_PreviewTexture.height != height)
            {
                if (m_PreviewTexture != null)
                    Destroy(m_PreviewTexture);

                m_PreviewTexture = new Texture2D(width, height, TextureFormat.RGBA32, false);
                m_PreviewTexture.name = "Phone Camera Preview";
                m_PreviewTexture.wrapMode = TextureWrapMode.Clamp;
                m_CameraPreview.texture = m_PreviewTexture;
            }

            m_PreviewTexture.LoadRawTextureData(rgba);
            m_PreviewTexture.Apply(false);
        }

        void SetStatus(string message)
        {
            m_StatusMessage = message;
            if (m_StatusText != null)
                m_StatusText.text = message;
        }

        void OnGUI()
        {
            if (m_StatusText != null)
                return;

            GUI.color = Color.white;
            GUI.Label(new Rect(20, 20, 500, 40), m_StatusMessage);
        }
    }
}
