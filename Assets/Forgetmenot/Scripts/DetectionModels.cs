using System;
using UnityEngine;

namespace Forgetmenot
{
    [Serializable]
    public class DetectionPoint
    {
        public int x;
        public int y;
    }

    [Serializable]
    public class DetectionBox
    {
        public int x1;
        public int y1;
        public int x2;
        public int y2;
    }

    [Serializable]
    public class DetectionResult
    {
        public string class_name;
        public float confidence;
        public DetectionBox bbox;
        public DetectionPoint center;
    }

    [Serializable]
    public class DetectionFrameResult
    {
        public long frame_id;
        public long timestamp_ms;
        public int image_width;
        public int image_height;
        public int rotation_degrees;
        public bool mirrored;
        public DetectionResult[] detections = Array.Empty<DetectionResult>();

        public static DetectionFrameResult FromJson(string json)
        {
            if (string.IsNullOrWhiteSpace(json))
                return new DetectionFrameResult();

            return JsonUtility.FromJson<DetectionFrameResult>(json) ?? new DetectionFrameResult();
        }
    }
}
