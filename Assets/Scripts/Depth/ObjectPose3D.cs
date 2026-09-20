using UnityEngine;

namespace Depth
{
    public struct ObjectPose3D
    {
        public string label;
        public float confidence;
        public Vector3 worldPos;
        public float depth;
        public long timestampNs;
    }
}
