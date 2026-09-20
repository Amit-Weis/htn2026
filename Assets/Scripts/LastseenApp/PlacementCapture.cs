using System;
using System.Collections;
using System.Collections.Generic;
using System.IO;
using Forgetmenot;
using Lastseen;
using UnityEngine;

namespace LastseenApp
{
    /// <summary>
    /// One placement, end to end: take the dual-camera photo (left | right side by side), re-detect on its left half so the boxes
    /// match the image the stereo depth is measured on, and POST it to /api/ingest with the pose slice around the moment it was
    /// taken. The Worker chooses which box is the placed object (OMNI), measures depth at that box, and logs the object.
    /// </summary>
    public sealed class PlacementCapture : MonoBehaviour
    {
        public WorkerClient client;
        public DeadReckoningTracker pose;
        public LastseenConfig config = new LastseenConfig();

        public bool Busy { get; private set; }
        public string LastStatus { get; private set; } = "";
        public event Action<string> Status;
        public event Action<IngestReply> Logged;

        [Min(1f)] public float captureTimeoutSeconds = 20f;

#if UNITY_ANDROID && !UNITY_EDITOR
        DualCameraCapture capture;
#endif
        AndroidMediaPipeDetector detector;
        string trigger = "detector";
        long requestedAtMs;
        Coroutine watchdog;

        void Say(string s)
        {
            LastStatus = s;
            var h = Status;
            if (h != null) h(s);
        }

        void OnDestroy()
        {
            if (detector != null) detector.Dispose();
        }

        /// <param name="triggerKind">"detector" (the stability tracker fired), "manual" (a button) or "voice"</param>
        public void Begin(string triggerKind)
        {
            if (Busy) return;
            trigger = triggerKind;
            requestedAtMs = DeadReckoningTracker.NowMs();
            Busy = true;
            Say("taking photo...");
#if UNITY_ANDROID && !UNITY_EDITOR
            if (capture == null) capture = FindFirstObjectByType<DualCameraCapture>();
            if (capture == null)
            {
                Fail("dual camera component not found");
                return;
            }
            capture.Captured -= OnCaptured;
            capture.Captured += OnCaptured;
            capture.TakePhoto();
            watchdog = StartCoroutine(Watchdog());
#else
            Fail("the dual camera only works in the Android player");
#endif
        }

        IEnumerator Watchdog()
        {
            yield return new WaitForSeconds(captureTimeoutSeconds);
            if (Busy) Fail("the dual photo did not arrive (see the DualCam status on the device)");
        }

        void Fail(string why)
        {
            Busy = false;
            if (watchdog != null) StopCoroutine(watchdog);
            watchdog = null;
            Say(why);
        }

        void OnCaptured(string path)
        {
            if (!Busy) return;
            if (watchdog != null) StopCoroutine(watchdog);
            watchdog = null;
            StartCoroutine(Process(path));
        }

        static string Resolve(string path)
        {
            return Path.IsPathRooted(path) ? path : "/storage/emulated/0/" + path;
        }

        IEnumerator Process(string path)
        {
            byte[] stereoJpeg;
            try { stereoJpeg = File.ReadAllBytes(Resolve(path)); }
            catch (Exception e)
            {
                Fail("could not read " + path + ": " + e.Message);
                yield break;
            }
            yield return null; // let a frame render between the heavy steps

            FrameData leftFrame;
            List<Lastseen.Detection> detections;
            string error;
            if (!SplitLeft(stereoJpeg, out leftFrame, out detections, out error))
            {
                Fail(error);
                yield break;
            }
            yield return null;

            var slice = pose != null ? pose.Ring.Slice(requestedAtMs - 2000, DeadReckoningTracker.NowMs(), 100) : new List<PoseSample>();
            var stereo = new StereoData { Jpeg = stereoJpeg, BaselineM = config.BaselineM, Swap = config.StereoSwap };
            string json;
            try
            {
                json = Payloads.BuildIngest(requestedAtMs, trigger, new List<FrameData> { leftFrame },
                    new List<IList<Lastseen.Detection>> { detections }, null, stereo, slice, config.HfovDeg);
            }
            catch (Exception e)
            {
                Fail("could not build the request: " + e.Message);
                yield break;
            }

            Say(string.Format("sending {0} KB, {1} objects seen...", json.Length / 1024, detections.Count));
            IngestReply reply = null;
            string failure = null;
            yield return client.PostIngest(json, true, (r, err) => { reply = r; failure = err; });
            Busy = false;
            if (reply == null)
            {
                Say("not logged: " + failure);
                yield break;
            }
            Say(Describe(reply));
            var h = Logged;
            if (h != null) h(reply);
        }

        static string Describe(IngestReply r)
        {
            if (!r.Accepted) return "not logged (" + r.Reason + (string.IsNullOrEmpty(r.Detail) ? "" : ": " + r.Detail) + ")";
            if (r.Objects.Count == 0) return "sent, still processing (" + r.Status + ")";
            var o = r.Objects[0];
            string where = o.X.HasValue && o.Y.HasValue ? string.Format(" at {0:0.0}, {1:0.0} m", o.X.Value, o.Y.Value) : "";
            string height = o.HeightM.HasValue ? string.Format(", {0:+0.0;-0.0} m vs camera", o.HeightM.Value) : "";
            return string.Format("logged {0}{1}{2} [{3}]", o.Label, where, height, o.PosSource);
        }

        /// <summary>
        /// Decode the side-by-side JPEG, cut out the left half as its own JPEG (the image OMNI looks at) and run the detector on it.
        /// Texture rows are bottom-up in Unity, MediaPipe wants top-down, so the detector copy is flipped.
        /// </summary>
        bool SplitLeft(byte[] stereoJpeg, out FrameData left, out List<Lastseen.Detection> detections, out string error)
        {
            left = null;
            detections = new List<Lastseen.Detection>();
            error = null;
            var tex = new Texture2D(2, 2, TextureFormat.RGBA32, false);
            try
            {
                if (!tex.LoadImage(stereoJpeg, false) || tex.width < 32 || tex.width % 2 != 0)
                {
                    error = "the dual photo is not a usable side-by-side JPEG (" + tex.width + "x" + tex.height + ")";
                    return false;
                }
                int w2 = tex.width, w = w2 / 2, h = tex.height;
                var raw = tex.GetRawTextureData<byte>();
                var leftBottomUp = new byte[w * h * 4];
                var leftTopDown = new byte[w * h * 4];
                for (int ty = 0; ty < h; ty++)
                {
                    Unity.Collections.NativeArray<byte>.Copy(raw, ty * w2 * 4, leftBottomUp, ty * w * 4, w * 4);
                    Array.Copy(leftBottomUp, ty * w * 4, leftTopDown, (h - 1 - ty) * w * 4, w * 4);
                }

                var leftTex = new Texture2D(w, h, TextureFormat.RGBA32, false);
                try
                {
                    leftTex.SetPixelData(leftBottomUp, 0);
                    leftTex.Apply(false);
                    left = new FrameData { TMs = requestedAtMs, W = w, H = h, Hash = ImageHash.AHash(leftTopDown, w, h), Jpeg = leftTex.EncodeToJPG(85) };
                }
                finally
                {
                    Destroy(leftTex);
                }

                if (detector == null) detector = new AndroidMediaPipeDetector(0.3f);
                detections = LiveDetector.ToDetections(detector.Detect(leftTopDown, w, h, ""));
                return true;
            }
            catch (Exception e)
            {
                error = "could not process the photo: " + e.Message;
                return false;
            }
            finally
            {
                Destroy(tex);
            }
        }
    }
}
