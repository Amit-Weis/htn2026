using System;
using System.Collections;
using UnityEngine;
using UnityEngine.Networking;
#if UNITY_ANDROID && !UNITY_EDITOR
using UnityEngine.Android;
#endif

namespace Depth
{
    // Records from the microphone, POSTs a WAV to the Cloudflare /command endpoint (which asks Omni
    // what the user wants) and raises Heard with the parsed reply.
    public class VoiceCommand : MonoBehaviour
    {
        [Tooltip("Cloudflare Worker command URL, e.g. https://htn-locator.<you>.workers.dev/command")]
        public string commandUrl;
        public int maxSeconds = 8;
        public int timeoutSeconds = 30;

        const int SampleRate = 16000;

        public bool IsRecording { get; private set; }
        public event Action<VoiceCommandResponse> Heard;
        public event Action<string> Failed;

        AudioClip clip;
        Coroutine autoStop;

        public void StartRecording()
        {
            if (IsRecording) return;
#if UNITY_ANDROID && !UNITY_EDITOR
            if (!Permission.HasUserAuthorizedPermission(Permission.Microphone))
            {
                Permission.RequestUserPermission(Permission.Microphone);
                Failed?.Invoke("microphone permission needed, tap again after granting");
                return;
            }
#endif
            if (Microphone.devices.Length == 0)
            {
                Failed?.Invoke("no microphone found");
                return;
            }
            clip = Microphone.Start(null, false, maxSeconds, SampleRate);
            IsRecording = true;
            autoStop = StartCoroutine(StopAfter(maxSeconds));
        }

        // Ends the recording and sends it.
        public void StopRecording()
        {
            if (!IsRecording) return;
            IsRecording = false;
            if (autoStop != null) StopCoroutine(autoStop);

            int samples = Microphone.GetPosition(null);
            Microphone.End(null);
            if (samples < SampleRate / 4)
            {
                Failed?.Invoke("didn't catch that, too short");
                return;
            }
            StartCoroutine(Send(EncodeWav(clip, samples)));
        }

        IEnumerator StopAfter(int seconds)
        {
            yield return new WaitForSeconds(seconds);
            StopRecording();
        }

        IEnumerator Send(byte[] wav)
        {
            if (string.IsNullOrEmpty(commandUrl))
            {
                Failed?.Invoke("VoiceCommand.commandUrl is not set");
                yield break;
            }

            using (var req = new UnityWebRequest(commandUrl, UnityWebRequest.kHttpVerbPOST))
            {
                req.uploadHandler = new UploadHandlerRaw(wav);
                req.downloadHandler = new DownloadHandlerBuffer();
                req.SetRequestHeader("Content-Type", "audio/wav");
                req.timeout = timeoutSeconds;
                yield return req.SendWebRequest();

                // The Worker sends {"error": ...} with a non-2xx status, so read the body before the status.
                VoiceCommandResponse r = null;
                try { r = JsonUtility.FromJson<VoiceCommandResponse>(req.downloadHandler.text); }
                catch (Exception) { }

                if (r == null || !string.IsNullOrEmpty(r.error))
                    Failed?.Invoke(r != null ? r.error : "request failed: " + req.error);
                else
                    Heard?.Invoke(r);
            }
        }

        // 16-bit PCM mono WAV of the first `samples` samples.
        static byte[] EncodeWav(AudioClip c, int samples)
        {
            var data = new float[samples * c.channels];
            c.GetData(data, 0);

            var bytes = new byte[44 + data.Length * 2];
            void Str(int at, string s) { for (int i = 0; i < s.Length; i++) bytes[at + i] = (byte)s[i]; }
            void I32(int at, int v) { BitConverter.GetBytes(v).CopyTo(bytes, at); }
            void I16(int at, short v) { BitConverter.GetBytes(v).CopyTo(bytes, at); }

            Str(0, "RIFF"); I32(4, bytes.Length - 8); Str(8, "WAVE");
            Str(12, "fmt "); I32(16, 16); I16(20, 1); I16(22, (short)c.channels);
            I32(24, c.frequency); I32(28, c.frequency * c.channels * 2); I16(32, (short)(c.channels * 2)); I16(34, 16);
            Str(36, "data"); I32(40, data.Length * 2);
            for (int i = 0; i < data.Length; i++)
                I16(44 + i * 2, (short)(Mathf.Clamp(data[i], -1f, 1f) * short.MaxValue));
            return bytes;
        }
    }
}
