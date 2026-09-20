#if UNITY_ANDROID && !UNITY_EDITOR
using UnityEngine;
using UnityEngine.Android;

/// <summary>
/// Takes one photo with both back cameras of the Beam Pro and saves a side-by-side JPEG
/// to Pictures/DualCam. Spawns itself at startup; call TakePhoto() from your own UI if the
/// on-screen button isn't reachable.
/// </summary>
public class DualCameraCapture : MonoBehaviour
{
    const string JavaClass = "com.htn.dualcam.DualCamCapture";

    // Largest sensor-aspect YUV size under this many pixels is used. 12 MP is the sensor max.
    // Kept small because the photo is uploaded to the Cloudflare locator (about 640x480 per eye).
    public int maxPixels = 400000;
    // Sensor orientation is 90; change to 0/180/270 if the saved photo comes out sideways.
    public int rotationDegrees = 90;
    // The controller that owns the UI (LastseenApp.LastseenController) turns this off; on its own the component keeps its debug button.
    public bool showDebugGui = true;

    // Raised with the saved path (e.g. "Pictures/DualCam/dualcam_123.jpg") after a successful capture.
    public event System.Action<string> Captured;

    AndroidJavaObject capture;
    bool pending;
    string status = "ready";

    [RuntimeInitializeOnLoadMethod(RuntimeInitializeLoadType.AfterSceneLoad)]
    static void Bootstrap()
    {
        var go = new GameObject("DualCameraCapture");
        DontDestroyOnLoad(go);
        go.AddComponent<DualCameraCapture>();
    }

    void Start()
    {
        if (!Permission.HasUserAuthorizedPermission(Permission.Camera))
            Permission.RequestUserPermission(Permission.Camera);
    }

    public void TakePhoto()
    {
        if (pending) return;
        if (!Permission.HasUserAuthorizedPermission(Permission.Camera))
        {
            Permission.RequestUserPermission(Permission.Camera);
            status = "camera permission needed, tap again after granting";
            return;
        }

        if (capture == null)
        {
            using (var player = new AndroidJavaClass("com.unity3d.player.UnityPlayer"))
            using (var activity = player.GetStatic<AndroidJavaObject>("currentActivity"))
                capture = new AndroidJavaObject(JavaClass, activity);
            Debug.Log("[DualCam] cameras:\n" + capture.Call<string>("listCameras"));
        }

        capture.Call("capture", maxPixels, rotationDegrees);
        pending = true;
        status = "capturing...";
    }

    void Update()
    {
        if (!pending) return;
        string r = capture.Call<string>("poll");
        if (r == null) return;
        pending = false;
        status = r;
        Debug.Log("[DualCam] " + r);

        if (r.StartsWith("OK:"))
        {
            // "OK:Pictures/DualCam/x.jpg (WxH, cams a|b, skew ms)" -> just the path
            int end = r.IndexOf(" (");
            Captured?.Invoke(end < 0 ? r.Substring(3) : r.Substring(3, end - 3));
        }
    }

    void OnGUI()
    {
        if (!showDebugGui) return;
        int h = Screen.height / 12;
        var button = new GUIStyle(GUI.skin.button) { fontSize = h / 2 };
        var label = new GUIStyle(GUI.skin.label) { fontSize = h / 3, wordWrap = true };

        GUI.enabled = !pending;
        if (GUI.Button(new Rect(h, h, Screen.width - 2 * h, h * 2), "Take dual photo", button))
            TakePhoto();
        GUI.enabled = true;
        GUI.Label(new Rect(h, h * 3.5f, Screen.width - 2 * h, h * 4), status, label);
    }

    void OnDestroy()
    {
        capture?.Dispose();
    }
}

#endif
