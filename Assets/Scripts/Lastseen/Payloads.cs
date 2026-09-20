using System;
using System.Collections.Generic;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;

namespace Lastseen
{
    /// <summary>One camera frame as the Worker's FrameSchema wants it.</summary>
    public sealed class FrameData
    {
        public long TMs;
        public int W, H;
        /// <summary>perceptual hash (see ImageHash); the Worker drops a candidate whose last frame hashes within 4 bits of a recent one</summary>
        public string Hash;
        public byte[] Jpeg;
    }

    public sealed class StereoData
    {
        /// <summary>ONE jpeg: left camera on the left half, right camera on the right half</summary>
        public byte[] Jpeg;
        /// <summary>null = use the Worker's STEREO_BASELINE_M</summary>
        public double? BaselineM;
        /// <summary>true when the first half is really the right camera</summary>
        public bool? Swap;
    }

    /// <summary>
    /// Builds the JSON bodies for POST /api/ingest and POST /api/query (contract v2, see lastseen/packages/shared/src/schemas.ts).
    /// Written with JObject rather than JsonUtility because the Worker validates strictly: an optional field must be absent, not
    /// an empty string or a zero (a 0 baseline is a 400).
    /// </summary>
    public static class Payloads
    {
        static double Num(double v)
        {
            return double.IsNaN(v) || double.IsInfinity(v) ? 0 : Math.Round(v, 4);
        }

        static double Clamp(double v, double lo, double hi)
        {
            return Math.Min(hi, Math.Max(lo, v));
        }

        public static JObject PoseJson(PoseSample s)
        {
            return new JObject
            {
                ["t"] = s.TMs,
                ["x"] = Num(s.X),
                ["y"] = Num(s.Y),
                ["headingDeg"] = Num(Geo.Wrap360(s.HeadingDeg)),
                ["steps"] = Math.Max(0, s.Steps),
                ["confidence"] = Num(Clamp(s.Confidence, 0, 1)),
                ["stationary"] = s.Stationary,
            };
        }

        public static JObject FrameJson(FrameData f)
        {
            var o = new JObject { ["t"] = f.TMs, ["w"] = Math.Max(0, f.W), ["h"] = Math.Max(0, f.H) };
            if (!string.IsNullOrEmpty(f.Hash)) o["hash"] = f.Hash;
            if (f.Jpeg != null && f.Jpeg.Length > 0) o["jpegBase64"] = Convert.ToBase64String(f.Jpeg);
            return o;
        }

        static JObject DetectionJson(Detection d)
        {
            return new JObject
            {
                ["label"] = d.Label ?? "",
                ["score"] = Num(Clamp(d.Score, 0, 1)),
                ["bbox"] = new JArray(Num(d.Box.X), Num(d.Box.Y), Num(d.Box.W), Num(d.Box.H)),
            };
        }

        /// <param name="detections">one list per frame, aligned index for index with frames; null to send none</param>
        /// <param name="poseSlice">at most 600 samples; older than the frames is fine</param>
        public static string BuildIngest(long tMs, string trigger, IList<FrameData> frames, IList<IList<Detection>> detections,
            FrameData still, StereoData stereo, IList<PoseSample> poseSlice, double hfovDeg)
        {
            if (frames == null || frames.Count == 0) throw new ArgumentException("a candidate needs at least one frame", "frames");
            if (frames.Count > 8) throw new ArgumentException("at most 8 frames", "frames");
            if (detections != null && detections.Count != frames.Count) throw new ArgumentException("detections must align with frames", "detections");

            var o = new JObject { ["t"] = tMs, ["trigger"] = trigger };
            var fa = new JArray();
            foreach (var f in frames) fa.Add(FrameJson(f));
            o["frames"] = fa;
            if (still != null) o["stillFrame"] = FrameJson(still);
            if (detections != null)
            {
                var da = new JArray();
                foreach (var list in detections)
                {
                    var one = new JArray();
                    if (list != null) foreach (var d in list) one.Add(DetectionJson(d));
                    da.Add(one);
                }
                o["detections"] = da;
            }
            if (stereo != null && stereo.Jpeg != null && stereo.Jpeg.Length > 0)
            {
                var s = new JObject { ["jpegBase64"] = Convert.ToBase64String(stereo.Jpeg) };
                if (stereo.BaselineM.HasValue && stereo.BaselineM.Value > 0 && stereo.BaselineM.Value <= 1) s["baselineM"] = Num(stereo.BaselineM.Value);
                if (stereo.Swap.HasValue) s["swap"] = stereo.Swap.Value;
                o["stereo"] = s;
            }
            var pa = new JArray();
            if (poseSlice != null)
            {
                int skip = Math.Max(0, poseSlice.Count - 600);
                for (int i = skip; i < poseSlice.Count; i++) pa.Add(PoseJson(poseSlice[i]));
            }
            o["poseSlice"] = pa;
            o["hfovDeg"] = Num(Clamp(hfovDeg, 10, 180));
            return o.ToString(Formatting.None);
        }

        /// <summary>A typed or spoken question. Send text or audio (WAV); pose and frame are optional but let the agent verify what it sees.</summary>
        public static string BuildQuery(string turnId, string text, byte[] audio, string mime, PoseSample? pose, FrameData frame)
        {
            bool hasText = !string.IsNullOrEmpty(text);
            bool hasAudio = audio != null && audio.Length > 0;
            if (!hasText && !hasAudio) throw new ArgumentException("send text or audio");
            var o = new JObject();
            if (!string.IsNullOrEmpty(turnId)) o["turnId"] = turnId;
            if (hasText) o["text"] = text;
            if (hasAudio)
            {
                o["audioB64"] = Convert.ToBase64String(audio);
                o["mime"] = string.IsNullOrEmpty(mime) ? "audio/wav" : mime;
            }
            if (frame != null) o["frame"] = FrameJson(frame);
            if (pose.HasValue) o["poseAtT"] = PoseJson(pose.Value);
            return o.ToString(Formatting.None);
        }
    }
}
