using System;
using UnityEngine;

namespace Forgetmenot
{
    public sealed class AndroidMediaPipeDetector : IDisposable
    {
#if UNITY_ANDROID && !UNITY_EDITOR
        readonly AndroidJavaObject m_Plugin;
#endif

        public AndroidMediaPipeDetector(float scoreThreshold)
        {
#if UNITY_ANDROID && !UNITY_EDITOR
            using var unityPlayer = new AndroidJavaClass("com.unity3d.player.UnityPlayer");
<<<<<<< HEAD
            using var activity = unityPlayer.GetStatic<AndroidJavaObject>("currentActivity");
            m_Plugin = new AndroidJavaObject(
                "com.forgetmenot.cv.MediaPipeDetector", activity, scoreThreshold);
#else
            Debug.Log("MediaPipe object detection is available only in an Android player.");
=======
            var activity = unityPlayer.GetStatic<AndroidJavaObject>("currentActivity");
            m_Plugin = new AndroidJavaObject(
                "com.forgetmenot.cv.MediaPipeDetector",
                activity,
                scoreThreshold);
#else
            Debug.Log("Android MediaPipe detector is available only in an Android player.");
>>>>>>> e3f5b26b2ab5fa16c029a3841b080ea0a09f6e45
#endif
        }

        public DetectionFrameResult Detect(byte[] rgba, int width, int height, string targetClass)
        {
<<<<<<< HEAD
#if UNITY_ANDROID && !UNITY_EDITOR
            string json = m_Plugin.Call<string>("detectRgba", rgba, width, height, targetClass ?? string.Empty);
=======
            return Detect(rgba, width, height, targetClass, 0, 0, 0, false);
        }

        public DetectionFrameResult Detect(
            byte[] rgba,
            int width,
            int height,
            string targetClass,
            long frameId,
            long timestampMs,
            int rotationDegrees,
            bool mirrored)
        {
#if UNITY_ANDROID && !UNITY_EDITOR
            string json = m_Plugin.Call<string>(
                "detectRgba", rgba, width, height, targetClass ?? "",
                frameId, timestampMs, rotationDegrees, mirrored);
>>>>>>> e3f5b26b2ab5fa16c029a3841b080ea0a09f6e45
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
