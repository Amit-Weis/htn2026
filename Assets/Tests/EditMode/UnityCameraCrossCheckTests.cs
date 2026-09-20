using NUnit.Framework;
using UnityEngine;
using UnityEngine.XR.ARSubsystems;

namespace Depth.Tests
{
    // Independent oracle: project known world points with a real Unity Camera, feed the
    // resulting pixel and depth through DepthLocator, and expect the original world point back.
    public class UnityCameraCrossCheckTests
    {
        const int W = 1280, H = 720;
        const float Fy = 800f;
        const float Tol = 1e-3f;

        class UnityDepthSource : IDepthSource
        {
            public float z;

            public bool TryGetDepth(in Detection2D detection, out float depth, out float confidence)
            {
                depth = z;
                confidence = 1f;
                return true;
            }
        }

        GameObject camGo;
        GameObject locatorGo;
        Camera cam;
        DepthLocator locator;
        UnityDepthSource source;

        [SetUp]
        public void SetUp()
        {
            camGo = new GameObject();
            cam = camGo.AddComponent<Camera>();
            cam.aspect = (float)W / H;
            cam.fieldOfView = 2f * Mathf.Atan(H / (2f * Fy)) * Mathf.Rad2Deg;
            cam.nearClipPlane = 0.01f;
            cam.farClipPlane = 100f;
            camGo.transform.SetPositionAndRotation(new Vector3(1f, 1.5f, -2f), Quaternion.Euler(10f, 35f, -5f));

            locatorGo = new GameObject();
            locator = locatorGo.AddComponent<DepthLocator>();
            source = new UnityDepthSource();
            locator.DepthSource = source;
        }

        [TearDown]
        public void TearDown()
        {
            Object.DestroyImmediate(camGo);
            Object.DestroyImmediate(locatorGo);
        }

        static readonly Vector3[] CameraLocalPoints =
        {
            new Vector3(0f, 0f, 2f),
            new Vector3(0.5f, -0.3f, 3f),
            new Vector3(-1f, 0.6f, 4f),
            new Vector3(0.9f, 0.5f, 2.5f),
            new Vector3(-0.8f, -0.4f, 1.5f),
        };

        [TestCaseSource(nameof(CameraLocalPoints))]
        public void UnityProjectedPoint_RoundTripsToOriginalWorldPoint(Vector3 cameraLocal)
        {
            Vector3 world = camGo.transform.TransformPoint(cameraLocal);

            // Viewport: origin bottom-left, x/y in 0..1, z = distance along the camera forward axis.
            Vector3 vp = cam.WorldToViewportPoint(world);
            Assert.AreEqual(cameraLocal.z, vp.z, Tol, "viewport z should be optical-axis depth");

            var detection = new Detection2D
            {
                label = "probe",
                confidence = 1f,
                pixel = new Vector2(vp.x * W, (1f - vp.y) * H),
                imageSize = new Vector2Int(W, H),
                timestampNs = 1L,
                worldFromCamera = new Pose(camGo.transform.position, camGo.transform.rotation),
                intrinsics = new XRCameraIntrinsics(new Vector2(Fy, Fy), new Vector2(W / 2f, H / 2f), new Vector2Int(W, H)),
            };
            source.z = vp.z;

            Assert.IsTrue(locator.TryLocate(detection, out var result));
            Assert.AreEqual(world.x, result.worldPos.x, Tol);
            Assert.AreEqual(world.y, result.worldPos.y, Tol);
            Assert.AreEqual(world.z, result.worldPos.z, Tol);
        }
    }
}
