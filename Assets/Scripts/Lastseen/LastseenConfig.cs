using System;
using Newtonsoft.Json.Linq;

namespace Lastseen
{
    /// <summary>
    /// Where the Worker is and who we are. Loaded from Assets/Resources/lastseen.json (git-ignored; copy lastseen.example.json),
    /// so no token lives in source. A token baked into an APK is fine for a personal debug build, not for distribution.
    /// </summary>
    public sealed class LastseenConfig
    {
        /// <summary>Worker origin, e.g. https://lastseen.example.workers.dev</summary>
        public string WorkerUrl = "";
        public string Token = "";
        /// <summary>one TrackerAgent (one memory) per device id</summary>
        public string DeviceId = "default";
        /// <summary>horizontal FOV of ONE camera image; the Worker default is 70. Measure it (docs/probe-results.md section 3).</summary>
        public double HfovDeg = 65;
        /// <summary>null = the Worker's STEREO_BASELINE_M</summary>
        public double? BaselineM;
        public bool? StereoSwap;
        public double HoldSeconds = 3.5;
        public double StepLengthM = 0.7;

        public static LastseenConfig Parse(string json)
        {
            var c = new LastseenConfig();
            if (string.IsNullOrWhiteSpace(json)) return c;
            JObject o;
            try { o = JObject.Parse(json); }
            catch (Newtonsoft.Json.JsonException) { return c; }
            c.WorkerUrl = (string)o["workerUrl"] ?? c.WorkerUrl;
            c.Token = (string)o["token"] ?? c.Token;
            c.DeviceId = (string)o["deviceId"] ?? c.DeviceId;
            if (o["hfovDeg"] != null) c.HfovDeg = (double)o["hfovDeg"];
            if (o["baselineM"] != null && o["baselineM"].Type != JTokenType.Null) c.BaselineM = (double)o["baselineM"];
            if (o["stereoSwap"] != null && o["stereoSwap"].Type != JTokenType.Null) c.StereoSwap = (bool)o["stereoSwap"];
            if (o["holdSeconds"] != null) c.HoldSeconds = (double)o["holdSeconds"];
            if (o["stepLengthM"] != null) c.StepLengthM = (double)o["stepLengthM"];
            return c;
        }

        /// <summary>Null when usable, otherwise what is wrong.</summary>
        public string Problem()
        {
            if (string.IsNullOrEmpty(WorkerUrl)) return "workerUrl is not set (Assets/Resources/lastseen.json)";
            if (!(WorkerUrl.StartsWith("https://") || WorkerUrl.StartsWith("http://"))) return "workerUrl must start with https:// (or http:// for a LAN dev server)";
            if (string.IsNullOrEmpty(Token)) return "token is not set";
            if (string.IsNullOrEmpty(DeviceId)) return "deviceId is empty";
            return null;
        }

        /// <summary>Full URL for an API path such as "/api/query", with the device id appended.</summary>
        public string Url(string path)
        {
            return WorkerUrl.TrimEnd('/') + path + (path.Contains("?") ? "&" : "?") + "device=" + Uri.EscapeDataString(DeviceId);
        }
    }
}
