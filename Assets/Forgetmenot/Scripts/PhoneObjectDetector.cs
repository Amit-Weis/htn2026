using System;
using System.Linq;
using Unity.Collections;
using UnityEngine;
using UnityEngine.Events;
using UnityEngine.UI;
using Unity.XR.XREAL;

namespace Forgetmenot
{
    [Serializable]
    public sealed class DetectionFrameEvent : UnityEvent<DetectionFrameResult> { }

    public sealed class PhoneObjectDetector : MonoBehaviour
    {
        [SerializeField] string m_TargetClass = "cell phone";
        [SerializeField, Range(0.05f, 1f)] float m_ScoreThreshold = 0.3f;
        [SerializeField, Min(0.1f)] float m_InferenceIntervalSeconds = 0.5f;
        [SerializeField] bool m_LogCameraFrames = true;
        [SerializeField, Min(0.1f)] float m_FrameLogIntervalSeconds = 1f;
        [SerializeField] RawImage m_CameraPreview;
        [SerializeField] Text m_StatusText;
        [SerializeField] DetectionFrameEvent m_OnDetections = new();

        AndroidMediaPipeDetector m_Detector;
        XREALRGBCameraTexture m_RgbCamera;
        float m_NextInferenceTime;
        float m_NextFrameLogTime;
        Texture2D m_PreviewTexture;
        Material m_PreviewMaterial;
        string m_StatusMessage = "Detector not started";

        public DetectionFrameEvent onDetections => m_OnDetections;

        void OnEnable()
        {
            SetStatus("Starting Beam Pro camera...");
#if UNITY_ANDROID && !UNITY_EDITOR
            if (!UnityEngine.Android.Permission.HasUserAuthorizedPermission(
                    UnityEngine.Android.Permission.Camera))
                UnityEngine.Android.Permission.RequestUserPermission(
                    UnityEngine.Android.Permission.Camera);
#endif
            try
            {
                m_Detector = new AndroidMediaPipeDetector(m_ScoreThreshold);
                m_RgbCamera = XREALRGBCameraTexture.CreateSingleton();
                m_RgbCamera.OnRGBCameraUpdate += OnCameraFrame;
                bool started = m_RgbCamera.StartCapture();
                SetStatus(started ? "Beam Pro camera started" : "Beam Pro camera failed to start");
            }
            catch (Exception exception)
            {
                SetStatus($"ERROR: {exception.GetType().Name}");
                Debug.LogException(exception, this);
            }
        }

        void OnDisable()
        {
            if (m_RgbCamera != null)
            {
                m_RgbCamera.OnRGBCameraUpdate -= OnCameraFrame;
                m_RgbCamera.StopCapture();
            }
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

        void OnCameraFrame()
        {
            if (m_Detector == null || Time.unscaledTime < m_NextInferenceTime)
                return;

            m_NextInferenceTime = Time.unscaledTime + m_InferenceIntervalSeconds;
            Vector2Int resolution = m_RgbCamera.GetResolution();
            Texture2D[] yuv = m_RgbCamera.GetYUVFormatTextures();
            if (resolution.x <= 0 || resolution.y <= 0 || yuv.Length < 3 ||
                yuv[0] == null || yuv[1] == null || yuv[2] == null)
            {
                Debug.LogWarning("XREAL RGB camera has no frame available.", this);
                SetStatus("Waiting for Beam Pro camera frame...");
                return;
            }

            if (m_LogCameraFrames && Time.unscaledTime >= m_NextFrameLogTime)
            {
                m_NextFrameLogTime = Time.unscaledTime + m_FrameLogIntervalSeconds;
                Debug.Log($"[PhoneObjectDetector] Beam Pro RGB frame received: {resolution.x}x{resolution.y}", this);
                SetStatus($"Camera OK: {resolution.x}x{resolution.y}");
            }

            try
            {
                UpdateYuvPreview(yuv[0], yuv[1], yuv[2]);
                byte[] rgba = ConvertYuvToRgba(yuv[0], yuv[1], yuv[2], resolution.x, resolution.y);
                DetectionFrameResult result = m_Detector.Detect(
                    rgba, resolution.x, resolution.y, m_TargetClass);
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

        static byte[] ConvertYuvToRgba(Texture2D yTexture, Texture2D uTexture,
            Texture2D vTexture, int width, int height)
        {
            Color32[] yPixels = yTexture.GetPixels32();
            Color32[] uPixels = uTexture.GetPixels32();
            Color32[] vPixels = vTexture.GetPixels32();
            byte[] rgba = new byte[width * height * 4];

            for (int y = 0; y < height; y++)
            {
                for (int x = 0; x < width; x++)
                {
                    int yIndex = y * width + x;
                    int uvIndex = (y / 2) * (width / 2) + (x / 2);
                    float luma = yPixels[yIndex].a * 255f;
                    float u = uPixels[uvIndex].a * 255f - 128f;
                    float v = vPixels[uvIndex].a * 255f - 128f;
                    int red = Mathf.Clamp(Mathf.RoundToInt(luma + 1.402f * v), 0, 255);
                    int green = Mathf.Clamp(Mathf.RoundToInt(luma - 0.344136f * u - 0.714136f * v), 0, 255);
                    int blue = Mathf.Clamp(Mathf.RoundToInt(luma + 1.772f * u), 0, 255);
                    int offset = yIndex * 4;
                    rgba[offset] = (byte)red;
                    rgba[offset + 1] = (byte)green;
                    rgba[offset + 2] = (byte)blue;
                    rgba[offset + 3] = 255;
                }
            }
            return rgba;
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

        void UpdateYuvPreview(Texture2D yTexture, Texture2D uTexture, Texture2D vTexture)
        {
            if (m_CameraPreview == null)
                return;

            if (m_PreviewMaterial == null)
            {
                Shader shader = Shader.Find("XREALSDK/CaptureBackgroundYUV");
                if (shader == null)
                {
                    Debug.LogError("Could not find XREAL YUV preview shader.", this);
                    SetStatus("ERROR: XREAL YUV shader missing");
                    return;
                }

                m_PreviewMaterial = new Material(shader)
                {
                    name = "Beam Pro Camera Preview Material"
                };
                m_CameraPreview.material = m_PreviewMaterial;
            }

            m_CameraPreview.texture = yTexture;
            m_PreviewMaterial.SetTexture("_UTex", uTexture);
            m_PreviewMaterial.SetTexture("_VTex", vTexture);
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
