using System;

namespace Lastseen
{
    /// <summary>Encodes float samples as a 16-bit PCM WAV, the format the Worker's audio input accepts.</summary>
    public static class WavEncoder
    {
        static void Ascii(byte[] b, int at, string s)
        {
            for (int i = 0; i < s.Length; i++) b[at + i] = (byte)s[i];
        }

        static void I32(byte[] b, int at, int v)
        {
            b[at] = (byte)v;
            b[at + 1] = (byte)(v >> 8);
            b[at + 2] = (byte)(v >> 16);
            b[at + 3] = (byte)(v >> 24);
        }

        static void I16(byte[] b, int at, int v)
        {
            b[at] = (byte)v;
            b[at + 1] = (byte)(v >> 8);
        }

        /// <param name="samples">interleaved, in [-1, 1]; values outside are clipped</param>
        public static byte[] EncodePcm16(float[] samples, int count, int channels, int sampleRate)
        {
            if (samples == null) throw new ArgumentNullException("samples");
            if (channels < 1 || sampleRate <= 0) throw new ArgumentException("bad format");
            count = Math.Max(0, Math.Min(count, samples.Length));
            var bytes = new byte[44 + count * 2];
            Ascii(bytes, 0, "RIFF");
            I32(bytes, 4, bytes.Length - 8);
            Ascii(bytes, 8, "WAVEfmt ");
            I32(bytes, 16, 16);
            I16(bytes, 20, 1);
            I16(bytes, 22, channels);
            I32(bytes, 24, sampleRate);
            I32(bytes, 28, sampleRate * channels * 2);
            I16(bytes, 32, channels * 2);
            I16(bytes, 34, 16);
            Ascii(bytes, 36, "data");
            I32(bytes, 40, count * 2);
            for (int i = 0; i < count; i++)
            {
                float v = samples[i];
                if (float.IsNaN(v)) v = 0f;
                int s = (int)Math.Round(Math.Max(-1f, Math.Min(1f, v)) * 32767.0);
                I16(bytes, 44 + i * 2, s);
            }
            return bytes;
        }
    }
}
