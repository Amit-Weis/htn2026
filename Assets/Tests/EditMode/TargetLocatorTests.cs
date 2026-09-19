using NUnit.Framework;
using UnityEngine;

namespace Depth.Tests
{
    public class TargetLocatorTests
    {
        const string Found =
            "{\"found\":true,\"label\":\"cup\",\"confidence\":0.9,\"u\":420,\"v\":140,\"depth_m\":2.0," +
            "\"width\":640,\"height\":480,\"fx\":500,\"fy\":400,\"cx\":320,\"cy\":240,\"timestamp_ns\":123}";

        GameObject go;
        TargetLocator locator;

        [SetUp]
        public void SetUp()
        {
            go = new GameObject();
            locator = go.AddComponent<TargetLocator>();
        }

        [TearDown]
        public void TearDown()
        {
            Object.DestroyImmediate(go);
        }

        [Test]
        public void TryLocateFromJson_IdentityFrame_ReturnsCameraSpacePoint()
        {
            Assert.IsTrue(locator.TryLocateFromJson(Found, out var pose, out var error), error);

            // same numbers as DepthLocatorTests: x = (420-320)/500*2, y = -(140-240)/400*2, z = 2
            Assert.AreEqual(0.4f, pose.worldPos.x, 1e-4f);
            Assert.AreEqual(0.5f, pose.worldPos.y, 1e-4f);
            Assert.AreEqual(2f, pose.worldPos.z, 1e-4f);
            Assert.AreEqual("cup", pose.label);
            Assert.AreEqual(123L, pose.timestampNs);
        }

        [Test]
        public void TryLocateFromJson_WithFramePose_AppliesIt()
        {
            locator.WorldFromCamera = new Pose(new Vector3(10f, 20f, 30f), Quaternion.Euler(0f, 90f, 0f));

            Assert.IsTrue(locator.TryLocateFromJson(Found, out var pose, out var error), error);

            Assert.AreEqual(12f, pose.worldPos.x, 1e-4f);
            Assert.AreEqual(20.5f, pose.worldPos.y, 1e-4f);
            Assert.AreEqual(29.6f, pose.worldPos.z, 1e-4f);
        }

        [Test]
        public void TryLocateFromJson_NotFound_ReturnsFalse()
        {
            Assert.IsFalse(locator.TryLocateFromJson("{\"found\":false}", out _, out var error));
            Assert.AreEqual("target not found", error);
        }

        [Test]
        public void TryLocateFromJson_NotFoundWithServerError_SurfacesIt()
        {
            Assert.IsFalse(locator.TryLocateFromJson("{\"found\":false,\"error\":\"no cup in the photo\"}", out _, out var error));
            Assert.AreEqual("no cup in the photo", error);
        }

        [Test]
        public void TryLocateFromJson_ZeroDepth_ReturnsFalse()
        {
            string json = Found.Replace("\"depth_m\":2.0", "\"depth_m\":0");

            Assert.IsFalse(locator.TryLocateFromJson(json, out _, out _));
        }

        [Test]
        public void TryLocateFromJson_GarbageJson_ReturnsFalse()
        {
            Assert.IsFalse(locator.TryLocateFromJson("not json", out _, out var error));
            StringAssert.Contains("bad response JSON", error);
        }
    }
}
