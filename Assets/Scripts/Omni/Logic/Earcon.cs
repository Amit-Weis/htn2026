using System;

namespace Omni
{
    /// <summary>
    /// The short beeps that tell a wearer who is not looking at the phone what just happened: recording started, sent, or a problem.
    /// Generated as samples (no audio files), so they are unit-tested here and turned into clips by OmniVoiceTrigger.
    /// </summary>
    public static class Earcon
    {
        public const int SampleRate = 22050;

        /// <summary>A sine tone with a 10 ms fade in and out, so it does not click. Empty for a non-positive duration or frequency.</summary>
        public static float[] Tone(double frequencyHz, double seconds, int sampleRate = SampleRate, double volume = 0.35)
        {
            if (sampleRate <= 0 || double.IsNaN(seconds) || double.IsNaN(frequencyHz) || seconds <= 0 || frequencyHz <= 0) return new float[0];
            int n = (int)Math.Round(seconds * sampleRate);
            var data = new float[n];
            int fade = Math.Min(n / 2, (int)(0.010 * sampleRate));
            for (int i = 0; i < n; i++)
            {
                double envelope = 1.0;
                if (fade > 0)
                {
                    if (i < fade) envelope = (double)i / fade;
                    else if (i >= n - fade) envelope = (double)(n - 1 - i) / fade;
                }
                data[i] = (float)(Math.Sin(2.0 * Math.PI * frequencyHz * i / sampleRate) * volume * envelope);
            }
            return data;
        }

        public static float[] Concat(params float[][] parts)
        {
            int total = 0;
            foreach (var p in parts) total += p.Length;
            var all = new float[total];
            int at = 0;
            foreach (var p in parts)
            {
                Array.Copy(p, 0, all, at, p.Length);
                at += p.Length;
            }
            return all;
        }

        /// <summary>One short high beep: listening.</summary>
        public static float[] Start(int sampleRate = SampleRate)
        {
            return Tone(880, 0.12, sampleRate);
        }

        /// <summary>Two quick rising notes: recording stopped, sending.</summary>
        public static float[] Sent(int sampleRate = SampleRate)
        {
            return Concat(Tone(660, 0.08, sampleRate), Tone(880, 0.08, sampleRate));
        }

        /// <summary>One longer low tone: something went wrong.</summary>
        public static float[] Problem(int sampleRate = SampleRate)
        {
            return Tone(220, 0.35, sampleRate);
        }
    }
}
