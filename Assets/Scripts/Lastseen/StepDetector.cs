using System;

namespace Lastseen
{
    /// <summary>
    /// Streaming accelerometer-magnitude peak detector with an adaptive threshold: a line-for-line port of StepDetector in
    /// lastseen/packages/shared/src/geometry.ts. Feed samples with Push; it returns true when a step peak is confirmed (one
    /// sample after the peak, since a peak needs its successor).
    /// </summary>
    public sealed class StepDetector
    {
        public struct Config
        {
            /// <summary>Minimum time between steps.</summary>
            public double MinIntervalMs;
            /// <summary>Absolute floor for the adaptive threshold (m/s^2 of deviation from gravity).</summary>
            public double MinThreshold;
            /// <summary>Threshold = mean + K * std of the recent deviation signal.</summary>
            public double K;

            public static Config Default { get { return new Config { MinIntervalMs = 300, MinThreshold = 0.6, K = 0.8 }; } }
        }

        readonly Config cfg;
        double gravity = 9.81;
        double prevPrev;
        double prev;
        double prevT;
        double lastStepT = double.NegativeInfinity;
        double mean;
        double variance;
        double smoothed;
        int n;

        public StepDetector() : this(Config.Default) { }

        public StepDetector(Config cfg)
        {
            this.cfg = cfg;
        }

        /// <summary>ax/ay/az in m/s^2 (including gravity), tMs monotonic milliseconds.</summary>
        public bool Push(double ax, double ay, double az, double tMs)
        {
            double mag = Math.Sqrt(ax * ax + ay * ay + az * az);
            gravity += 0.01 * (mag - gravity);
            double dev = mag - gravity;
            smoothed += 0.4 * (dev - smoothed);
            double s = smoothed;

            const double a = 0.02;
            mean += a * (s - mean);
            variance += a * (((s - mean) * (s - mean)) - variance);
            n++;

            double threshold = Math.Max(cfg.MinThreshold, mean + cfg.K * Math.Sqrt(variance));
            bool step = false;
            if (n > 3 && prev > prevPrev && prev >= s && prev > threshold && prevT - lastStepT >= cfg.MinIntervalMs)
            {
                lastStepT = prevT;
                step = true;
            }
            prevPrev = prev;
            prev = s;
            prevT = tMs;
            return step;
        }
    }
}
