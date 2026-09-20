using System;
using System.Collections.Generic;
using System.Globalization;

namespace Omni
{
    /// <summary>
    /// What to say aloud about where something is, relative to where the wearer is looking. Pure logic (no Unity types), so it is
    /// unit-tested. Angles are degrees, positive to the RIGHT (Unity's signed angle around the up axis): 0 is straight ahead and
    /// +-180 is directly behind.
    /// </summary>
    public static class DirectionSpeech
    {
        /// <summary>Wrap any angle into (-180, 180].</summary>
        public static double Wrap(double degrees)
        {
            double a = degrees % 360.0;
            if (a > 180.0) a -= 360.0;
            else if (a <= -180.0) a += 360.0;
            return a;
        }

        /// <summary>"straight ahead", "ahead and to your left", "to your right", "behind you, to your left", "directly behind you".</summary>
        public static string Direction(double angleDeg)
        {
            if (double.IsNaN(angleDeg) || double.IsInfinity(angleDeg)) return "somewhere near you";
            double a = Wrap(angleDeg);
            double m = Math.Abs(a);
            string side = a < 0 ? "left" : "right";
            if (m <= 20) return "straight ahead";
            if (m <= 60) return "ahead and to your " + side;
            if (m <= 120) return "to your " + side;
            if (m <= 160) return "behind you, to your " + side;
            return "directly behind you";
        }

        /// <summary>"up high" or "down low" when the target is clearly above or below eye level (30 degrees or more), otherwise null.</summary>
        public static string Height(double elevationDeg)
        {
            if (double.IsNaN(elevationDeg)) return null;
            if (elevationDeg >= 30) return "up high";
            if (elevationDeg <= -30) return "down low";
            return null;
        }

        /// <summary>"less than a meter away", "about 1.5 meters away", "about 4 meters away"; null when the distance is unknown.</summary>
        public static string Distance(double meters)
        {
            if (double.IsNaN(meters) || double.IsInfinity(meters) || meters < 0) return null;
            if (meters < 1.0) return "less than a meter away";
            // half-meter steps up close, whole meters from 3 m: "about" is honest about the accuracy
            double r = meters < 3.0 ? Math.Round(meters * 2.0, MidpointRounding.AwayFromZero) / 2.0 : Math.Round(meters, MidpointRounding.AwayFromZero);
            string n = r == Math.Floor(r) ? ((int)r).ToString(CultureInfo.InvariantCulture) : r.ToString("0.0", CultureInfo.InvariantCulture);
            return "about " + n + (r == 1.0 ? " meter" : " meters") + " away";
        }

        /// <summary>The parts joined: "ahead and to your left, up high, about 3 meters away".</summary>
        public static string Where(double angleDeg, double elevationDeg, double distanceM)
        {
            var parts = new List<string> { Direction(angleDeg) };
            string h = Height(elevationDeg);
            if (h != null) parts.Add(h);
            string d = Distance(distanceM);
            if (d != null) parts.Add(d);
            return string.Join(", ", parts);
        }

        /// <summary>
        /// "It's ahead and to your left." for a position that is only a bearing: when the distance and height are not measured
        /// (fixed placement), claiming "about 3 meters away, down low" would be made up.
        /// </summary>
        public static string DirectionSentence(double angleDeg)
        {
            return "It's " + Direction(angleDeg) + ".";
        }

        /// <summary>A whole sentence to speak: "It's ahead and to your left, about 3 meters away."</summary>
        public static string Sentence(double angleDeg, double elevationDeg, double distanceM)
        {
            return "It's " + Where(angleDeg, elevationDeg, distanceM) + ".";
        }
    }
}
