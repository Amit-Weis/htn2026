using System;
using System.Text;

namespace Lastseen
{
    /// <summary>
    /// 64-bit average hash of an RGBA image (8x8 luminance means, thresholded at their average), as 16 lowercase hex characters.
    /// The Worker's duplicate guard treats two hashes within 4 bits as the same scene, so this only has to be stable, not clever.
    /// </summary>
    public static class ImageHash
    {
        /// <param name="rgba">4 bytes per pixel, any row order (flipping the rows only flips the hash consistently)</param>
        public static string AHash(byte[] rgba, int width, int height)
        {
            if (rgba == null || width < 8 || height < 8 || rgba.Length < width * height * 4) return null;
            var cell = new double[64];
            for (int cy = 0; cy < 8; cy++)
            {
                int y0 = cy * height / 8, y1 = (cy + 1) * height / 8;
                for (int cx = 0; cx < 8; cx++)
                {
                    int x0 = cx * width / 8, x1 = (cx + 1) * width / 8;
                    double sum = 0;
                    int n = 0;
                    // sample every few pixels: the hash does not need every one
                    int sy = Math.Max(1, (y1 - y0) / 16), sx = Math.Max(1, (x1 - x0) / 16);
                    for (int y = y0; y < y1; y += sy)
                        for (int x = x0; x < x1; x += sx)
                        {
                            int i = (y * width + x) * 4;
                            sum += 0.299 * rgba[i] + 0.587 * rgba[i + 1] + 0.114 * rgba[i + 2];
                            n++;
                        }
                    cell[cy * 8 + cx] = n == 0 ? 0 : sum / n;
                }
            }
            double mean = 0;
            foreach (var c in cell) mean += c;
            mean /= 64;

            var sb = new StringBuilder(16);
            for (int nib = 0; nib < 16; nib++)
            {
                int v = 0;
                for (int b = 0; b < 4; b++) v = (v << 1) | (cell[nib * 4 + b] > mean ? 1 : 0);
                sb.Append("0123456789abcdef"[v]);
            }
            return sb.ToString();
        }

        /// <summary>Number of differing bits between two hashes of equal length, or -1 when they cannot be compared.</summary>
        public static int Distance(string a, string b)
        {
            if (a == null || b == null || a.Length != b.Length) return -1;
            int bits = 0;
            for (int i = 0; i < a.Length; i++)
            {
                int x = Convert.ToInt32(a[i].ToString(), 16) ^ Convert.ToInt32(b[i].ToString(), 16);
                while (x != 0)
                {
                    bits += x & 1;
                    x >>= 1;
                }
            }
            return bits;
        }
    }
}
