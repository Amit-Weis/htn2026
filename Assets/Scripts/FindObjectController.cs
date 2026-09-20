using Depth;
using UnityEngine;

/// <summary>
/// Voice -> Omni intent -> dual photo -> stereo locate -> marker/arrow. Spawns itself at startup unless one
/// is already in the scene; set workerUrl in the inspector on a scene instance, or edit the default below.
/// "I can't find my phone" -> Omni says find "cell phone" -> photo is taken -> position is shown.
/// </summary>
public class FindObjectController : MonoBehaviour
{
    [Tooltip("Cloudflare Worker root URL, e.g. https://htn-locator.<you>.workers.dev/")]
    public string workerUrl = "";

    VoiceCommand voice;
    TargetLocator locator;
    TargetIndicator indicator;
#if UNITY_ANDROID && !UNITY_EDITOR
    DualCameraCapture capture;
#endif
    string status = "tap Talk and say what you can't find";
    Pose cameraPoseAtRequest = Pose.identity;

    [RuntimeInitializeOnLoadMethod(RuntimeInitializeLoadType.AfterSceneLoad)]
    static void Bootstrap()
    {
        if (FindFirstObjectByType<FindObjectController>() != null) return;
        var go = new GameObject("FindObjectController");
        DontDestroyOnLoad(go);
        go.AddComponent<FindObjectController>();
    }

    void Start()
    {
        voice = gameObject.AddComponent<VoiceCommand>();
        locator = gameObject.AddComponent<TargetLocator>();
        indicator = gameObject.AddComponent<TargetIndicator>();
#if UNITY_ANDROID && !UNITY_EDITOR
        capture = FindFirstObjectByType<DualCameraCapture>();
        if (capture != null) capture.Captured += OnCaptured;
#endif

        if (!string.IsNullOrEmpty(workerUrl))
        {
            locator.endpointUrl = workerUrl;
            voice.commandUrl = workerUrl.TrimEnd('/') + "/command";
        }

        voice.Heard += OnHeard;
        voice.Failed += OnFailed;
        locator.TargetLocated += OnLocated;
        locator.Failed += OnFailed;
    }

    void OnHeard(VoiceCommandResponse r)
    {
        if (r.intent != "find")
        {
            status = string.IsNullOrEmpty(r.reply) ? "not a find request: \"" + r.heard + "\"" : r.reply;
            return;
        }
        if (string.IsNullOrEmpty(r.target))
        {
            status = "heard \"" + r.heard + "\", but I can't detect that kind of object";
            return;
        }

        status = (string.IsNullOrEmpty(r.reply) ? "looking for " + r.target : r.reply) + " - taking photo...";
        locator.targetLabel = r.target;
        TakePhoto();
    }

    void TakePhoto()
    {
        // The photo is taken from the glasses' point of view; the head pose now is what places the result.
        var cam = Camera.main != null ? Camera.main : FindFirstObjectByType<Camera>();
        cameraPoseAtRequest = cam != null
            ? new Pose(cam.transform.position, cam.transform.rotation)
            : Pose.identity;

#if UNITY_ANDROID && !UNITY_EDITOR
        if (capture == null)
        {
            status = "dual camera component not found";
            return;
        }
        capture.TakePhoto();
#else
        // Editor: no dual camera. Only useful with TargetLocator's mock response (empty workerUrl).
        OnCaptured("");
#endif
    }

    void OnCaptured(string path)
    {
        status = "locating...";
        locator.WorldFromCamera = cameraPoseAtRequest;
        locator.LocateFromFile(path);
    }

    void OnLocated(ObjectPose3D pose)
    {
        status = string.Format("found {0}, {1:0.0} m away", pose.label, pose.depth);
        indicator.Show(pose);
    }

    void OnFailed(string error)
    {
        status = error;
    }

    void OnGUI()
    {
        int h = Screen.height / 12;
        var button = new GUIStyle(GUI.skin.button) { fontSize = h / 2 };
        var label = new GUIStyle(GUI.skin.label) { fontSize = h / 3, wordWrap = true };

        string text = voice.IsRecording ? "Stop" : "Talk";
        if (GUI.Button(new Rect(h, Screen.height - h * 5, Screen.width - 2 * h, h * 2), text, button))
        {
            if (voice.IsRecording)
            {
                status = "asking Omni...";
                voice.StopRecording();
            }
            else
            {
                indicator.Clear();
                status = "listening...";
                voice.StartRecording();
            }
        }
        GUI.Label(new Rect(h, Screen.height - h * 2.5f, Screen.width - 2 * h, h * 2), status, label);
    }
}
