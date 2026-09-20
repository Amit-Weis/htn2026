using System;
using UnityEngine;

namespace Forgetmenot
{
    [Serializable]
<<<<<<< HEAD
    public struct DetectionPoint
=======
    public class DetectionPoint
>>>>>>> e3f5b26b2ab5fa16c029a3841b080ea0a09f6e45
    {
        public int x;
        public int y;
    }

    [Serializable]
<<<<<<< HEAD
    public struct DetectionBox
=======
    public class DetectionBox
>>>>>>> e3f5b26b2ab5fa16c029a3841b080ea0a09f6e45
    {
        public int x1;
        public int y1;
        public int x2;
        public int y2;
    }

    [Serializable]
<<<<<<< HEAD
    public sealed class DetectionResult
=======
    public class DetectionResult
>>>>>>> e3f5b26b2ab5fa16c029a3841b080ea0a09f6e45
    {
        public string class_name;
        public float confidence;
        public DetectionBox bbox;
        public DetectionPoint center;
    }

    [Serializable]
<<<<<<< HEAD
    public sealed class DetectionFrameResult
    {
        public int image_width;
        public int image_height;
=======
    public class DetectionFrameResult
    {
        public long frame_id;
        public long timestamp_ms;
        public int image_width;
        public int image_height;
        public int rotation_degrees;
        public bool mirrored;
>>>>>>> e3f5b26b2ab5fa16c029a3841b080ea0a09f6e45
        public DetectionResult[] detections = Array.Empty<DetectionResult>();

        public static DetectionFrameResult FromJson(string json)
        {
            if (string.IsNullOrWhiteSpace(json))
                return new DetectionFrameResult();

<<<<<<< HEAD
            DetectionFrameResult result = JsonUtility.FromJson<DetectionFrameResult>(json);
            if (result == null)
                return new DetectionFrameResult();

            result.detections ??= Array.Empty<DetectionResult>();
            return result;
=======
            return JsonUtility.FromJson<DetectionFrameResult>(json) ?? new DetectionFrameResult();
>>>>>>> e3f5b26b2ab5fa16c029a3841b080ea0a09f6e45
        }
    }
}
