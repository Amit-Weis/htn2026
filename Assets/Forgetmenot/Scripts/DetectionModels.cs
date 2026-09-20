using System;
using UnityEngine;

namespace Forgetmenot
{
    [Serializable]
    public struct DetectionPoint
    {
        public int x;
        public int y;
    }

    [Serializable]
    public struct DetectionBox
    {
        public int x1;
        public int y1;
        public int x2;
        public int y2;

        public int Width => x2 - x1;
        public int Height => y2 - y1;
    }

    [Serializable]
    public sealed class DetectionResult
    {
        public string class_name;
        public float confidence;
        public DetectionBox bbox;
        public DetectionPoint center;

        /// <summary>
        /// Estimated range in metres. Matches distance_m in the Python contract.
        /// JsonUtility leaves this at 0 when the producer did not send it, so 0
        /// means "unknown", never "at the camera".
        /// </summary>
        public float distance_m;

        public bool HasDistance => distance_m > 0f;
    }

    [Serializable]
    public sealed class DetectionFrameResult
    {
        public int image_width;
        public int image_height;
        public DetectionResult[] detections = Array.Empty<DetectionResult>();

        public static DetectionFrameResult FromJson(string json)
        {
            if (string.IsNullOrWhiteSpace(json))
                return new DetectionFrameResult();

            DetectionFrameResult result = JsonUtility.FromJson<DetectionFrameResult>(json);
            if (result == null)
                return new DetectionFrameResult();

            result.detections ??= Array.Empty<DetectionResult>();
            return result;
        }

        /// <summary>
        /// Fills distance_m for any detection that came back without one, using the
        /// same known-size model as KnownSizeDistanceEstimator on the Python side:
        ///
        ///     distance = constant / (boxWidthPx / imageWidthPx)
        ///
        /// constant is normalized_width_distance_constant from the calibration JSON.
        /// Because the width is normalised, this is resolution independent, so the
        /// downscaled inference frame gives the same answer as the full frame. It is
        /// NOT FOV independent: recalibrate if you change the camera.
        /// </summary>
        public void FillMissingDistances(float normalizedWidthDistanceConstant)
        {
            if (normalizedWidthDistanceConstant <= 0f || image_width <= 0)
                return;

            foreach (DetectionResult detection in detections)
            {
                if (detection == null || detection.HasDistance)
                    continue;

                float normalizedWidth = detection.bbox.Width / (float)image_width;
                if (normalizedWidth > 0f)
                    detection.distance_m = normalizedWidthDistanceConstant / normalizedWidth;
            }
        }
    }
}
