using System.Collections;
using Forgetmenot;
using Lastseen;
using UnityEngine;
#if UNITY_ANDROID && !UNITY_EDITOR
using UnityEngine.Android;
#endif

namespace Omni
{
    /// <summary>
    /// Omni as the trigger for the arrow. The wearer presses Talk and says a name ("where is my hacker badge / hacker tag");
    /// OMNI (through the Worker's /api/intent) decides whether that was a request for the hacker card, and only then does
    /// RevealOnFirstSighting show the finding group (pill, distance and arrow) that points at where the card was last seen.
    /// Where the card is comes from the on-device detector and LastSeenAnchor as before; this only decides when to show it.
    ///
    /// It spawns itself when the scene loads, so no scene edit is needed. Without a usable Assets/Resources/lastseen.json it does
    /// nothing and the scene behaves exactly as before (the arrow shows as soon as the card has been seen).
    /// </summary>
    public sealed class OmniVoiceTrigger : MonoBehaviour
    {
        [Tooltip("The id the Worker answers with, and what the detector calls the object.")]
        [SerializeField] string targetId = "hacker_card";
        [SerializeField, Range(2, 10)] int maxSeconds = 6;
        [Tooltip("A button that sends this text instead of speech: tests Omni and the arrow without the microphone.")]
        [SerializeField] string testPhrase = "where is my hacker badge";

        const int SampleRate = 16000;

        OmniConfig config;
        RevealOnFirstSighting reveal;
        AudioClip recording;
        Coroutine autoStop;
        bool isRecording;
        bool busy;
        string status = "";

        [RuntimeInitializeOnLoadMethod(RuntimeInitializeLoadType.AfterSceneLoad)]
        static void Bootstrap()
        {
            if (FindFirstObjectByType<OmniVoiceTrigger>() != null) return;
            var go = new GameObject("OmniVoiceTrigger");
            DontDestroyOnLoad(go);
            go.AddComponent<OmniVoiceTrigger>();
        }

        void Start()
        {
            string problem;
            config = OmniConfig.Load(out problem);
            reveal = FindFirstObjectByType<RevealOnFirstSighting>();
            if (config == null)
            {
                status = "OMNI off: " + problem;
                return;
            }
            if (reveal == null)
            {
                status = "OMNI ready, but the scene has no RevealOnFirstSighting to show the arrow";
                return;
            }
            reveal.RequireRequest = true; // from now on the arrow waits until the wearer asks for it
            status = "OMNI ready: press Talk and say \"where is my hacker badge\"";
        }

        // ------------------------------------------------------------------ microphone

        void StartRecording()
        {
            if (isRecording || busy || config == null) return;
#if UNITY_ANDROID && !UNITY_EDITOR
            if (!Permission.HasUserAuthorizedPermission(Permission.Microphone))
            {
                Permission.RequestUserPermission(Permission.Microphone);
                status = "microphone permission needed: press Talk again after allowing it";
                return;
            }
#endif
            if (Microphone.devices.Length == 0)
            {
                status = "no microphone found";
                return;
            }
            recording = Microphone.Start(null, false, maxSeconds, SampleRate);
            isRecording = true;
            status = "listening...";
            autoStop = StartCoroutine(StopAfter(maxSeconds));
        }

        IEnumerator StopAfter(int seconds)
        {
            yield return new WaitForSeconds(seconds);
            StopAndSend();
        }

        void StopAndSend()
        {
            if (!isRecording) return;
            isRecording = false;
            if (autoStop != null) StopCoroutine(autoStop);
            autoStop = null;
            int samples = Microphone.GetPosition(null);
            Microphone.End(null);
            if (samples < SampleRate / 4)
            {
                status = "didn't catch that, too short";
                return;
            }
            var data = new float[samples * recording.channels];
            recording.GetData(data, 0);
            byte[] wav = WavEncoder.EncodePcm16(data, data.Length, recording.channels, recording.frequency);
            StartCoroutine(Ask(null, wav));
        }

        // ------------------------------------------------------------------ Omni

        IEnumerator Ask(string text, byte[] wav)
        {
            busy = true;
            status = "asking Omni...";
            IntentReply reply = null;
            string failure = null;
            yield return OmniIntentClient.Ask(config, text, wav, (r, err) => { reply = r; failure = err; });
            busy = false;
            if (reply == null)
            {
                status = "Omni: " + failure;
                yield break;
            }
            status = Describe(reply);
        }

        /// <summary>Acts on the reply (shows the arrow when the wearer asked for the target) and returns what to tell them.</summary>
        string Describe(IntentReply r)
        {
            string heard = string.IsNullOrEmpty(r.Heard) ? "" : "\"" + r.Heard + "\": ";
            string offline = r.Source == "keywords" ? "  [Omni unavailable, matched the words: " + r.Note + "]" : "";
            if (r.Wants != targetId) return heard + "not a request for the hacker badge" + offline;
            if (reveal == null) return heard + "asked for the hacker badge, but the scene has no arrow to show" + offline;

            reveal.Request();
            string say = string.IsNullOrEmpty(r.Say) ? "Pointing you to your hacker badge." : r.Say;
            if (!reveal.HasAnchor) say += " (The camera hasn't seen it yet: the arrow appears as soon as it does.)";
            return heard + say + offline;
        }

        // ------------------------------------------------------------------ on-screen controls (also mirrored to the glasses)

        void OnGUI()
        {
            if (string.IsNullOrEmpty(status)) return;
            int h = Mathf.Max(56, Screen.height / 20);
            var button = new GUIStyle(GUI.skin.button) { fontSize = h / 2 };
            var label = new GUIStyle(GUI.skin.label) { fontSize = Mathf.Max(14, h / 3), wordWrap = true };

            float w = Screen.width - 2 * h;
            float y = Screen.height - h * 4.6f;
            GUI.Label(new Rect(h, y, w, h * 1.6f), status, label);
            y += h * 1.7f;

            if (config != null)
            {
                GUI.enabled = !busy;
                if (GUI.Button(new Rect(h, y, w * 0.62f - h * 0.2f, h * 1.3f), isRecording ? "Stop and send" : "Talk", button))
                {
                    if (isRecording) StopAndSend();
                    else StartRecording();
                }
                if (GUI.Button(new Rect(h + w * 0.62f, y, w * 0.38f, h * 1.3f), "Test", button)) StartCoroutine(Ask(testPhrase, null));
                GUI.enabled = true;
            }
        }
    }
}
