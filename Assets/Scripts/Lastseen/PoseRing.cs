using System.Collections.Generic;

namespace Lastseen
{
    /// <summary>One dead-reckoned pose of the chest-mounted phone. Same fields and units as the Worker's PoseSchema.</summary>
    public struct PoseSample
    {
        /// <summary>epoch milliseconds (wall clock), never uptime</summary>
        public long TMs;
        /// <summary>meters east of the session origin</summary>
        public double X;
        /// <summary>meters north of the session origin</summary>
        public double Y;
        /// <summary>degrees clockwise from north of the camera-forward direction</summary>
        public double HeadingDeg;
        public int Steps;
        /// <summary>0..1, decays with steps and time since the session origin</summary>
        public double Confidence;
        /// <summary>true when no step was detected in the last 1.5 s</summary>
        public bool Stationary;
    }

    /// <summary>Time-ordered ring of recent poses. It backs the candidate's poseSlice and the "was the wearer walking" check.</summary>
    public sealed class PoseRing
    {
        readonly List<PoseSample> items = new List<PoseSample>();
        readonly long keepMs;

        public PoseRing(long keepMs = 60000)
        {
            this.keepMs = keepMs;
        }

        public int Count { get { return items.Count; } }

        public bool TryGetLatest(out PoseSample latest)
        {
            if (items.Count == 0)
            {
                latest = default(PoseSample);
                return false;
            }
            latest = items[items.Count - 1];
            return true;
        }

        public void Add(PoseSample s)
        {
            if (items.Count > 0 && s.TMs <= items[items.Count - 1].TMs) return; // keep strictly time-ordered
            items.Add(s);
            long cutoff = s.TMs - keepMs;
            int drop = 0;
            while (drop < items.Count && items[drop].TMs < cutoff) drop++;
            if (drop > 0) items.RemoveRange(0, drop);
        }

        /// <summary>Samples with fromMs &lt;= t &lt;= toMs, oldest first, thinned to at most maxCount (the newest is always kept).</summary>
        public List<PoseSample> Slice(long fromMs, long toMs, int maxCount = 100)
        {
            var all = new List<PoseSample>();
            foreach (var s in items) if (s.TMs >= fromMs && s.TMs <= toMs) all.Add(s);
            if (all.Count <= maxCount || maxCount < 2) return all;
            var thinned = new List<PoseSample>(maxCount);
            double stride = (all.Count - 1) / (double)(maxCount - 1);
            for (int i = 0; i < maxCount; i++) thinned.Add(all[(int)System.Math.Round(i * stride)]);
            return thinned;
        }

        /// <summary>Fraction of samples in [fromMs, toMs] where the wearer was not stationary (0 when there are none).</summary>
        public double MovingFraction(long fromMs, long toMs)
        {
            int n = 0, moving = 0;
            foreach (var s in items)
            {
                if (s.TMs < fromMs || s.TMs > toMs) continue;
                n++;
                if (!s.Stationary) moving++;
            }
            return n == 0 ? 0 : moving / (double)n;
        }
    }
}
