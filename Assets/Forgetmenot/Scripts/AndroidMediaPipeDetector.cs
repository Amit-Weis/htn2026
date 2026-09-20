using System;
using UnityEngine;

namespace Forgetmenot
{
    public sealed class AndroidMediaPipeDetector : IDisposable
    {
#if UNITY_ANDROID && !UNITY_EDITOR
        readonly AndroidJavaObject m_Plugin;
#endif

        /// <summary>
        /// distanceConstant is normalized_width_distance_constant from the size
        /// calibration. Pass 0 to leave distance_m out of the plugin's JSON, which
        /// is the old behaviour; LastSeenAnchor can still fill it in on the C# side.
        /// </summary>
        public AndroidMediaPipeDetector(float scoreThreshold, float distanceConstant = 0f)
        {
#if UNITY_ANDROID && !UNITY_EDITOR
            using var unityPlayer = new AndroidJavaClass("com.unity3d.player.UnityPlayer");
            using var activity = unityPlayer.GetStatic<AndroidJavaObject>("currentActivity");
            m_Plugin = new AndroidJavaObject(
                "com.forgetmenot.cv.MediaPipeDetector", activity, scoreThreshold, distanceConstant);
#else
            Debug.Log("MediaPipe object detection is available only in an Android player.");
#endif
        }

        public DetectionFrameResult Detect(byte[] rgba, int width, int height, string targetClass)
        {
#if UNITY_ANDROID && !UNITY_EDITOR
            string json = m_Plugin.Call<string>("detectRgba", rgba, width, height, targetClass ?? string.Empty);
            return DetectionFrameResult.FromJson(json);
#else
            return new DetectionFrameResult { image_width = width, image_height = height };
#endif
        }

        public void Dispose()
        {
#if UNITY_ANDROID && !UNITY_EDITOR
            m_Plugin?.Call("close");
            m_Plugin?.Dispose();
#endif
        }
    }
}
