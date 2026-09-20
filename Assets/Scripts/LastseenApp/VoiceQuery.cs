using System;
using System.Collections;
using Lastseen;
using UnityEngine;
#if UNITY_ANDROID && !UNITY_EDITOR
using UnityEngine.Android;
#endif

namespace LastseenApp
{
    /// <summary>
    /// Push-to-talk: record the microphone, POST the WAV to /api/query with the current pose, play the spoken answer, and hand
    /// the reply (text and HUD target) to whoever listens. The Worker's agent transcribes, decides which tool to call, and
    /// answers in one request; there is no client-side speech recognition.
    /// </summary>
    public sealed class VoiceQuery : MonoBehaviour
    {
        public WorkerClient client;
        public DeadReckoningTracker pose;
        public int maxSeconds = 8;

        const int SampleRate = 16000;

        public bool IsRecording { get; private set; }
        public bool Busy { get; private set; }
        public string LastStatus { get; private set; } = "";
        public event Action<string> Status;
        public event Action<QueryReply> Answered;

        AudioClip recording;
        AudioSource player;
        Coroutine autoStop;

        void Say(string s)
        {
            LastStatus = s;
            var h = Status;
            if (h != null) h(s);
        }

        void Awake()
        {
            player = gameObject.AddComponent<AudioSource>();
            player.spatialBlend = 0f;
        }

        public void StartRecording()
        {
            if (IsRecording || Busy) return;
#if UNITY_ANDROID && !UNITY_EDITOR
            if (!Permission.HasUserAuthorizedPermission(Permission.Microphone))
            {
                Permission.RequestUserPermission(Permission.Microphone);
                Say("microphone permission needed: tap Talk again after allowing it");
                return;
            }
#endif
            if (Microphone.devices.Length == 0)
            {
                Say("no microphone found");
                return;
            }
            player.Stop(); // barge-in: talking over the assistant silences it
            recording = Microphone.Start(null, false, maxSeconds, SampleRate);
            IsRecording = true;
            Say("listening...");
            autoStop = StartCoroutine(StopAfter(maxSeconds));
        }

        IEnumerator StopAfter(int seconds)
        {
            yield return new WaitForSeconds(seconds);
            StopAndSend();
        }

        public void StopAndSend()
        {
            if (!IsRecording) return;
            IsRecording = false;
            if (autoStop != null) StopCoroutine(autoStop);
            autoStop = null;
            int samples = Microphone.GetPosition(null);
            Microphone.End(null);
            if (samples < SampleRate / 4)
            {
                Say("didn't catch that, too short");
                return;
            }
            var data = new float[samples * recording.channels];
            recording.GetData(data, 0);
            byte[] wav = WavEncoder.EncodePcm16(data, data.Length, recording.channels, recording.frequency);
            StartCoroutine(Ask(null, wav));
        }

        /// <summary>Typed question (debugging without a microphone).</summary>
        public void AskText(string text)
        {
            if (Busy || string.IsNullOrEmpty(text)) return;
            StartCoroutine(Ask(text, null));
        }

        IEnumerator Ask(string text, byte[] wav)
        {
            Busy = true;
            Say("asking...");
            string json;
            try
            {
                PoseSample? p = pose != null ? pose.Current : (PoseSample?)null;
                json = Payloads.BuildQuery(null, text, wav, "audio/wav", p, null);
            }
            catch (Exception e)
            {
                Busy = false;
                Say("could not build the request: " + e.Message);
                yield break;
            }

            QueryReply reply = null;
            string failure = null;
            yield return client.PostQuery(json, (r, err) => { reply = r; failure = err; });
            Busy = false;
            if (reply == null)
            {
                Say("failed: " + failure);
                yield break;
            }
            Say(reply.Addressed ? reply.Text : "(ignored: that did not sound like a question for me)");
            Play(reply);
            var h = Answered;
            if (h != null) h(reply);
        }

        void Play(QueryReply reply)
        {
            if (reply.Audio == null) return;
            WavData wav;
            string error;
            if (!WavDecoder.TryDecode(reply.Audio, out wav, out error))
            {
                Say(LastStatus + " [no audio: " + error + "]");
                return;
            }
            var clip = AudioClip.Create("reply", wav.Samples.Length / wav.Channels, wav.Channels, wav.SampleRate, false);
            clip.SetData(wav.Samples, 0);
            player.PlayOneShot(clip);
        }
    }
}
