using System;

namespace Depth
{
    // JSON returned by the Cloudflare locate endpoint (JsonUtility, so fields keep the wire names).
    // u, v are pixels in the left image of the side-by-side photo, origin top-left.
    // width/height are that image's size; fx, fy, cx, cy are pixel intrinsics at that size.
    // depth_m is meters along the camera optical axis (see PinholeMath conventions).
    [Serializable]
    public class LocateResponse
    {
        public bool found;
        public string error;
        public string label;
        public float confidence;
        public float u;
        public float v;
        public float depth_m;
        public int width;
        public int height;
        public float fx;
        public float fy;
        public float cx;
        public float cy;
        public long timestamp_ns;
    }
}
