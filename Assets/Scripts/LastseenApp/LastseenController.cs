using Lastseen;
using UnityEngine;
using UnityEngine.XR.ARFoundation;

namespace LastseenApp
{
    /// <summary>
    /// The Lastseen client. It spawns itself when the app starts (no scene wiring needed) and connects the parts:
    ///
    ///   logging:  AR camera -> LiveDetector -> ObjectStabilityTracker ("held still for N s, wearer standing still")
    ///             -> PlacementCapture (dual photo, re-detect, stereo pair) -> POST /api/ingest
    ///   asking:   Talk button -> VoiceQuery (mic -> POST /api/query -> spoken answer + target) -> HudArrow on the glasses
    ///   position: DeadReckoningTracker (steps + fused heading), which stamps every placement and every question
    ///
    /// Settings come from Assets/Resources/lastseen.json (see lastseen.example.json). The on-screen buttons are a stand-in until the
    /// product UI exists; the glasses mirror the phone screen. Everything degrades to a message rather than an exception: no
    /// config, no AR camera, no dual camera, no network.
    /// </summary>
    public sealed class LastseenController : MonoBehaviour
    {
        public LastseenConfig config = new LastseenConfig();

        DeadReckoningTracker pose;
        WorkerClient client;
        PlacementCapture placement;
        VoiceQuery voice;
        HudArrow hud;
        LiveDetector live;
        ObjectStabilityTracker stability;
        string configProblem;
        string reply = "";
        int frames;

        [RuntimeInitializeOnLoadMethod(RuntimeInitializeLoadType.AfterSceneLoad)]
        static void Bootstrap()
        {
            if (FindFirstObjectByType<LastseenController>() != null) return;
            var go = new GameObject("LastseenController");
            DontDestroyOnLoad(go);
            go.AddComponent<LastseenController>();
        }

        void Start()
        {
            TextAsset asset = Resources.Load<TextAsset>("lastseen");
            config = LastseenConfig.Parse(asset != null ? asset.text : null);
            configProblem = asset == null ? "Assets/Resources/lastseen.json is missing: copy lastseen.example.json and fill it in" : config.Problem();

            pose = gameObject.AddComponent<DeadReckoningTracker>();
            pose.stepLengthM = config.StepLengthM;
            client = gameObject.AddComponent<WorkerClient>();
            client.Config = config;
            placement = gameObject.AddComponent<PlacementCapture>();
            placement.client = client;
            placement.pose = pose;
            placement.config = config;
            voice = gameObject.AddComponent<VoiceQuery>();
            voice.client = client;
            voice.pose = pose;
            hud = gameObject.AddComponent<HudArrow>();
            hud.pose = pose;

            voice.Answered += OnAnswered;
            stability = new ObjectStabilityTracker(new StabilityConfig { HoldSeconds = config.HoldSeconds });
            stability.Placed += OnPlaced;

            ARCameraManager arCamera = FindFirstObjectByType<ARCameraManager>();
            if (arCamera != null)
            {
                live = arCamera.GetComponent<LiveDetector>();
                if (live == null) live = arCamera.gameObject.AddComponent<LiveDetector>();
                live.Frame += OnDetections;
            }

#if UNITY_ANDROID && !UNITY_EDITOR
            // the teammates' capture component draws its own debug button; ours are the only ones wanted now
            DualCameraCapture dual = FindFirstObjectByType<DualCameraCapture>();
            if (dual != null) dual.showDebugGui = false;
#endif
        }

        void OnDetections(long tMs, System.Collections.Generic.List<Detection> detections)
        {
            frames++;
            // while a photo is being taken the camera pipeline is busy and the wearer is being asked to hold still anyway
            if (placement.Busy || configProblem != null) return;
            stability.Update(tMs, detections, pose.Current.Stationary);
        }

        void OnPlaced(PlacedEvent e)
        {
            if (placement.Busy || configProblem != null) return;
            placement.Begin("detector");
        }

        void OnAnswered(QueryReply r)
        {
            reply = r.Addressed ? r.Text : "";
            if (r.Target != null) hud.SetTarget(r.Target);
        }

        void OnGUI()
        {
            int h = Mathf.Max(48, Screen.height / 16);
            var button = new GUIStyle(GUI.skin.button) { fontSize = h / 2 };
            var label = new GUIStyle(GUI.skin.label) { fontSize = Mathf.Max(14, h / 3), wordWrap = true };
            float w = Screen.width - 2 * h;
            float y = h * 0.5f;

            string detector = live == null ? "no AR camera in the scene: use Log now" : "detector " + frames + " frames" + (string.IsNullOrEmpty(live.LastError) ? "" : " (" + live.LastError + ")");
            string text = pose.Status + "\n" + detector;
            if (configProblem != null) text += "\nCONFIG: " + configProblem;
            if (placement.LastStatus.Length > 0) text += "\nlog: " + placement.LastStatus;
            if (voice.LastStatus.Length > 0) text += "\nvoice: " + voice.LastStatus;
            if (reply.Length > 0) text += "\n\"" + reply + "\"";
            if (hud.Target != null) text += string.Format("\narrow: {0:0}° to {1}, {2:0.0} m", hud.AngleDeg, hud.Target.Label, hud.DistanceM);
            GUI.Label(new Rect(h, y, w, h * 5), text, label);

            float by = Screen.height - h * 6.5f;
            GUI.enabled = configProblem == null && !voice.Busy;
            if (GUI.Button(new Rect(h, by, w, h * 1.6f), voice.IsRecording ? "Stop" : "Talk", button))
            {
                if (voice.IsRecording) voice.StopAndSend();
                else
                {
                    hud.Clear();
                    reply = "";
                    voice.StartRecording();
                }
            }
            GUI.enabled = configProblem == null && !placement.Busy;
            if (GUI.Button(new Rect(h, by + h * 1.8f, w, h * 1.2f), "Log what's in front of me", button)) placement.Begin("manual");
            GUI.enabled = true;
            float half = (w - h * 0.3f) / 2f;
            if (GUI.Button(new Rect(h, by + h * 3.2f, half, h * 1.1f), "Recenter", button)) hud.Recenter();
            if (GUI.Button(new Rect(h + half + h * 0.3f, by + h * 3.2f, half, h * 1.1f), "Reset origin", button))
            {
                pose.ResetOrigin();
                hud.Clear();
            }
        }
    }
}
