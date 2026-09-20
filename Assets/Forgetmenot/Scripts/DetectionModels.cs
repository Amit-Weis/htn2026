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
    }

    [Serializable]
    public sealed class DetectionResult
    {
        public string class_name;
        public float confidence;
        public DetectionBox bbox;
        public DetectionPoint center;
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
    }
}
