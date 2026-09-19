using UnityEngine;

namespace Depth
{
    // Conventions
    // Image space: origin TOP-LEFT, u right, v down, in pixels of the original camera image.
    //   Rects in this space use (x, y) = top-left corner, then (width, height).
    //   Unity's Rect is bottom-left based, hence RectTopLeftToBottomLeftY.
    // Camera space (Unity): +x right, +y up, +z forward along the optical axis, meters.
    // Depth z is the distance along the optical axis, not the Euclidean range.
    // Intrinsics are in pixels and only valid at the resolution they were reported for.
    // AR Foundation's XRCameraIntrinsics.principalPoint origin convention is platform-defined
    // and unverified for XREAL; the (cx, cy) passed to these functions is the one place to adjust.
    public static class PinholeMath
    {
        public static Vector3 PixelToCameraRay(float u, float v, float fx, float fy, float cx, float cy)
        {
            return new Vector3((u - cx) / fx, -(v - cy) / fy, 1f);
        }

        public static Vector3 Unproject(float u, float v, float z, float fx, float fy, float cx, float cy)
        {
            return PixelToCameraRay(u, v, fx, fy, cx, cy) * z;
        }

        public static Vector3 CameraToWorld(Vector3 pCam, Pose worldFromCamera)
        {
            return worldFromCamera.rotation * pCam + worldFromCamera.position;
        }

        // Its own inverse: calling it again with the same h converts back.
        public static float RectTopLeftToBottomLeftY(float y, float h, int imageHeight)
        {
            return imageHeight - y - h;
        }
    }
}
