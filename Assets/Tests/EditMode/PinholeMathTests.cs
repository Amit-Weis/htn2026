using NUnit.Framework;
using UnityEngine;

namespace Depth.Tests
{
    public class PinholeMathTests
    {
        const float Tol = 1e-4f;
        const float Fx = 600f, Fy = 500f, Cx = 320f, Cy = 240f;

        static void AssertVec(Vector3 expected, Vector3 actual)
        {
            Assert.AreEqual(expected.x, actual.x, Tol);
            Assert.AreEqual(expected.y, actual.y, Tol);
            Assert.AreEqual(expected.z, actual.z, Tol);
        }

        [Test]
        public void PrincipalPoint_GivesRayAlongPlusZ()
        {
            AssertVec(new Vector3(0f, 0f, 1f), PinholeMath.PixelToCameraRay(Cx, Cy, Fx, Fy, Cx, Cy));
        }

        [Test]
        public void ProjectThenUnproject_ReturnsOriginalPoint()
        {
            var p = new Vector3(0.5f, -0.25f, 2f);
            float u = Fx * p.x / p.z + Cx;
            float v = Cy - Fy * p.y / p.z;
            Assert.AreEqual(470f, u, Tol);
            Assert.AreEqual(302.5f, v, Tol);

            AssertVec(p, PinholeMath.Unproject(u, v, p.z, Fx, Fy, Cx, Cy));
        }

        [Test]
        public void PixelBelowPrincipalPoint_GivesNegativeY()
        {
            var p = PinholeMath.Unproject(Cx, Cy + 50f, 1f, Fx, Fy, Cx, Cy);
            Assert.Less(p.y, 0f);
            Assert.AreEqual(-0.1f, p.y, Tol);
            Assert.AreEqual(0f, p.x, Tol);
        }

        [Test]
        public void CameraToWorld_AppliesRotationThenTranslation()
        {
            var pose = new Pose(new Vector3(10f, 20f, 30f), Quaternion.Euler(0f, 90f, 0f));
            // +90 deg about Y maps (x, y, z) to (z, y, -x)
            AssertVec(new Vector3(13f, 22f, 29f), PinholeMath.CameraToWorld(new Vector3(1f, 2f, 3f), pose));
        }

        [Test]
        public void RectConversion_RoundTrips()
        {
            const int imageHeight = 480;
            float bottomLeftY = PinholeMath.RectTopLeftToBottomLeftY(100f, 50f, imageHeight);
            Assert.AreEqual(330f, bottomLeftY, Tol);
            Assert.AreEqual(100f, PinholeMath.RectTopLeftToBottomLeftY(bottomLeftY, 50f, imageHeight), Tol);
        }
    }
}
