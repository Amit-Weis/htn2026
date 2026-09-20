using System;
using UnityEngine;

namespace Omni
{
    /// <summary>
    /// Speaks a sentence through Android's built-in text-to-speech (no network, no Omni credit). It plays on the phone's current audio
    /// output, which is normally the XREAL One's speakers while the glasses are connected; nothing here selects the output.
    ///
    /// Speak() may be called any time: the engine starts asynchronously, so the text waits and is spoken from Pump() (call it every
    /// frame from the main thread) once the engine is ready. A new sentence replaces one still being spoken, and Stop() cuts it off.
    /// If the engine fails to start it is started again (up to three times, 3 s apart) before giving up; Problem then holds the reason
    /// so it can be shown instead of failing silently. Outside an Android build (the editor) it only logs the text.
    /// </summary>
    public sealed class SpeechOutput : IDisposable
    {
#if UNITY_ANDROID && !UNITY_EDITOR
        /// <summary>TextToSpeech.OnInitListener. Android calls it on its own thread, so it only records the status.</summary>
        sealed class InitListener : AndroidJavaProxy
        {
            readonly Action<int> done;

            public InitListener(Action<int> done) : base("android.speech.tts.TextToSpeech$OnInitListener")
            {
                this.done = done;
            }

            public void onInit(int status)
            {
                done(status);
            }
        }

        const int Starting = -2; // TextToSpeech.SUCCESS is 0 and ERROR is -1
        const int MaxAttempts = 3;
        const float RetryAfterSeconds = 3f;

        AndroidJavaObject tts;
        volatile int initStatus = Starting;
        int attempts;
        float retryAt = -1f;
        bool languageSet;
        string pending;

        public string Problem { get; private set; }

        public SpeechOutput()
        {
            StartEngine();
        }

        void StartEngine()
        {
            attempts++;
            initStatus = Starting;
            retryAt = -1f;
            languageSet = false;
            try
            {
                using (var player = new AndroidJavaClass("com.unity3d.player.UnityPlayer"))
                using (var activity = player.GetStatic<AndroidJavaObject>("currentActivity"))
                    tts = new AndroidJavaObject("android.speech.tts.TextToSpeech", activity, new InitListener(s => initStatus = s));
            }
            catch (Exception e)
            {
                tts = null;
                initStatus = -1;
                Problem = "could not start text-to-speech: " + e.Message;
            }
        }

        void StopEngine()
        {
            if (tts == null) return;
            try { tts.Call<int>("stop"); tts.Call("shutdown"); }
            catch (Exception) { /* replacing it anyway */ }
            tts.Dispose();
            tts = null;
        }

        public void Speak(string text)
        {
            if (string.IsNullOrEmpty(text)) return;
            Debug.Log("[Omni speech] " + text);
            pending = text;
            Pump();
        }

        /// <summary>Cut off what is being spoken and forget anything waiting (the wearer is about to talk).</summary>
        public void Stop()
        {
            pending = null;
            if (tts == null || initStatus != 0) return;
            try { tts.Call<int>("stop"); }
            catch (Exception) { /* nothing to stop */ }
        }

        /// <summary>Main thread, every frame: speaks the waiting sentence as soon as the engine is ready, restarting a failed engine.</summary>
        public void Pump()
        {
            if (pending == null || initStatus == Starting) return;
            if (initStatus != 0)
            {
                if (attempts >= MaxAttempts)
                {
                    Problem = "no text-to-speech engine is available on this phone (init status " + initStatus + ")";
                    pending = null;
                    return;
                }
                if (retryAt < 0f) retryAt = Time.unscaledTime + RetryAfterSeconds;
                else if (Time.unscaledTime >= retryAt)
                {
                    StopEngine();
                    StartEngine();
                }
                return;
            }

            string text = pending;
            pending = null;
            try
            {
                if (!languageSet)
                {
                    languageSet = true;
                    using (var locale = new AndroidJavaObject("java.util.Locale", "en", "US")) tts.Call<int>("setLanguage", locale);
                }
                // 0 = QUEUE_FLUSH. The Bundle is left null: Unity matches a null argument against any object parameter.
                int result = tts.Call<int>("speak", text, 0, null, "omni");
                Problem = result != 0 ? "text-to-speech refused the text (result " + result + ")" : null;
            }
            catch (Exception e)
            {
                Problem = "speech failed: " + e.Message;
            }
        }

        public void Dispose()
        {
            StopEngine();
        }
#else
        public string Problem { get { return null; } }

        public void Speak(string text)
        {
            if (!string.IsNullOrEmpty(text)) Debug.Log("[Omni speech] " + text);
        }

        public void Stop() { }

        public void Pump() { }

        public void Dispose() { }
#endif
    }
}
