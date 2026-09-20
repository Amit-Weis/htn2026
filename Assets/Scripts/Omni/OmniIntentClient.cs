using System;
using System.Collections;
using Newtonsoft.Json.Linq;
using UnityEngine.Networking;

namespace Omni
{
    /// <summary>The Worker's answer to "did the wearer ask to be pointed to something?" (POST /api/intent).</summary>
    public sealed class IntentReply
    {
        public string Heard = "";
        /// <summary>a target id such as "hacker_card" when the wearer asked to be pointed to it, otherwise null</summary>
        public string Wants;
        public string Say = "";
        /// <summary>"omni", or "keywords" when OMNI could not answer and the typed words decided</summary>
        public string Source = "";
        public string Note = "";
    }

    /// <summary>
    /// One call to the Worker's stateless /api/intent: OMNI hears the wearer (WAV audio, or typed text) and says whether they asked
    /// for a known object by name ("where is my hacker badge"). The object's position is not involved: the on-device detector
    /// already has it.
    /// </summary>
    public static class OmniIntentClient
    {
        /// <summary>Calls <paramref name="done"/> with the reply, or with null and the reason.</summary>
        public static IEnumerator Ask(OmniConfig config, string text, byte[] wav, Action<IntentReply, string> done)
        {
            var body = new JObject();
            if (!string.IsNullOrEmpty(text)) body["text"] = text;
            if (wav != null && wav.Length > 0)
            {
                body["audioB64"] = Convert.ToBase64String(wav);
                body["mime"] = "audio/wav";
            }

            using (var req = new UnityWebRequest(config.WorkerUrl + "/api/intent", "POST"))
            {
                req.uploadHandler = new UploadHandlerRaw(System.Text.Encoding.UTF8.GetBytes(body.ToString(Newtonsoft.Json.Formatting.None)));
                req.downloadHandler = new DownloadHandlerBuffer();
                req.SetRequestHeader("Content-Type", "application/json");
                req.SetRequestHeader("Authorization", "Bearer " + config.Token);
                req.timeout = 25;
                yield return req.SendWebRequest();

                string reply = req.downloadHandler != null ? req.downloadHandler.text : "";
                if (req.result != UnityWebRequest.Result.Success)
                {
                    done(null, Describe(req, reply));
                    yield break;
                }
                IntentReply parsed = Parse(reply);
                if (parsed == null) done(null, "the Worker's reply was not understood: " + Trim(reply));
                else done(parsed, null);
            }
        }

        /// <summary>Tolerant of missing and null fields; null when the text is not a JSON object.</summary>
        public static IntentReply Parse(string json)
        {
            try
            {
                JObject o = JObject.Parse(json);
                return new IntentReply
                {
                    Heard = (string)o["heard"] ?? "",
                    Wants = string.IsNullOrEmpty((string)o["wants"]) ? null : (string)o["wants"],
                    Say = (string)o["say"] ?? "",
                    Source = (string)o["source"] ?? "",
                    Note = (string)o["note"] ?? "",
                };
            }
            catch (Exception)
            {
                return null;
            }
        }

        static string Describe(UnityWebRequest req, string body)
        {
            if (req.responseCode == 401) return "the Worker rejected the token (check token in lastseen.json)";
            if (req.responseCode > 0) return "HTTP " + req.responseCode + ": " + Trim(body);
            return "no connection (" + req.error + ")";
        }

        static string Trim(string s)
        {
            return string.IsNullOrEmpty(s) ? "" : (s.Length > 160 ? s.Substring(0, 160) + "..." : s);
        }
    }
}
