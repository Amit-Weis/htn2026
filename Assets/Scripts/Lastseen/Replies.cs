using System;
using System.Collections.Generic;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;

namespace Lastseen
{
    /// <summary>The HUD target the agent set (Worker TargetSchema). Position is in the session frame (x east, y north, meters).</summary>
    public sealed class TargetInfo
    {
        public string ObjectId;
        public string Label;
        public double X, Y;
        /// <summary>height relative to the camera at placement, meters, positive up; null unless it was measured with stereo depth</summary>
        public double? HeightM;
        public double BearingDeg;
        public string Zone;
        public double AgeSec;
        public double Confidence;
        /// <summary>"arrow" when the position is trusted, "zone" for a coarse "somewhere near the desk"</summary>
        public string Mode;
        public long SetAtMs;
    }

    public sealed class ObjectInfo
    {
        public string Id;
        public string Label;
        public string Description;
        public string Zone;
        public string Status;
        public double? X, Y, HeightM;
        public string PosSource;
        public double Confidence;
    }

    public sealed class IngestReply
    {
        public bool Accepted;
        public string CandidateId;
        /// <summary>why a candidate was dropped: no_image, walking, duplicate, cooldown, rate_limit</summary>
        public string Reason;
        public string Detail;
        public string Status;
        public List<ObjectInfo> Objects = new List<ObjectInfo>();
    }

    public sealed class QueryReply
    {
        public string TurnId;
        /// <summary>false when the agent ignored the audio (ambient chatter) or the turn was cancelled</summary>
        public bool Addressed;
        public string Text;
        /// <summary>WAV bytes of the spoken answer, or null (the Worker falls back to text only)</summary>
        public byte[] Audio;
        public string Mime;
        public TargetInfo Target;
    }

    /// <summary>Parsers for the Worker's HTTP replies. Tolerant of missing or null fields; never throws.</summary>
    public static class Replies
    {
        static string Str(JToken t, string key)
        {
            var v = t == null ? null : t[key];
            return v == null || v.Type == JTokenType.Null ? null : v.ToString();
        }

        static double? Dbl(JToken t, string key)
        {
            var v = t == null ? null : t[key];
            if (v == null || (v.Type != JTokenType.Float && v.Type != JTokenType.Integer)) return null;
            return v.Value<double>();
        }

        static bool Bool(JToken t, string key)
        {
            var v = t == null ? null : t[key];
            return v != null && v.Type == JTokenType.Boolean && v.Value<bool>();
        }

        /// <summary>The Worker's error bodies are {"error": "..."}; anything else is returned trimmed.</summary>
        public static string ErrorOf(string body, long httpStatus)
        {
            try
            {
                var o = JObject.Parse(body ?? "");
                string e = Str(o, "error");
                if (!string.IsNullOrEmpty(e)) return e;
            }
            catch (JsonException) { }
            string trimmed = (body ?? "").Trim();
            if (trimmed.Length > 200) trimmed = trimmed.Substring(0, 200);
            return trimmed.Length > 0 ? trimmed : "HTTP " + httpStatus;
        }

        public static TargetInfo ParseTarget(JToken t)
        {
            if (t == null || t.Type != JTokenType.Object) return null;
            double? x = Dbl(t, "x"), y = Dbl(t, "y");
            if (!x.HasValue || !y.HasValue) return null;
            return new TargetInfo
            {
                ObjectId = Str(t, "objectId"),
                Label = Str(t, "label"),
                X = x.Value,
                Y = y.Value,
                HeightM = Dbl(t, "heightM"),
                BearingDeg = Dbl(t, "bearingDeg") ?? 0,
                Zone = Str(t, "zone"),
                AgeSec = Dbl(t, "ageSec") ?? 0,
                Confidence = Dbl(t, "confidence") ?? 0,
                Mode = Str(t, "mode") ?? "arrow",
                SetAtMs = (long)(Dbl(t, "setAt") ?? 0),
            };
        }

        public static ObjectInfo ParseObject(JToken t)
        {
            return new ObjectInfo
            {
                Id = Str(t, "id"),
                Label = Str(t, "label"),
                Description = Str(t, "description"),
                Zone = Str(t, "zone"),
                Status = Str(t, "status"),
                X = Dbl(t, "x"),
                Y = Dbl(t, "y"),
                HeightM = Dbl(t, "heightM"),
                PosSource = Str(t, "posSource"),
                Confidence = Dbl(t, "confidence") ?? 0,
            };
        }

        public static bool TryParseIngest(string json, out IngestReply reply, out string error)
        {
            reply = null;
            error = null;
            try
            {
                var o = JObject.Parse(json ?? "");
                if (o["accepted"] == null)
                {
                    error = Str(o, "error") ?? "unexpected reply";
                    return false;
                }
                reply = new IngestReply
                {
                    Accepted = Bool(o, "accepted"),
                    CandidateId = Str(o, "candidateId"),
                    Reason = Str(o, "reason"),
                    Detail = Str(o, "detail"),
                    Status = Str(o, "status"),
                };
                var arr = o["objects"] as JArray;
                if (arr != null) foreach (var item in arr) reply.Objects.Add(ParseObject(item));
                return true;
            }
            catch (JsonException e)
            {
                error = "bad reply: " + e.Message;
                return false;
            }
        }

        public static bool TryParseQuery(string json, out QueryReply reply, out string error)
        {
            reply = null;
            error = null;
            try
            {
                var o = JObject.Parse(json ?? "");
                if (o["addressed"] == null)
                {
                    error = Str(o, "error") ?? "unexpected reply";
                    return false;
                }
                reply = new QueryReply
                {
                    TurnId = Str(o, "turnId"),
                    Addressed = Bool(o, "addressed"),
                    Text = Str(o, "text") ?? "",
                    Mime = Str(o, "mime"),
                    Target = ParseTarget(o["target"]),
                };
                string b64 = Str(o, "audioB64");
                if (!string.IsNullOrEmpty(b64))
                {
                    try { reply.Audio = Convert.FromBase64String(b64); }
                    catch (FormatException) { reply.Audio = null; }
                }
                return true;
            }
            catch (JsonException e)
            {
                error = "bad reply: " + e.Message;
                return false;
            }
        }
    }
}
