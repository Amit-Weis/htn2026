using System;

namespace Lastseen
{
    public sealed class WavData
    {
        /// <summary>interleaved samples in [-1, 1]</summary>
        public float[] Samples;
        public int SampleRate;
        public int Channels;
    }

    /// <summary>Decodes 16-bit PCM WAV, which is what the Worker's speak() returns (24 kHz mono). Anything else is rejected with a reason.</summary>
    public static class WavDecoder
    {
        static uint U32(byte[] b, int at)
        {
            return (uint)(b[at] | (b[at + 1] << 8) | (b[at + 2] << 16) | (b[at + 3] << 24));
        }

        static int U16(byte[] b, int at)
        {
            return b[at] | (b[at + 1] << 8);
        }

        static bool Tag(byte[] b, int at, string tag)
        {
            for (int i = 0; i < 4; i++) if (b[at + i] != tag[i]) return false;
            return true;
        }

        public static bool TryDecode(byte[] wav, out WavData data, out string error)
        {
            data = null;
            error = null;
            if (wav == null || wav.Length < 44 || !Tag(wav, 0, "RIFF") || !Tag(wav, 8, "WAVE"))
            {
                error = "not a RIFF/WAVE file";
                return false;
            }

            int channels = 0, rate = 0, bits = 0, format = 0;
            int pos = 12;
            while (pos + 8 <= wav.Length)
            {
                uint size = U32(wav, pos + 4);
                int body = pos + 8;
                if (Tag(wav, pos, "fmt ") && body + 16 <= wav.Length)
                {
                    format = U16(wav, body);
                    channels = U16(wav, body + 2);
                    rate = (int)U32(wav, body + 4);
                    bits = U16(wav, body + 14);
                }
                else if (Tag(wav, pos, "data"))
                {
                    if (format != 1 || bits != 16 || channels < 1 || rate <= 0)
                    {
                        error = "only 16-bit PCM WAV is supported (format " + format + ", " + bits + " bits)";
                        return false;
                    }
                    // a streamed WAV may claim a size of 0 or 0xFFFFFFFF: trust the file length instead
                    long avail = wav.Length - body;
                    long len = (size == 0 || size > avail) ? avail : size;
                    int count = (int)(len / 2);
                    count -= count % channels;
                    var samples = new float[count];
                    for (int i = 0; i < count; i++)
                    {
                        short s = (short)(wav[body + 2 * i] | (wav[body + 2 * i + 1] << 8));
                        samples[i] = s / 32768f;
                    }
                    data = new WavData { Samples = samples, SampleRate = rate, Channels = channels };
                    return true;
                }
                long next = (long)body + size + (size & 1);
                if (next > wav.Length) break;
                pos = (int)next;
            }
            error = "no data chunk";
            return false;
        }
    }
}
