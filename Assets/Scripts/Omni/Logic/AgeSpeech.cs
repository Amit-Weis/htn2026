using System;

namespace Omni
{
    /// <summary>How long ago something was last seen, in words a wearer can take in by ear.</summary>
    public static class AgeSpeech
    {
        /// <summary>After this long the object is quite likely to have been moved, so the announcement says so.</summary>
        public const double MayHaveMovedAfterSeconds = 300.0;

        /// <summary>"a moment ago", "about a minute ago", "about 12 minutes ago", "about an hour ago", "about 3 hours ago", "over a day ago"; null when unknown.</summary>
        public static string Ago(double seconds)
        {
            if (double.IsNaN(seconds) || double.IsInfinity(seconds) || seconds < 0) return null;
            if (seconds < 30) return "a moment ago";
            if (seconds < 90) return "about a minute ago";
            if (seconds < 3600)
            {
                long minutes = (long)Math.Round(seconds / 60.0, MidpointRounding.AwayFromZero);
                return minutes >= 60 ? "about an hour ago" : "about " + minutes + " minutes ago";
            }
            if (seconds < 5400) return "about an hour ago";
            if (seconds < 86400) return "about " + (long)Math.Round(seconds / 3600.0, MidpointRounding.AwayFromZero) + " hours ago";
            return "over a day ago";
        }

        public static bool MayHaveMoved(double seconds)
        {
            return !double.IsNaN(seconds) && seconds > MayHaveMovedAfterSeconds;
        }
    }
}
