using Newtonsoft.Json.Linq;
using UnityEngine;

namespace Omni
{
    /// <summary>
    /// Where the Worker is and the device token, read from Assets/Resources/lastseen.json (git-ignored; copy lastseen.example.json).
    /// A token baked into an APK is fine for a personal debug build, not for distribution.
    /// </summary>
    public sealed class OmniConfig
    {
        public string WorkerUrl = "";
        public string Token = "";

        /// <summary>The config, or null with the reason in <paramref name="problem"/>.</summary>
        public static OmniConfig Load(out string problem)
        {
            problem = null;
            TextAsset asset = Resources.Load<TextAsset>("lastseen");
            if (asset == null)
            {
                problem = "Assets/Resources/lastseen.json is missing (copy lastseen.example.json and fill in workerUrl and token)";
                return null;
            }
            JObject o;
            try { o = JObject.Parse(asset.text); }
            catch (Newtonsoft.Json.JsonException e)
            {
                problem = "lastseen.json is not valid JSON: " + e.Message;
                return null;
            }
            var c = new OmniConfig { WorkerUrl = ((string)o["workerUrl"] ?? "").Trim().TrimEnd('/'), Token = ((string)o["token"] ?? "").Trim() };
            if (!(c.WorkerUrl.StartsWith("https://") || c.WorkerUrl.StartsWith("http://"))) problem = "workerUrl in lastseen.json must start with https://";
            else if (c.Token.Length == 0) problem = "token in lastseen.json is empty";
            return problem == null ? c : null;
        }
    }
}
