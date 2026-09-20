using System;
using System.Collections.Generic;
using Forgetmenot;
using Lastseen;
using Unity.Collections;
using UnityEngine;
using UnityEngine.XR.ARFoundation;
using UnityEngine.XR.ARSubsystems;

namespace LastseenApp
{
    /// <summary>
    /// Continuous, low-rate object detection on the AR camera feed (all COCO classes, no early stop): the "MediaPipe as a native
    /// Android plugin" step of the plan. It only produces per-frame detections for ObjectStabilityTracker to decide when something
    /// has been put down; the boxes that go to the Worker are re-detected on the stereo photo itself (PlacementCapture), so they
    /// always match the image the depth is measured on.
    /// Add it next to an ARCameraManager (LastseenController does this when the scene has one).
    /// </summary>
    [RequireComponent(typeof(ARCameraManager))]
    public sealed class LiveDetector : MonoBehaviour
    {
        [Range(0.05f, 1f)] public float scoreThreshold = 0.35f;
        [Min(0.1f)] public float intervalSeconds = 0.5f;

        /// <summary>epoch ms, detections normalized to the analysed image (origin top-left)</summary>
        public event Action<long, List<Lastseen.Detection>> Frame;
        public int Analysed { get; private set; }
        public string LastError { get; private set; }

        ARCameraManager cameraManager;
        AndroidMediaPipeDetector detector;
        float nextTime;

        void OnEnable()
        {
            cameraManager = GetComponent<ARCameraManager>();
            detector = new AndroidMediaPipeDetector(scoreThreshold);
            cameraManager.frameReceived += OnCameraFrame;
        }

        void OnDisable()
        {
            if (cameraManager != null) cameraManager.frameReceived -= OnCameraFrame;
            if (detector != null) detector.Dispose();
            detector = null;
        }

        void OnCameraFrame(ARCameraFrameEventArgs args)
        {
            if (Time.unscaledTime < nextTime) return;
            nextTime = Time.unscaledTime + intervalSeconds;
            if (!cameraManager.TryAcquireLatestCpuImage(out XRCpuImage image)) return;

            try
            {
                using (image)
                {
                    // half resolution is plenty for EfficientDet-Lite0 (which resizes to 320 px anyway) and 4x cheaper to convert
                    var size = new Vector2Int(Mathf.Max(2, image.width / 2), Mathf.Max(2, image.height / 2));
                    var conversion = new XRCpuImage.ConversionParams
                    {
                        inputRect = new RectInt(0, 0, image.width, image.height),
                        outputDimensions = size,
                        outputFormat = TextureFormat.RGBA32,
                        transformation = XRCpuImage.Transformation.None,
                    };
                    using (var rgba = new NativeArray<byte>(image.GetConvertedDataSize(conversion), Allocator.Temp))
                    {
                        image.Convert(conversion, rgba);
                        DetectionFrameResult result = detector.Detect(rgba.ToArray(), size.x, size.y, "");
                        Analysed++;
                        var handler = Frame;
                        if (handler != null) handler(DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(), ToDetections(result));
                    }
                }
            }
            catch (Exception e)
            {
                LastError = e.Message;
            }
        }

        /// <summary>MediaPipe pixel corners to normalized boxes.</summary>
        public static List<Lastseen.Detection> ToDetections(DetectionFrameResult r)
        {
            var list = new List<Lastseen.Detection>();
            if (r == null || r.detections == null) return list;
            foreach (var d in r.detections)
            {
                if (d == null || d.bbox == null || string.IsNullOrEmpty(d.class_name)) continue;
                list.Add(new Lastseen.Detection(d.class_name, d.confidence, Box.FromCorners(d.bbox.x1, d.bbox.y1, d.bbox.x2, d.bbox.y2, r.image_width, r.image_height)));
            }
            return list;
        }
    }
}
