using System;
using System.Collections;
using System.Collections.Generic;
using System.Linq;
using UnityEngine;
using System.Threading.Tasks;

namespace Forgetmenot
{
    /// <summary>
    /// One-file camera HUD. Opens the phone camera with WebCamTexture, runs the
    /// hacker_card ONNX detector through the existing Android plugin, and draws
    /// two head-locked quads parented to the eye camera:
    ///
    ///   top-right    raw camera feed
    ///   bottom-left  same feed with detection boxes overlaid
    ///
    /// No Canvas, no UI components, no AR Foundation. Assign viewCam; the quads
    /// and their materials are created at runtime because there is nothing to
    /// decide about them.
    /// </summary>
    public sealed class CameraHud : MonoBehaviour
    {
        [Header("References")]
        [SerializeField] Camera viewCam;

        [Header("Camera")]
        [SerializeField] bool useFrontCamera = false;
        [SerializeField] Vector2Int requestedResolution = new Vector2Int(1280, 720);
        [SerializeField, Min(1)] int requestedFps = 30;

        [Header("Detection")]
        [SerializeField] string targetClass = "hacker_card";
        [SerializeField, Range(0.05f, 1f)] float scoreThreshold = 0.3f;
        [SerializeField] float distanceConstant = 0.033f;
        [SerializeField, Min(0.05f)] float inferenceIntervalSeconds = 0.2f;
        [Tooltip("Longest edge sent to the model. 640 matches its input size.")]
        [SerializeField, Min(128)] int inferenceMaxEdge = 640;

        [Header("Layout")]
        [SerializeField, Min(0.3f)] float distance = 1.5f;
        [SerializeField, Range(0.05f, 0.6f)] float heightFrac = 0.25f;
        [SerializeField, Range(0f, 0.25f)] float margin = 0.08f;
        [SerializeField] bool showRawQuad = true;
        [SerializeField] bool showOverlayQuad = true;

        [Header("Boxes")]
        [SerializeField] Color boxColor = new Color(0.72f, 0.35f, 1f, 1f);
        [Tooltip("Edge thickness as a fraction of the overlay quad's height.")]
        [SerializeField, Range(0.002f, 0.05f)] float boxThicknessFrac = 0.012f;
        [SerializeField, Min(1)] int maxBoxes = 8;

        [Header("Debug")]
        [SerializeField] bool showStatusLabel = true;
        [SerializeField] bool logFrames = true;
        [SerializeField, Min(0.1f)] float frameLogIntervalSeconds = 2f;

        [SerializeField] DetectionFrameEvent m_OnDetections = new();
        public DetectionFrameEvent onDetections => m_OnDetections;

        // next to the other [Header("Detection")] fields
        //[SerializeField] float distanceConstant = 0f;

        WebCamTexture cam;
        AndroidMediaPipeDetector detector;

        Transform rawQuad;
        Transform overlayQuad;
        Material rawMat;
        Material overlayMat;
        Material boxMat;

        RenderTexture scaledRt;
        Texture2D readbackTex;

        readonly List<Transform> boxPool = new();

        float nextInferenceTime;
        float nextFrameLogTime;
        float lastFov, lastAspect, lastHeightFrac, lastMargin, lastDistance;
        string statusMessage = "Starting...";
        bool running;
        volatile bool inFlight;
        DetectionFrameResult pendingResult;
        readonly object resultLock = new object();
        public WebCamTexture CameraTexture => cam;

        // ------------------------------------------------------------- startup

        IEnumerator Start()
        {
            if (viewCam == null)
            {
                SetStatus("ERROR: viewCam not assigned");
                yield break;
            }

#if UNITY_ANDROID && !UNITY_EDITOR
            if (!UnityEngine.Android.Permission.HasUserAuthorizedPermission(
                    UnityEngine.Android.Permission.Camera))
            {
                SetStatus("Requesting camera permission...");
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
                Debug.Log($"[CameraHud] device '{d.name}' front={d.isFrontFacing}", this);

            string chosen = devices[0].name;
            foreach (WebCamDevice d in devices)
            {
                if (d.isFrontFacing == useFrontCamera) { chosen = d.name; break; }
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

            Debug.Log($"[CameraHud] {cam.width}x{cam.height} rot={cam.videoRotationAngle} " +
                      $"mirrored={cam.videoVerticallyMirrored}", this);

            if (cam.videoRotationAngle % 360 != 0)
            {
                Debug.LogWarning($"[CameraHud] WebCamTexture reports {cam.videoRotationAngle} degrees of " +
                                 "rotation. Neither the HUD quads nor the inference frame undo it, so set " +
                                 "LastSeenAnchor.imageRotation to match or the totem lands sideways.", this);
            }

            BuildQuads();
            AllocateBuffers();

            try
            {
                detector = new AndroidMediaPipeDetector(scoreThreshold, distanceConstant);
            }
            catch (Exception exception)
            {
                SetStatus($"ERROR: {exception.GetType().Name}");
                Debug.LogException(exception, this);
                yield break;
            }

            Place();
            running = true;
            SetStatus($"Camera OK: {cam.width}x{cam.height}");
        }

        // --------------------------------------------------------- quad setup

        void BuildQuads()
        {
            rawMat = MakeUnlitTextureMaterial();
            overlayMat = MakeUnlitTextureMaterial();
            boxMat = MakeUnlitColorMaterial(boxColor);

            SetTexture(rawMat, cam);
            SetTexture(overlayMat, cam);

            // WebCamTexture reports whether the driver hands frames back flipped.
            if (cam.videoVerticallyMirrored)
            {
                rawMat.mainTextureScale = new Vector2(1f, -1f);
                rawMat.mainTextureOffset = new Vector2(0f, 1f);
                overlayMat.mainTextureScale = new Vector2(1f, -1f);
                overlayMat.mainTextureOffset = new Vector2(0f, 1f);
            }

            rawQuad = MakeQuad("HUD Raw Feed", rawMat);
            overlayQuad = MakeQuad("HUD Overlay Feed", overlayMat);

            rawQuad.gameObject.SetActive(showRawQuad);
            overlayQuad.gameObject.SetActive(showOverlayQuad);
        }

        Transform MakeQuad(string name, Material material)
        {
            GameObject go = GameObject.CreatePrimitive(PrimitiveType.Quad);
            go.name = name;

            // Colliders on a head-locked HUD only get in the way of raycasts.
            Collider collider = go.GetComponent<Collider>();
            if (collider != null) Destroy(collider);

            var renderer = go.GetComponent<MeshRenderer>();
            renderer.sharedMaterial = material;
            renderer.shadowCastingMode = UnityEngine.Rendering.ShadowCastingMode.Off;
            renderer.receiveShadows = false;
            renderer.lightProbeUsage = UnityEngine.Rendering.LightProbeUsage.Off;

            go.transform.SetParent(viewCam.transform, false);
            return go.transform;
        }

        /// <summary>
        /// Built-in and URP name their unlit shaders differently, so try the
        /// plausible ones in order rather than assuming a pipeline.
        /// </summary>
        static Material MakeUnlitTextureMaterial()
        {
            string[] candidates =
            {
                "Unlit/Texture",
                "Universal Render Pipeline/Unlit",
                "Sprites/Default",
            };
            return new Material(FindShader(candidates));
        }

        static Material MakeUnlitColorMaterial(Color color)
        {
            string[] candidates =
            {
                "Unlit/Color",
                "Universal Render Pipeline/Unlit",
                "Sprites/Default",
            };
            var material = new Material(FindShader(candidates));
            SetColor(material, color);
            return material;
        }

        static Shader FindShader(string[] names)
        {
            foreach (string name in names)
            {
                Shader shader = Shader.Find(name);
                if (shader != null) return shader;
            }
            Debug.LogError("[CameraHud] No usable unlit shader found.");
            return Shader.Find("Standard");
        }

        static void SetTexture(Material material, Texture texture)
        {
            if (material.HasProperty("_BaseMap")) material.SetTexture("_BaseMap", texture);
            if (material.HasProperty("_MainTex")) material.SetTexture("_MainTex", texture);
        }

        static void SetColor(Material material, Color color)
        {
            if (material.HasProperty("_BaseColor")) material.SetColor("_BaseColor", color);
            if (material.HasProperty("_Color")) material.SetColor("_Color", color);
        }

        void AllocateBuffers()
        {
            float scale = Mathf.Min(1f, inferenceMaxEdge / (float)Mathf.Max(cam.width, cam.height));
            int w = Mathf.Max(32, Mathf.RoundToInt(cam.width * scale));
            int h = Mathf.Max(32, Mathf.RoundToInt(cam.height * scale));

            ReleaseBuffers();
            scaledRt = new RenderTexture(w, h, 0, RenderTextureFormat.ARGB32);
            scaledRt.Create();
            readbackTex = new Texture2D(w, h, TextureFormat.RGBA32, false);
        }

        void ReleaseBuffers()
        {
            if (scaledRt != null) { scaledRt.Release(); Destroy(scaledRt); scaledRt = null; }
            if (readbackTex != null) { Destroy(readbackTex); readbackTex = null; }
        }

        // ------------------------------------------------------------ placement

        void Place()
        {
            if (viewCam == null || cam == null || cam.width < 16) return;

            lastFov = viewCam.fieldOfView;
            lastAspect = viewCam.aspect;
            lastHeightFrac = heightFrac;
            lastMargin = margin;
            lastDistance = distance;

            float aspect = (float)cam.width / cam.height;
            float viewH = 2f * distance * Mathf.Tan(viewCam.fieldOfView * 0.5f * Mathf.Deg2Rad);
            float viewW = viewH * viewCam.aspect;

            float h = viewH * heightFrac;
            float w = h * aspect;

            float x = viewW * 0.5f - w * 0.5f - viewW * margin;
            float y = viewH * 0.5f - h * 0.5f - viewH * margin;

            if (rawQuad != null)
            {
                rawQuad.localPosition = new Vector3(x, y, distance);
                rawQuad.localRotation = Quaternion.identity;
                rawQuad.localScale = new Vector3(w, h, 1f);
            }

            if (overlayQuad != null)
            {
                overlayQuad.localPosition = new Vector3(-x, -y, distance);
                overlayQuad.localRotation = Quaternion.identity;
                overlayQuad.localScale = new Vector3(w, h, 1f);
            }
        }

        void LateUpdate()
        {
            if (viewCam == null || cam == null || cam.width < 16) return;

            bool changed =
                !Mathf.Approximately(lastFov, viewCam.fieldOfView) ||
                !Mathf.Approximately(lastAspect, viewCam.aspect) ||
                !Mathf.Approximately(lastHeightFrac, heightFrac) ||
                !Mathf.Approximately(lastMargin, margin) ||
                !Mathf.Approximately(lastDistance, distance);

            if (changed) Place();

            if (rawQuad != null) rawQuad.gameObject.SetActive(showRawQuad);
            if (overlayQuad != null) overlayQuad.gameObject.SetActive(showOverlayQuad);
        }

        // ----------------------------------------------------------- inference

        // ----------------------------------------------------------- inference

        void Update()
        {
            if (!running || cam == null || !cam.isPlaying) return;

            // Drain any finished inference first. This runs every frame, not on the
            // interval, so a result is consumed the frame after it lands.
            DetectionFrameResult ready = null;
            lock (resultLock)
            {
                ready = pendingResult;
                pendingResult = null;
            }

            if (ready != null)
            {
                DrawBoxes(ready);
                m_OnDetections.Invoke(ready);

                DetectionResult best = ready.detections
                    .OrderByDescending(item => item.confidence)
                    .FirstOrDefault();

                SetStatus(best != null
                ? $"{best.confidence:0.00}  w={best.bbox.Width}/{ready.image_width}  " +
                  $"d={distanceConstant / Mathf.Max(0.0001f, best.bbox.Width / (float)ready.image_width):0.00} m"
                : $"Camera OK: {cam.width}x{cam.height}");
            }

            // Then decide whether to kick off a new one.
            if (Time.unscaledTime < nextInferenceTime) return;
            if (inFlight) return;
            if (!cam.didUpdateThisFrame) return;
            if (scaledRt == null || readbackTex == null) return;

            nextInferenceTime = Time.unscaledTime + inferenceIntervalSeconds;

            try
            {
                // Unity stores texture rows bottom-up and the Java detector reads
                // them top-down, so the readback normally needs one flip. When the
                // driver already hands frames back upside down the two cancel and
                // the blit must not flip - same condition the HUD materials
                // correct for above, so both paths now agree on which way is up.
                // Get this wrong and every detection is mirrored about the horizon,
                // which is exactly what LastSeenAnchor then plants in the world.
                bool flipRows = !cam.videoVerticallyMirrored;
                var blitScale = new Vector2(1f, flipRows ? -1f : 1f);
                var blitOffset = new Vector2(0f, flipRows ? 1f : 0f);

                // Stamped on the result so the anchor can rewind the head pose by
                // the latency that actually happened, not by a slider.
                float captureTime = Time.unscaledTime;

                RenderTexture previous = RenderTexture.active;
                Graphics.Blit(cam, scaledRt, blitScale, blitOffset);
                RenderTexture.active = scaledRt;
                readbackTex.ReadPixels(new Rect(0, 0, scaledRt.width, scaledRt.height), 0, 0, false);
                readbackTex.Apply(false);
                RenderTexture.active = previous;

                // GetRawTextureData returns a copy, so the worker owns these bytes
                // and the next frame's readback cannot scribble over them.
                byte[] rgba = readbackTex.GetRawTextureData();
                int width = scaledRt.width;
                int height = scaledRt.height;

                if (logFrames && Time.unscaledTime >= nextFrameLogTime)
                {
                    nextFrameLogTime = Time.unscaledTime + frameLogIntervalSeconds;
                    Debug.Log($"[CameraHud] inference frame {width}x{height}", this);
                }

                inFlight = true;
                Task.Run(() =>
                {
                    // JNI from an unattached thread aborts the process rather than
                    // throwing, so this attach is mandatory, not defensive.
                    AndroidJNI.AttachCurrentThread();
                    try
                    {
                        DetectionFrameResult r = detector.Detect(rgba, width, height, targetClass);
                        if (r != null) r.captureUnscaledTime = captureTime;
                        lock (resultLock) pendingResult = r;
                    }
                    catch (Exception workerException)
                    {
                        Debug.LogException(workerException);
                    }
                    finally
                    {
                        inFlight = false;
                    }
                });
            }
            catch (Exception exception)
            {
                SetStatus($"ERROR: {exception.Message}");
                Debug.LogException(exception, this);
                running = false;
            }
        }

        // --------------------------------------------------------------- boxes

        void DrawBoxes(DetectionFrameResult frame)
        {
            int used = 0;

            if (frame != null && overlayQuad != null &&
                frame.image_width > 0 && frame.image_height > 0)
            {
                DetectionResult[] dets = frame.detections ?? Array.Empty<DetectionResult>();
                float imgW = frame.image_width;
                float imgH = frame.image_height;

                foreach (DetectionResult d in dets)
                {
                    if (d == null || used >= maxBoxes) break;

                    // Detector space is top-down; quad local space is bottom-up,
                    // spanning -0.5..0.5 on both axes.
                    float u1 = Mathf.Clamp01(d.bbox.x1 / imgW);
                    float u2 = Mathf.Clamp01(d.bbox.x2 / imgW);
                    float v1 = Mathf.Clamp01(1f - d.bbox.y2 / imgH);
                    float v2 = Mathf.Clamp01(1f - d.bbox.y1 / imgH);

                    float cx = (u1 + u2) * 0.5f - 0.5f;
                    float cy = (v1 + v2) * 0.5f - 0.5f;
                    float bw = Mathf.Abs(u2 - u1);
                    float bh = Mathf.Abs(v2 - v1);

                    // Keep edges visually square despite the quad's non-uniform
                    // scale: thickness is a fraction of height, corrected on x.
                    float quadAspect = overlayQuad.localScale.x / Mathf.Max(0.0001f, overlayQuad.localScale.y);
                    float tY = boxThicknessFrac;
                    float tX = boxThicknessFrac / Mathf.Max(0.0001f, quadAspect);

                    Edge(used, 0, new Vector3(cx, cy + bh * 0.5f, 0f), new Vector3(bw + tX, tY, 1f));
                    Edge(used, 1, new Vector3(cx, cy - bh * 0.5f, 0f), new Vector3(bw + tX, tY, 1f));
                    Edge(used, 2, new Vector3(cx - bw * 0.5f, cy, 0f), new Vector3(tX, bh, 1f));
                    Edge(used, 3, new Vector3(cx + bw * 0.5f, cy, 0f), new Vector3(tX, bh, 1f));

                    used++;
                }
            }

            for (int i = used * 4; i < boxPool.Count; i++)
                boxPool[i].gameObject.SetActive(false);
        }

        void Edge(int boxIndex, int edgeIndex, Vector3 localPos, Vector3 localScale)
        {
            int i = boxIndex * 4 + edgeIndex;

            while (boxPool.Count <= i)
            {
                GameObject go = GameObject.CreatePrimitive(PrimitiveType.Quad);
                go.name = $"BoxEdge{boxPool.Count}";

                Collider collider = go.GetComponent<Collider>();
                if (collider != null) Destroy(collider);

                var renderer = go.GetComponent<MeshRenderer>();
                renderer.sharedMaterial = boxMat;
                renderer.shadowCastingMode = UnityEngine.Rendering.ShadowCastingMode.Off;
                renderer.receiveShadows = false;
                renderer.lightProbeUsage = UnityEngine.Rendering.LightProbeUsage.Off;

                go.transform.SetParent(overlayQuad, false);
                boxPool.Add(go.transform);
            }

            Transform edge = boxPool[i];
            // Slightly in front of the feed so it never z-fights with it.
            edge.localPosition = new Vector3(localPos.x, localPos.y, -0.001f);
            edge.localRotation = Quaternion.identity;
            edge.localScale = localScale;
            edge.gameObject.SetActive(true);
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

            if (rawQuad != null) Destroy(rawQuad.gameObject);
            if (overlayQuad != null) Destroy(overlayQuad.gameObject);
            boxPool.Clear();

            if (rawMat != null) Destroy(rawMat);
            if (overlayMat != null) Destroy(overlayMat);
            if (boxMat != null) Destroy(boxMat);
        }

        void SetStatus(string message) => statusMessage = message;

        void OnGUI()
        {
            if (!showStatusLabel) return;
            GUI.color = Color.white;
            GUI.Label(new Rect(20, 20, 600, 40), statusMessage);
        }
    }
}
