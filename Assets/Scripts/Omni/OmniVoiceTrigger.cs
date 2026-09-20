using System.Collections;
using System.Text;
using Forgetmenot;
using Lastseen;
using Unity.XR.XREAL;
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
    /// "I found my hacker tag" hides it again and clears the remembered position (kept for a few minutes, so a wrong "found" can be undone).
    ///
    /// Recording starts and stops from the phone's Talk button or from a long press of the glasses' multi key (XREAL SDK key events;
    /// the SDK raises them on the main thread). A long press is a single event, so it toggles: press to start, press again to send.
    ///
    /// The wearer may not be looking at the phone screen, so everything that matters is also a sound: a beep when recording starts,
    /// two notes when it is sent, a low tone for a problem, and a spoken answer (what Omni said, the general direction, how long ago
    /// it was seen, and "it may have moved" when that was a while ago). Errors are spoken too.
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
        [Header("Glasses button")]
        [Tooltip("The glasses key that starts and stops recording.")]
        [SerializeField] XREALKeyType talkKey = XREALKeyType.MULTI_KEY;
        [SerializeField] XREALClickType talkPress = XREALClickType.LONG_PRESS;
        [Header("When Omni cannot be reached")]
        [Tooltip("If Omni or the network is down (not a wrong token), pressing Talk shows the hacker badge anyway, and says so. " +
                 "Nothing else can be asked for, so a request is the only sensible reading. Off: it only reports the problem.")]
        [SerializeField] bool showBadgeWhenOmniIsDown = true;

        const int SampleRate = 16000;
        /// <summary>A key that reports its long press twice must not start and stop a recording at once.</summary>
        const float ToggleDebounceSeconds = 0.7f;

        OmniConfig config;
        RevealOnFirstSighting reveal;
        AudioClip recording;
        Coroutine autoStop;
        bool isRecording;
        bool busy;
        string status = "";
        string lastKey = "";
        float lastToggleAt = -10f;
        SpeechOutput speech;
        AudioSource beeper;
        AudioClip startClip, sentClip, problemClip;

        [RuntimeInitializeOnLoadMethod(RuntimeInitializeLoadType.AfterSceneLoad)]
        static void Bootstrap()
        {
            if (FindFirstObjectByType<OmniVoiceTrigger>() != null) return;
            var go = new GameObject("OmniVoiceTrigger");
            DontDestroyOnLoad(go);
            go.AddComponent<OmniVoiceTrigger>();
        }

        void Awake()
        {
            speech = new SpeechOutput();
            beeper = gameObject.AddComponent<AudioSource>();
            beeper.spatialBlend = 0f;
            startClip = MakeClip("omni-start", Earcon.Start());
            sentClip = MakeClip("omni-sent", Earcon.Sent());
            problemClip = MakeClip("omni-problem", Earcon.Problem());
        }

        static AudioClip MakeClip(string name, float[] samples)
        {
            var clip = AudioClip.Create(name, samples.Length, 1, Earcon.SampleRate, false);
            clip.SetData(samples, 0);
            return clip;
        }

        void Beep(AudioClip clip)
        {
            if (beeper != null && clip != null) beeper.PlayOneShot(clip);
        }

        void OnEnable()
        {
            XREALCallbackHandler.OnXREALGlassesKeyClick += OnGlassesKey;
        }

        void OnDisable()
        {
            XREALCallbackHandler.OnXREALGlassesKeyClick -= OnGlassesKey;
        }

        void Update()
        {
            speech.Pump(); // speaks the waiting sentence once the text-to-speech engine has started
        }

        void OnDestroy()
        {
            speech.Dispose();
        }

        /// <summary>The system takes the microphone away when the app is paused: drop a recording in progress instead of leaving it stuck.</summary>
        void OnApplicationPause(bool paused)
        {
            if (paused && isRecording) CancelRecording();
        }

        /// <summary>Every glasses key event is shown on screen (lastKey), so which physical button is which can be checked on the device.</summary>
        void OnGlassesKey(XREALClickType click, XREALKeyType key)
        {
            lastKey = key + " " + click;
            if (key != talkKey || click != talkPress) return;
            if (Time.unscaledTime - lastToggleAt < ToggleDebounceSeconds) return;
            lastToggleAt = Time.unscaledTime;
            if (isRecording) StopAndSend();
            else StartRecording();
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
            status = "OMNI ready: press Talk (or long-press the glasses multi key) and say \"where is my hacker badge\"";
        }

        // ------------------------------------------------------------------ microphone

        void StartRecording()
        {
            if (isRecording || config == null) return;
            if (busy)
            {
                Beep(problemClip); // still waiting for Omni: a sound instead of silently ignoring the press
                return;
            }
#if UNITY_ANDROID && !UNITY_EDITOR
            if (!Permission.HasUserAuthorizedPermission(Permission.Microphone))
            {
                Permission.RequestUserPermission(Permission.Microphone);
                status = "microphone permission needed: press Talk again after allowing it";
                Beep(problemClip);
                return;
            }
#endif
            if (Microphone.devices.Length == 0)
            {
                status = "no microphone found";
                Beep(problemClip);
                speech.Speak("I can't find a microphone.");
                return;
            }
            speech.Stop(); // barge-in: never record the app's own voice
            Beep(startClip);
            recording = Microphone.Start(null, false, maxSeconds, SampleRate);
            isRecording = true;
            status = "listening... (press Stop and send, or long-press the glasses multi key again)";
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
                Beep(problemClip);
                speech.Speak("I didn't catch that.");
                return;
            }
            Beep(sentClip);
            var data = new float[samples * recording.channels];
            recording.GetData(data, 0);
            byte[] wav = WavEncoder.EncodePcm16(data, data.Length, recording.channels, recording.frequency);
            StartCoroutine(Ask(null, wav));
        }

        void CancelRecording()
        {
            isRecording = false;
            if (autoStop != null) StopCoroutine(autoStop);
            autoStop = null;
            Microphone.End(null);
            status = "recording cancelled (the app was paused)";
        }

        // ------------------------------------------------------------------ Omni

        IEnumerator Ask(string text, byte[] wav)
        {
            busy = true;
            status = "asking Omni...";
            IntentReply reply = null;
            Failure failure = null;
            yield return OmniIntentClient.Ask(config, text, wav, (r, f) => { reply = r; failure = f; });
            busy = false;
            if (reply == null)
            {
                OnFailure(failure);
                yield break;
            }
            // The Worker reached Omni's side but Omni failed, and only typed words can be matched by keywords: for speech that means
            // nothing was understood at all, which is an outage, not a "that was not a request".
            if (wav != null && reply.Source == "keywords" && reply.Wants == null && reply.Found == null)
            {
                OnFailure(new Failure { Kind = FailureKind.Server, Status = "Omni could not answer (" + reply.Note + ")", Spoken = "Omni had a problem.", OmniUnavailable = true });
                yield break;
            }
            status = Describe(reply);
        }

        /// <summary>A problem the wearer must notice without looking: a tone, a spoken sentence, and (if Omni is down) the fallback.</summary>
        void OnFailure(Failure f)
        {
            Beep(problemClip);
            status = "Omni: " + f.Status;
            if (showBadgeWhenOmniIsDown && f.OmniUnavailable && reveal != null)
                status += "\n" + ShowBadge("Omni isn't available, so I'm showing your hacker badge anyway.");
            else
                speech.Speak(f.Spoken);
        }

        /// <summary>Acts on the reply (shows or hides the arrow, and says so) and returns what to show on screen.</summary>
        string Describe(IntentReply r)
        {
            string heard = string.IsNullOrEmpty(r.Heard) ? "" : "\"" + r.Heard + "\": ";
            string offline = r.Source == "keywords" ? "  [Omni unavailable, matched the words: " + r.Note + "]" : "";

            if (r.Found == targetId)
            {
                // "I found my hacker tag": hide the arrow and clear where it was, so the next request cannot point at a stale spot
                // (the old position is kept for a few minutes: asking again brings it back)
                if (reveal != null) reveal.Forget();
                string ok = (string.IsNullOrEmpty(r.Say) ? "Glad you found it." : r.Say).TrimEnd('.', ' ') + ". I've forgotten where it was.";
                speech.Speak(ok);
                return heard + ok + " (arrow hidden)" + offline;
            }
            if (r.Wants != targetId)
            {
                Beep(problemClip);
                const string no = "That wasn't a request for your hacker badge.";
                speech.Speak(no);
                return heard + no + offline;
            }
            if (reveal == null)
            {
                const string none = "I heard you, but the scene has no arrow to show.";
                speech.Speak(none);
                return heard + none + offline;
            }
            string say = string.IsNullOrEmpty(r.Say) ? "Pointing you to your hacker badge." : r.Say;
            return heard + ShowBadge(say) + offline;
        }

        /// <summary>
        /// Shows the arrow and announces it through the glasses' speakers: what Omni said, the general direction from where the wearer
        /// is looking now, how long ago the card was seen, and a warning when that was a while ago. Returns the same text for the screen.
        /// </summary>
        string ShowBadge(string lead)
        {
            // "I found it" then "it's lost again": bring the cleared position back, with its real age
            bool restored = !reveal.HasAnchor && reveal.RestoreForgotten();
            reveal.Request();

            var s = new StringBuilder(lead.TrimEnd('.', ' ')).Append(". ");
            bool seen;
            string where = Where(out seen);
            if (!seen)
            {
                s.Append("I haven't seen it yet. The arrow will show as soon as I do.");
            }
            else
            {
                if (where != null) s.Append(where);
                double age = reveal.SecondsSinceSeen;
                string ago = AgeSpeech.Ago(age);
                if (ago != null && age >= 60) s.Append(" I last saw it ").Append(ago).Append('.');
                if (restored) s.Append(" You said you'd found it, so this is where I last saw it.");
                if (AgeSpeech.MayHaveMoved(age)) s.Append(" It may have moved.");
            }
            string text = s.ToString();
            speech.Speak(text);
            return text;
        }

        /// <summary>
        /// "It's ahead and to your left, about 3 meters away." from where the wearer is looking now. <paramref name="seen"/> is false when
        /// the card has not been seen yet; the result is null then, and also when there is no camera to measure from.
        /// </summary>
        string Where(out bool seen)
        {
            Vector3 target = Vector3.zero;
            seen = reveal != null && reveal.TryGetAnchorPosition(out target);
            if (!seen) return null;
            Camera head = Camera.main;
            if (head == null && Camera.allCamerasCount > 0) head = Camera.allCameras[0];
            if (head == null) return null;

            Vector3 to = target - head.transform.position;
            Vector3 flatTo = Vector3.ProjectOnPlane(to, Vector3.up);
            Vector3 flatForward = Vector3.ProjectOnPlane(head.transform.forward, Vector3.up);
            // positive = to the right, as DirectionSpeech expects (Unity's signed angle around up)
            double angle = flatTo.sqrMagnitude < 1e-6f || flatForward.sqrMagnitude < 1e-6f ? 0.0 : Vector3.SignedAngle(flatForward, flatTo, Vector3.up);
            double elevation = Mathf.Atan2(to.y, flatTo.magnitude) * Mathf.Rad2Deg;
            return DirectionSpeech.Sentence(angle, elevation, to.magnitude);
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
            string text = status;
            if (lastKey.Length > 0) text += "\nglasses key: " + lastKey;
            if (speech.Problem != null) text += "\nspeech: " + speech.Problem;
            GUI.Label(new Rect(h, y, w, h * 1.6f), text, label);
            y += h * 1.7f;

            if (config != null)
            {
                GUI.enabled = !busy;
                if (GUI.Button(new Rect(h, y, w * 0.62f - h * 0.2f, h * 1.3f), isRecording ? "Stop and send" : "Talk", button))
                {
                    if (isRecording) StopAndSend();
                    else StartRecording();
                }
                GUI.enabled = !busy && !isRecording; // a second request while recording would race the first
                if (GUI.Button(new Rect(h + w * 0.62f, y, w * 0.38f, h * 1.3f), "Test", button)) StartCoroutine(Ask(testPhrase, null));
                GUI.enabled = true;
            }
        }
    }
}
