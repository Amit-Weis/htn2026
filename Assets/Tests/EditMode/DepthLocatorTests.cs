using NUnit.Framework;
using UnityEngine;
using UnityEngine.XR.ARSubsystems;

namespace Depth.Tests
{
    public class DepthLocatorTests
    {
        class FakeDepthSource : IDepthSource
        {
            public bool hasDepth = true;
            public float z = 2f;

            public bool TryGetDepth(in Detection2D detection, out float depth, out float confidence)
            {
                depth = z;
                confidence = 1f;
                return hasDepth;
            }
        }

        GameObject go;
        DepthLocator locator;
        FakeDepthSource source;

        [SetUp]
        public void SetUp()
        {
            go = new GameObject();
            locator = go.AddComponent<DepthLocator>();
            source = new FakeDepthSource();
            locator.DepthSource = source;
        }

        [TearDown]
        public void TearDown()
        {
            Object.DestroyImmediate(go);
        }

        static Detection2D MakeDetection() => new Detection2D
        {
            label = "cup",
            confidence = 0.9f,
            pixel = new Vector2(420f, 140f),
            imageSize = new Vector2Int(640, 480),
            timestampNs = 123L,
            worldFromCamera = new Pose(new Vector3(10f, 20f, 30f), Quaternion.Euler(0f, 90f, 0f)),
            intrinsics = new XRCameraIntrinsics(new Vector2(500f, 400f), new Vector2(320f, 240f), new Vector2Int(640, 480)),
        };

        [Test]
        public void TryLocate_ConstantDepth_MatchesHandComputedWorldPoint()
        {
            int located = 0;
            locator.Located += _ => located++;

            Assert.IsTrue(locator.TryLocate(MakeDetection(), out var result));

            // camera space: x = (420-320)/500*2 = 0.4, y = -(140-240)/400*2 = 0.5, z = 2
            // rotate +90 deg about Y: (z, y, -x) = (2, 0.5, -0.4), then add (10, 20, 30)
            Assert.AreEqual(12f, result.worldPos.x, 1e-4f);
            Assert.AreEqual(20.5f, result.worldPos.y, 1e-4f);
            Assert.AreEqual(29.6f, result.worldPos.z, 1e-4f);
            Assert.AreEqual(2f, result.depth, 1e-6f);
            Assert.AreEqual("cup", result.label);
            Assert.AreEqual(0.9f, result.confidence, 1e-6f);
            Assert.AreEqual(123L, result.timestampNs);
            Assert.AreEqual(1, located);
        }

        [Test]
        public void TryLocate_NoDepth_ReturnsFalseAndDoesNotRaiseEvent()
        {
            source.hasDepth = false;
            int located = 0;
            locator.Located += _ => located++;

            Assert.IsFalse(locator.TryLocate(MakeDetection(), out _));
            Assert.AreEqual(0, located);
        }

        [Test]
        public void TryLocate_ZeroIntrinsics_ReturnsFalse()
        {
            var d = MakeDetection();
            d.intrinsics = default;

            Assert.IsFalse(locator.TryLocate(d, out _));
        }
    }
}
