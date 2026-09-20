using System;
using System.Collections;
using System.IO;
using UnityEngine;
using UnityEngine.Networking;
using UnityEngine.XR.ARSubsystems;

namespace Depth
{
    // Photo -> Cloudflare (target pixel + stereo depth) -> 3D position via DepthLocator.
    // The position is expressed in the frame that WorldFromCamera places the camera in:
    // identity (the default) gives camera space; set it to the marker-from-camera pose to get
    // room/marker space.
    public class TargetLocator : MonoBehaviour
    {
        [Tooltip("Cloudflare Worker URL. The JPEG is POSTed as the body with ?label=<targetLabel>. Empty = use the mock response.")]
        public string endpointUrl;
        public string targetLabel = "target";
        public int timeoutSeconds = 20;

        [TextArea(4, 10)]
        public string mockResponseJson =
            "{\"found\":true,\"label\":\"target\",\"confidence\":0.9,\"u\":420,\"v\":140,\"depth_m\":2.0," +
            "\"width\":640,\"height\":480,\"fx\":500,\"fy\":400,\"cx\":320,\"cy\":240,\"timestamp_ns\":0}";

        public Pose WorldFromCamera { get; set; } = Pose.identity;

        public event Action<ObjectPose3D> TargetLocated;
        public event Action<string> Failed;

        DepthLocator locator;

        DepthLocator Locator
        {
            get
            {
                if (locator == null)
                {
                    locator = GetComponent<DepthLocator>();
                    if (locator == null) locator = gameObject.AddComponent<DepthLocator>();
                }
                return locator;
            }
        }

        // path is what DualCamCapture reports, e.g. "Pictures/DualCam/dualcam_123.jpg".
        public void LocateFromFile(string path)
        {
            StartCoroutine(LocateRoutine(path));
        }

        public bool TryLocateFromJson(string json, out ObjectPose3D pose, out string error)
        {
            pose = default;
            error = null;

            LocateResponse r;
            try
            {
                r = JsonUtility.FromJson<LocateResponse>(json);
            }
            catch (Exception e)
            {
                error = "bad response JSON: " + e.Message;
                return false;
            }

            if (r == null || !r.found)
            {
                error = r == null || string.IsNullOrEmpty(r.error) ? "target not found" : r.error;
                return false;
            }

            var d = new Detection2D
            {
                label = string.IsNullOrEmpty(r.label) ? targetLabel : r.label,
                confidence = r.confidence,
                pixel = new Vector2(r.u, r.v),
                imageSize = new Vector2Int(r.width, r.height),
                timestampNs = r.timestamp_ns,
                worldFromCamera = WorldFromCamera,
                intrinsics = new XRCameraIntrinsics(
                    new Vector2(r.fx, r.fy),
                    new Vector2(r.cx, r.cy),
                    new Vector2Int(r.width, r.height)),
            };

            Locator.DepthSource = new FixedDepthSource(r.depth_m);
            if (!Locator.TryLocate(d, out pose))
            {
                error = "invalid depth or intrinsics in response";
                return false;
            }
            return true;
        }

        IEnumerator LocateRoutine(string path)
        {
            string json;

            if (string.IsNullOrEmpty(endpointUrl))
            {
                json = mockResponseJson;
            }
            else
            {
                byte[] jpeg;
                try
                {
                    jpeg = File.ReadAllBytes(ResolvePath(path));
                }
                catch (Exception e)
                {
                    Failed?.Invoke("could not read " + path + ": " + e.Message);
                    yield break;
                }

                string url = endpointUrl + "?label=" + UnityWebRequest.EscapeURL(targetLabel);
                using (var req = new UnityWebRequest(url, UnityWebRequest.kHttpVerbPOST))
                {
                    req.uploadHandler = new UploadHandlerRaw(jpeg);
                    req.downloadHandler = new DownloadHandlerBuffer();
                    req.SetRequestHeader("Content-Type", "image/jpeg");
                    req.timeout = timeoutSeconds;
                    yield return req.SendWebRequest();

                    if (req.result != UnityWebRequest.Result.Success)
                    {
                        Failed?.Invoke("request failed: " + req.error);
                        yield break;
                    }
                    json = req.downloadHandler.text;
                }
            }

            if (TryLocateFromJson(json, out var pose, out var error))
                TargetLocated?.Invoke(pose);
            else
                Failed?.Invoke(error);
        }

        static string ResolvePath(string path)
        {
            return Path.IsPathRooted(path) ? path : "/storage/emulated/0/" + path;
        }
    }
}
