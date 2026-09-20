using System;
using System.Collections;
using System.Text;
using Lastseen;
using UnityEngine;
using UnityEngine.Networking;

namespace LastseenApp
{
    /// <summary>
    /// HTTP client for the Lastseen Worker: POST /api/ingest (a placement), POST /api/query (a question), GET /api/memory (debug).
    /// Bodies come from Lastseen.Payloads, replies go through Lastseen.Replies; this class only moves bytes and reports failures
    /// as strings (never throws into a coroutine).
    /// </summary>
    public sealed class WorkerClient : MonoBehaviour
    {
        public LastseenConfig Config = new LastseenConfig();
        public int timeoutSeconds = 40;

        IEnumerator Send(string method, string path, string body, Action<long, string, string> done)
        {
            string problem = Config.Problem();
            if (problem != null)
            {
                done(0, null, problem);
                yield break;
            }
            using (var req = new UnityWebRequest(Config.Url(path), method))
            {
                if (body != null)
                {
                    req.uploadHandler = new UploadHandlerRaw(Encoding.UTF8.GetBytes(body));
                    req.SetRequestHeader("Content-Type", "application/json");
                }
                req.downloadHandler = new DownloadHandlerBuffer();
                req.SetRequestHeader("Authorization", "Bearer " + Config.Token);
                req.timeout = timeoutSeconds;
                yield return req.SendWebRequest();

                string text = req.downloadHandler != null ? req.downloadHandler.text : null;
                if (req.result == UnityWebRequest.Result.ConnectionError)
                {
                    done(0, null, "no connection: " + req.error);
                    yield break;
                }
                done(req.responseCode, text, null);
            }
        }

        /// <summary>waitForResult holds the request open until the Worker has reconciled the placement (up to ~25 s).</summary>
        public IEnumerator PostIngest(string json, bool waitForResult, Action<IngestReply, string> done)
        {
            yield return Send("POST", waitForResult ? "/api/ingest?wait=1" : "/api/ingest", json, (status, text, netError) =>
            {
                if (netError != null) { done(null, netError); return; }
                IngestReply reply;
                string error;
                if (status >= 200 && status < 300 && Replies.TryParseIngest(text, out reply, out error)) done(reply, null);
                else done(null, Replies.ErrorOf(text, status));
            });
        }

        public IEnumerator PostQuery(string json, Action<QueryReply, string> done)
        {
            yield return Send("POST", "/api/query", json, (status, text, netError) =>
            {
                if (netError != null) { done(null, netError); return; }
                QueryReply reply;
                string error;
                if (status >= 200 && status < 300 && Replies.TryParseQuery(text, out reply, out error)) done(reply, null);
                else done(null, Replies.ErrorOf(text, status));
            });
        }

        /// <summary>The raw JSON of what the agent remembers (objects, pose, target, ingest stats, recent traces).</summary>
        public IEnumerator GetMemory(Action<string, string> done)
        {
            yield return Send("GET", "/api/memory", null, (status, text, netError) =>
            {
                if (netError != null) { done(null, netError); return; }
                if (status >= 200 && status < 300) done(text, null);
                else done(null, Replies.ErrorOf(text, status));
            });
        }
    }
}
