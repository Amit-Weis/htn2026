using System;

namespace Lastseen
{
    /// <summary>
    /// Session-frame geometry, ported from lastseen/packages/shared/src/geometry.ts (the reference). The Unity EditMode tests replay
    /// lastseen/packages/shared/test-vectors/geometry.json, which that TypeScript generates, so the two cannot drift apart silently.
    ///
    /// Frame: meters, x east, y north, origin where the session started. Heading: degrees clockwise from north, [0, 360).
    /// Unity mapping: session x = Unity x, session y = Unity z, heading = Unity yaw (rotation about +y, clockwise seen from above).
    /// Everything is double so results match the TypeScript bit for bit.
    /// </summary>
    public static class Geo
    {
        public const double Deg = Math.PI / 180.0;
        /// <summary>A head pose older than this is ignored and the chest heading is used instead.</summary>
        public const long HeadPoseFreshMs = 300;

        public static double Wrap180(double deg)
        {
            double r = ((deg % 360.0) + 360.0) % 360.0;
            if (r > 180.0) r -= 360.0;
            return r;
        }

        public static double Wrap360(double deg)
        {
            return ((deg % 360.0) + 360.0) % 360.0;
        }

        /// <summary>Azimuth (degrees clockwise from north) of the vector (dx east, dy north).</summary>
        public static double AzimuthDeg(double dx, double dy)
        {
            return Wrap360(Math.Atan2(dx, dy) / Deg);
        }

        /// <summary>Pedestrian dead reckoning: one step of length L along the heading.</summary>
        public static void PdrStep(double x, double y, double headingDeg, double stepLengthM, out double nx, out double ny)
        {
            double h = headingDeg * Deg;
            nx = x + stepLengthM * Math.Sin(h);
            ny = y + stepLengthM * Math.Cos(h);
        }

        /// <summary>Arrow angle = wrap180(bearing to target - heading): 0 straight ahead, positive to the right.</summary>
        public static double ArrowAngleFromHeading(double targetX, double targetY, double posX, double posY, double headingDeg)
        {
            return Wrap180(AzimuthDeg(targetX - posX, targetY - posY) - headingDeg);
        }

        /// <summary>Offset that makes the glasses yaw agree with the chest heading right now (wearer looking straight ahead).</summary>
        public static double CalibrateHeadOffset(double chestHeadingDeg, double headYawDeg)
        {
            return Wrap180(chestHeadingDeg - headYawDeg);
        }

        /// <summary>The heading the wearer is looking along: the glasses yaw plus offset when fresh (0 &lt;= age &lt; 300 ms), else the chest heading.</summary>
        public static double HeadHeading(double chestHeadingDeg, bool hasHead, long headT, double headYawDeg, double headOffsetDeg, long nowMs)
        {
            if (hasHead)
            {
                long age = nowMs - headT;
                if (age >= 0 && age < HeadPoseFreshMs) return Wrap360(headYawDeg + headOffsetDeg);
            }
            return Wrap360(chestHeadingDeg);
        }

        public static double ArrowAngle(double targetX, double targetY, double posX, double posY, double chestHeadingDeg,
            bool hasHead, long headT, double headYawDeg, double headOffsetDeg, long nowMs)
        {
            double h = HeadHeading(chestHeadingDeg, hasHead, headT, headYawDeg, headOffsetDeg, nowMs);
            return Wrap180(AzimuthDeg(targetX - posX, targetY - posY) - h);
        }

        /// <summary>Exponential low-pass on an angle (smooths the wrapped difference).</summary>
        public static double SmoothAngle(double prevDeg, double targetDeg, double alpha)
        {
            return Wrap180(prevDeg + alpha * Wrap180(targetDeg - prevDeg));
        }

        public const double DefaultObjectDistanceM = 0.8;
        public const double MinObjectDistanceM = 0.3;
        public const double MaxObjectDistanceM = 3.0;

        /// <summary>OMNI distance estimate clipped to [0.3, 3] m; missing or invalid falls back to 0.8 m.</summary>
        public static double ClipDistance(double? d)
        {
            if (!d.HasValue || double.IsNaN(d.Value) || double.IsInfinity(d.Value) || d.Value <= 0) return DefaultObjectDistanceM;
            return Math.Min(MaxObjectDistanceM, Math.Max(MinObjectDistanceM, d.Value));
        }

        /// <summary>Pose confidence decays with steps and time since the last anchor.</summary>
        public static double PoseConfidence(double stepsSinceAnchor, double secSinceAnchor, double stepScale = 120, double timeScale = 600)
        {
            return Math.Exp(-Math.Max(0, stepsSinceAnchor) / stepScale) * Math.Exp(-Math.Max(0, secSinceAnchor) / timeScale);
        }

        /// <summary>"arrow" when the position is trusted and in range, otherwise the coarse "zone" mode.</summary>
        public static string ChooseMode(double confidence, double distance, double minConfidence = 0.35, double maxRangeM = 15)
        {
            return confidence < minConfidence || distance > maxRangeM ? "zone" : "arrow";
        }

        public struct DepthPosition
        {
            public double X, Y;
            /// <summary>height relative to the camera, meters, positive up (camera assumed level)</summary>
            public double ZUp;
            /// <summary>horizontal range from the camera, meters</summary>
            public double RangeM;
        }

        /// <summary>
        /// Object position from a measured depth (pinhole, camera level). uNorm/vNorm: box centre in [0,1] from the top-left;
        /// aspect = width / height; hfovDeg = horizontal FOV of that image. forward = (sin h, cos h), right = (cos h, -sin h).
        /// </summary>
        public static DepthPosition ObjectPositionFromDepth(double px, double py, double headingDeg, double uNorm, double vNorm,
            double depthM, double hfovDeg, double aspect)
        {
            double t = Math.Tan(hfovDeg * Deg / 2.0);
            double right = (2.0 * uNorm - 1.0) * t * depthM;
            double zUp = -(2.0 * vNorm - 1.0) * (t / aspect) * depthM;
            double h = headingDeg * Deg;
            return new DepthPosition
            {
                X = px + depthM * Math.Sin(h) + right * Math.Cos(h),
                Y = py + depthM * Math.Cos(h) - right * Math.Sin(h),
                ZUp = zUp,
                RangeM = Math.Sqrt(depthM * depthM + right * right),
            };
        }

        /// <summary>
        /// Azimuth (degrees clockwise from the frame's +z axis) of a rotation's forward vector, i.e. the yaw of where a camera
        /// with that orientation looks, ignoring pitch and roll. Quaternion components (x, y, z, w) are Unity's.
        /// </summary>
        public static double YawOfForward(double qx, double qy, double qz, double qw)
        {
            // forward = q * (0, 0, 1)
            double fx = 2.0 * (qx * qz + qw * qy);
            double fz = 1.0 - 2.0 * (qx * qx + qy * qy);
            return Wrap360(Math.Atan2(fx, fz) / Deg);
        }
    }
}
