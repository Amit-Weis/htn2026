using UnityEngine;
using UnityEngine.XR.ARSubsystems;

namespace Depth
{
    public struct Detection2D
    {
        public string label;
        public float confidence;
        public Vector2 pixel;
        public Rect bbox;
        public Vector2Int imageSize;
        public long timestampNs;
        public Pose worldFromCamera;
        public XRCameraIntrinsics intrinsics;
    }
}
