using UnityEngine;

namespace Forgetmenot
{
    public static class DetectionCoordinateMapper
    {
        // MediaPipe coordinates start at top-left; Unity screen coordinates start at bottom-left.
        public static Vector2 ImageToScreen(
            Vector2 imagePoint,
            Vector2 imageSize,
            Vector2 screenSize,
            bool mirrorX = false)
        {
            float normalizedX = Mathf.Clamp01(imagePoint.x / imageSize.x);
            float normalizedY = Mathf.Clamp01(imagePoint.y / imageSize.y);
            if (mirrorX)
                normalizedX = 1f - normalizedX;

            return new Vector2(
                normalizedX * screenSize.x,
                (1f - normalizedY) * screenSize.y);
        }
    }
}
