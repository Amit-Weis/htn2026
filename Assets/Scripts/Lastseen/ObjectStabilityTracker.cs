using System;
using System.Collections.Generic;

namespace Lastseen
{
    /// <summary>A normalized box: origin top-left of the image, x/y/w/h in [0, 1]. Same convention as the Worker's Detection.bbox.</summary>
    public struct Box
    {
        public float X, Y, W, H;

        public Box(float x, float y, float w, float h)
        {
            X = x;
            Y = y;
            W = w;
            H = h;
        }

        public float CenterX { get { return X + W / 2f; } }
        public float CenterY { get { return Y + H / 2f; } }

        /// <summary>From pixel corners (x1,y1)-(x2,y2), origin top-left, in an image of the given size.</summary>
        public static Box FromCorners(float x1, float y1, float x2, float y2, int imageW, int imageH)
        {
            if (imageW <= 0 || imageH <= 0) return new Box(0, 0, 0, 0);
            float l = Clamp01(Math.Min(x1, x2) / imageW), t = Clamp01(Math.Min(y1, y2) / imageH);
            float r = Clamp01(Math.Max(x1, x2) / imageW), b = Clamp01(Math.Max(y1, y2) / imageH);
            return new Box(l, t, r - l, b - t);
        }

        static float Clamp01(float v)
        {
            return v < 0f ? 0f : (v > 1f ? 1f : v);
        }

        public static float Iou(Box a, Box b)
        {
            float ix = Math.Max(0f, Math.Min(a.X + a.W, b.X + b.W) - Math.Max(a.X, b.X));
            float iy = Math.Max(0f, Math.Min(a.Y + a.H, b.Y + b.H) - Math.Max(a.Y, b.Y));
            float inter = ix * iy;
            float union = a.W * a.H + b.W * b.H - inter;
            return union <= 0f ? 0f : inter / union;
        }
    }

    public struct Detection
    {
        public string Label;
        public float Score;
        public Box Box;

        public Detection(string label, float score, Box box)
        {
            Label = label;
            Score = score;
            Box = box;
        }
    }

    public sealed class PlacedEvent
    {
        public string Label;
        public float Score;
        public Box Box;
        public long TMs;
        /// <summary>true when the same still object is being re-logged on the refresh timer</summary>
        public bool Refresh;
    }

    public sealed class StabilityConfig
    {
        /// <summary>How long an object must hold roughly the same place before it counts as placed.</summary>
        public double HoldSeconds = 3.5;
        /// <summary>Largest movement of the box centre (fraction of the image) that still counts as the same place.</summary>
        public float MoveTolerance = 0.04f;
        /// <summary>Boxes of the same label overlap at least this much to be the same track.</summary>
        public float MinIou = 0.4f;
        /// <summary>A track that is not seen for this long is dropped; if the object reappears it is a new placement.</summary>
        public double LostGraceSeconds = 1.0;
        /// <summary>A still object that stays in view is re-logged this often so its "last seen" stays current (0 = never).</summary>
        public double RefreshSeconds = 180;
        /// <summary>Never fire for the same label more often than this (the Worker also has a cooldown).</summary>
        public double SameLabelGapSeconds = 20;
        public float MinScore = 0.4f;
        /// <summary>Labels that are never "placed" (people walk into view; hands are not objects).</summary>
        public HashSet<string> IgnoreLabels = new HashSet<string>(StringComparer.OrdinalIgnoreCase) { "person" };
    }

    /// <summary>
    /// The plan's "stationary-object polling" rule: an object is logged once its detection holds roughly the same place for N
    /// seconds. Detections are tracked by label and box overlap. The camera is chest-mounted, so screen positions only mean
    /// something while the wearer is standing still: every track is dropped the moment the wearer moves.
    /// Pure logic (no Unity types) so it is unit-tested.
    /// </summary>
    public sealed class ObjectStabilityTracker
    {
        sealed class Track
        {
            public string Label;
            public Box Box;
            public Box Anchor;
            public long StillSinceMs;
            public long LastSeenMs;
            public bool Fired;
            public long FiredAtMs;
            public float Score;
        }

        readonly StabilityConfig cfg;
        readonly List<Track> tracks = new List<Track>();
        readonly Dictionary<string, long> lastFireByLabel = new Dictionary<string, long>(StringComparer.OrdinalIgnoreCase);

        public event Action<PlacedEvent> Placed;

        public ObjectStabilityTracker() : this(new StabilityConfig()) { }

        public ObjectStabilityTracker(StabilityConfig cfg)
        {
            this.cfg = cfg;
        }

        public int ActiveTracks { get { return tracks.Count; } }

        public void Reset()
        {
            tracks.Clear();
            lastFireByLabel.Clear();
        }

        /// <summary>One detection pass. tMs is epoch ms; detections are in the current frame, normalized.</summary>
        public void Update(long tMs, IReadOnlyList<Detection> detections, bool wearerStationary)
        {
            if (!wearerStationary)
            {
                tracks.Clear();
                return;
            }

            long lostMs = (long)(cfg.LostGraceSeconds * 1000);
            tracks.RemoveAll(t => tMs - t.LastSeenMs > lostMs);

            var matched = new HashSet<Track>();
            var fresh = new List<Track>();
            for (int i = 0; detections != null && i < detections.Count; i++)
            {
                var d = detections[i];
                if (d.Score < cfg.MinScore || string.IsNullOrEmpty(d.Label) || cfg.IgnoreLabels.Contains(d.Label)) continue;

                Track best = null;
                float bestIou = cfg.MinIou;
                foreach (var t in tracks)
                {
                    if (matched.Contains(t) || !string.Equals(t.Label, d.Label, StringComparison.OrdinalIgnoreCase)) continue;
                    float iou = Box.Iou(t.Box, d.Box);
                    if (iou >= bestIou)
                    {
                        best = t;
                        bestIou = iou;
                    }
                }

                if (best == null)
                {
                    fresh.Add(new Track { Label = d.Label, Box = d.Box, Anchor = d.Box, StillSinceMs = tMs, LastSeenMs = tMs, Score = d.Score });
                    continue;
                }

                matched.Add(best);
                best.Box = d.Box;
                best.LastSeenMs = tMs;
                best.Score = d.Score;
                float dx = d.Box.CenterX - best.Anchor.CenterX, dy = d.Box.CenterY - best.Anchor.CenterY;
                if (Math.Sqrt(dx * dx + dy * dy) > cfg.MoveTolerance)
                {
                    // it moved (or someone is still setting it down): start counting again from here
                    best.Anchor = d.Box;
                    best.StillSinceMs = tMs;
                    best.Fired = false;
                }
                else if (!best.Fired && tMs - best.StillSinceMs >= cfg.HoldSeconds * 1000)
                {
                    TryFire(best, tMs, false);
                }
                else if (best.Fired && cfg.RefreshSeconds > 0 && tMs - best.FiredAtMs >= cfg.RefreshSeconds * 1000)
                {
                    TryFire(best, tMs, true);
                }
            }
            tracks.AddRange(fresh);
        }

        void TryFire(Track t, long tMs, bool refresh)
        {
            long last;
            if (lastFireByLabel.TryGetValue(t.Label, out last) && tMs - last < cfg.SameLabelGapSeconds * 1000) return;
            t.Fired = true;
            t.FiredAtMs = tMs;
            lastFireByLabel[t.Label] = tMs;
            var handler = Placed;
            if (handler != null) handler(new PlacedEvent { Label = t.Label, Score = t.Score, Box = t.Box, TMs = tMs, Refresh = refresh });
        }
    }
}
