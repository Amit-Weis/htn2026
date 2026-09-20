using System;
using System.Collections;
using System.Linq;
using UnityEngine;
using UnityEngine.Events;
using UnityEngine.UI;

namespace Forgetmenot
{
    /// <summary>
    /// Drop-in replacement for PhoneObjectDetector that uses WebCamTexture instead
    /// of ARCameraManager. Emits the same DetectionFrameResult contract, so
    /// HackerCardHud and FixedDepthArrowController work against it unchanged.
    ///
    /// Frames are downscaled before inference. The model letterboxes to 320x320
    /// internally, so sending full-resolution pixels costs readback time and buys
    /// nothing. Detections come back in downscaled coordinates and image_width /
    /// image_height report that same space, so normalized consumers stay correct.
    /// </summary>
    public sealed class WebcamObjectDetector : MonoBehaviour
    {
        [Header("Camera")]
        [SerializeField] bool useFrontCamera = false;
        [SerializeField] Vector2Int requestedResolution = new Vector2Int(1280, 720);
        [SerializeField, Min(1)] int requestedFps = 30;

        [Header("Detection")]
        [SerializeField] string targetClass = "hacker_card";
        [SerializeField, Range(0.05f, 1f)] float scoreThreshold = 0.3f;
        [SerializeField, Min(0.05f)] float inferenceIntervalSeconds = 0.2f;
        [Tooltip("Longest edge sent to the model. 320 matches its input size.")]
        [SerializeField, Min(128)] int inferenceMaxEdge = 320;

        [Header("Output")]
        [SerializeField] RawImage cameraPreview;
        [SerializeField] Text statusText;
        [SerializeField] bool logFrames = true;
        [SerializeField, Min(0.1f)] float frameLogIntervalSeconds = 2f;
        [SerializeField] DetectionFrameEvent m_OnDetections = new();

        WebCamTexture cam;
        AndroidMediaPipeDetector detector;
        RenderTexture scaledRt;
        Texture2D readbackTex;
        float nextInferenceTime;
        float nextFrameLogTime;
        string statusMessage = "Detector not started";
        bool running;

        public DetectionFrameEvent onDetections => m_OnDetections;

        /// <summary>The live camera texture, once it has started. Null before that.</summary>
        public WebCamTexture CameraTexture => cam;

        // ------------------------------------------------------------ startup

        IEnumerator Start()
        {
            SetStatus("Requesting camera permission...");

#if UNITY_ANDROID && !UNITY_EDITOR
            if (!UnityEngine.Android.Permission.HasUserAuthorizedPermission(
                    UnityEngine.Android.Permission.Camera))
            {
                UnityEngine.Android.Permission.RequestUserPermission(
                    UnityEngine.Android.Permission.Camera);

                float deadline = Time.unscaledTime + 30f;
                while (!UnityEngine.Android.Permission.HasUserAuthorizedPermission(
                           UnityEngine.Android.Permission.Camera))
                {
                    if (Time.unscaledTime > deadline)
                    {
                        SetStatus("ERROR: camera permission denied");
                        yield break;
                    }
                    yield return null;
                }
            }
#endif

            WebCamDevice[] devices = WebCamTexture.devices;
            if (devices.Length == 0)
            {
                SetStatus("ERROR: no cameras reported");
                yield break;
            }

            foreach (WebCamDevice d in devices)
                Debug.Log($"[WebcamObjectDetector] device '{d.name}' front={d.isFrontFacing}", this);

            string chosen = devices[0].name;
            foreach (WebCamDevice d in devices)
            {
                if (d.isFrontFacing == useFrontCamera)
                {
                    chosen = d.name;
                    break;
                }
            }

            cam = new WebCamTexture(chosen, requestedResolution.x, requestedResolution.y, requestedFps);
            cam.Play();
            SetStatus($"Starting camera '{chosen}'...");

            float startDeadline = Time.unscaledTime + 10f;
            while (cam.width < 16)
            {
                if (Time.unscaledTime > startDeadline)
                {
                    SetStatus("ERROR: camera never delivered a frame");
                    yield break;
                }
                yield return null;
            }

            if (cameraPreview != null)
            {
                cameraPreview.texture = cam;
                cameraPreview.uvRect = new Rect(0f, 0f, 1f, 1f);
            }

            Debug.Log($"[WebcamObjectDetector] {cam.width}x{cam.height} " +
                      $"rot={cam.videoRotationAngle} mirrored={cam.videoVerticallyMirrored}", this);

            try
            {
                detector = new AndroidMediaPipeDetector(scoreThreshold);
            }
            catch (Exception exception)
            {
                SetStatus($"ERROR: {exception.GetType().Name}");
                Debug.LogException(exception, this);
                yield break;
            }

            AllocateBuffers();
            running = true;
            SetStatus($"Camera OK: {cam.width}x{cam.height}");
        }

        void AllocateBuffers()
        {
            float scale = Mathf.Min(1f,
                inferenceMaxEdge / (float)Mathf.Max(cam.width, cam.height));
            int w = Mathf.Max(32, Mathf.RoundToInt(cam.width * scale));
            int h = Mathf.Max(32, Mathf.RoundToInt(cam.height * scale));

            ReleaseBuffers();
            scaledRt = new RenderTexture(w, h, 0, RenderTextureFormat.ARGB32);
            scaledRt.Create();
            readbackTex = new Texture2D(w, h, TextureFormat.RGBA32, false);
        }

        void ReleaseBuffers()
        {
            if (scaledRt != null)
            {
                scaledRt.Release();
                Destroy(scaledRt);
                scaledRt = null;
            }
            if (readbackTex != null)
            {
                Destroy(readbackTex);
                readbackTex = null;
            }
        }

        // -------------------------------------------------------------- loop

        void Update()
        {
            if (!running || cam == null || !cam.isPlaying) return;
            if (Time.unscaledTime < nextInferenceTime) return;
            nextInferenceTime = Time.unscaledTime + inferenceIntervalSeconds;

            if (!cam.didUpdateThisFrame) return;

            if (scaledRt == null || readbackTex == null) return;

            try
            {
                // Blit with a vertical flip so the readback rows come out top-down,
                // which is the order the Java detector expects.
                RenderTexture previous = RenderTexture.active;
                Graphics.Blit(cam, scaledRt, new Vector2(1f, -1f), new Vector2(0f, 1f));
                RenderTexture.active = scaledRt;
                readbackTex.ReadPixels(new Rect(0, 0, scaledRt.width, scaledRt.height), 0, 0, false);
                readbackTex.Apply(false);
                RenderTexture.active = previous;

                byte[] rgba = readbackTex.GetRawTextureData();

                if (logFrames && Time.unscaledTime >= nextFrameLogTime)
                {
                    nextFrameLogTime = Time.unscaledTime + frameLogIntervalSeconds;
                    Debug.Log($"[WebcamObjectDetector] inference frame " +
                              $"{scaledRt.width}x{scaledRt.height}", this);
                }

                DetectionFrameResult result = detector.Detect(
                    rgba, scaledRt.width, scaledRt.height, targetClass);

                m_OnDetections.Invoke(result);

                DetectionResult best = result.detections
                    .OrderByDescending(item => item.confidence)
                    .FirstOrDefault();

                SetStatus(best != null
                    ? $"Detected {best.class_name} ({best.confidence:0.00})"
                    : $"Camera OK: {cam.width}x{cam.height}");
            }
            catch (Exception exception)
            {
                SetStatus($"ERROR: {exception.GetType().Name}");
                Debug.LogException(exception, this);
                running = false;
            }
        }

        // ------------------------------------------------------------ teardown

        void OnDisable()
        {
            running = false;

            if (cam != null)
            {
                if (cam.isPlaying) cam.Stop();
                Destroy(cam);
                cam = null;
            }

            detector?.Dispose();
            detector = null;

            ReleaseBuffers();
        }

        void SetStatus(string message)
        {
            statusMessage = message;
            if (statusText != null) statusText.text = message;
        }

        void OnGUI()
        {
            if (statusText != null) return;
            GUI.color = Color.white;
            GUI.Label(new Rect(20, 20, 600, 40), statusMessage);
        }
    }
}
