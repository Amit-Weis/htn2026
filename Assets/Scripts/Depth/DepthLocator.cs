using System;
using UnityEngine;

namespace Depth
{
    public class DepthLocator : MonoBehaviour
    {
        public IDepthSource DepthSource { get; set; }

        public event Action<ObjectPose3D> Located;

        public bool TryLocate(in Detection2D d, out ObjectPose3D result)
        {
            result = default;

            var focal = d.intrinsics.focalLength;
            if (!(focal.x > 0f) || !(focal.y > 0f))
                return false;

            if (DepthSource == null || !DepthSource.TryGetDepth(d, out float z, out _))
                return false;

            var pp = d.intrinsics.principalPoint;
            var pCam = PinholeMath.Unproject(d.pixel.x, d.pixel.y, z, focal.x, focal.y, pp.x, pp.y);

            result = new ObjectPose3D
            {
                label = d.label,
                confidence = d.confidence,
                worldPos = PinholeMath.CameraToWorld(pCam, d.worldFromCamera),
                depth = z,
                timestampNs = d.timestampNs,
            };
            Located?.Invoke(result);
            return true;
        }
    }
}
