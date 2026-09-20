using System;
using Lastseen;
using UnityEngine;
using UnityEngine.InputSystem;

namespace LastseenApp
{
    /// <summary>
    /// Chest-mounted dead reckoning: the accelerometer's step peaks advance the position one step at a time along a heading from
    /// the OS's fused attitude (accelerometer + gyroscope + magnetometer, Android's rotation vector). This is not double
    /// integration of acceleration, which drifts by meters within seconds; steps drift by a few percent of distance walked.
    /// The math is in Lastseen.Geo / StepDetector (unit-tested against the TypeScript reference); this component only feeds it
    /// from the Input System sensors, because the project's Active Input Handling is "Input System" (legacy Input.* would throw).
    ///
    /// Frame: session origin (0, 0) where the app started, x east, y north. Heading: degrees clockwise from north.
    /// The step length is a guess (0.7 m); calibrate it by walking a known distance (see docs/unity-client.md).
    /// </summary>
    public sealed class DeadReckoningTracker : MonoBehaviour
    {
        [Tooltip("Meters per step. Measure: walk 10 m, divide by the step count shown on screen.")]
        public double stepLengthM = 0.7;
        [Tooltip("Take the heading from the glasses/AR camera yaw instead of the phone's attitude sensor (fallback if the sensor is missing).")]
        public bool useHeadYawAsHeading;
        [Tooltip("Flip the heading direction. Turn right: the heading must INCREASE. If it decreases, tick this.")]
        public bool invertHeading;
        [Tooltip("The Input System's AttitudeSensor is documented as the same as Gyroscope.attitude, which needs the usual right-handed to Unity conversion. Untick if the device already reports Unity's frame.")]
        public bool convertAttitude = true;
        [Min(1f)] public float poseHz = 5f;

        public PoseRing Ring { get; private set; }
        public PoseSample Current { get; private set; }
        public double RawHeadingDeg { get; private set; }
        public string Status { get; private set; }

        readonly StepDetector detector = new StepDetector();
        Accelerometer accel;
        AttitudeSensor attitude;
        double x, y;
        int steps;
        long lastStepMs = long.MinValue / 2;
        long startMs;
        double lastPushMonoMs = double.NegativeInfinity;
        double nextPoseMonoMs;
        double accelScale;
        int scaleSamples;
        double scaleSum;
        double heading;

        public static long NowMs()
        {
            return DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        }

        void Awake()
        {
            Ring = new PoseRing(60000);
            Current = new PoseSample { TMs = NowMs(), Confidence = 1, Stationary = true };
        }

        void OnEnable()
        {
            startMs = NowMs();
            TryBind();
        }

        void OnDisable()
        {
            if (accel != null) InputSystem.DisableDevice(accel);
            if (attitude != null) InputSystem.DisableDevice(attitude);
        }

        void TryBind()
        {
            if (accel == null && Accelerometer.current != null)
            {
                accel = Accelerometer.current;
                InputSystem.EnableDevice(accel);
                try { accel.samplingFrequency = 50f; } catch (NotSupportedException) { }
            }
            if (attitude == null && AttitudeSensor.current != null)
            {
                attitude = AttitudeSensor.current;
                InputSystem.EnableDevice(attitude);
            }
        }

        /// <summary>Zero the position and (optionally) the step count: a new session origin where the wearer stands now.</summary>
        public void ResetOrigin()
        {
            x = 0;
            y = 0;
            steps = 0;
            startMs = NowMs();
        }

        /// <summary>The wearer just walked distanceM in a straight line since ResetOrigin: stepLength = distance / steps.</summary>
        public bool CalibrateStepLength(double distanceM)
        {
            if (steps < 5 || distanceM <= 0) return false;
            double l = distanceM / steps;
            if (l < 0.3 || l > 1.5) return false;
            stepLengthM = l;
            return true;
        }

        void Update()
        {
            TryBind();
            double mono = Time.realtimeSinceStartupAsDouble * 1000.0;
            long now = NowMs();

            heading = ReadHeading(heading);

            if (accel != null && mono - lastPushMonoMs >= 25)
            {
                lastPushMonoMs = mono;
                Vector3 a = accel.acceleration.ReadValue();
                if (accelScale <= 0)
                {
                    // the Input System may report g or m/s^2 depending on the platform: measure it from the first samples
                    scaleSum += a.magnitude;
                    if (++scaleSamples >= 20) accelScale = scaleSum / scaleSamples < 3.0 ? 9.81 : 1.0;
                }
                else if (detector.Push(a.x * accelScale, a.y * accelScale, a.z * accelScale, mono))
                {
                    double nx, ny;
                    Geo.PdrStep(x, y, heading, stepLengthM, out nx, out ny);
                    x = nx;
                    y = ny;
                    steps++;
                    lastStepMs = now;
                }
            }

            if (mono >= nextPoseMonoMs)
            {
                nextPoseMonoMs = mono + 1000.0 / poseHz;
                Current = new PoseSample
                {
                    TMs = now,
                    X = x,
                    Y = y,
                    HeadingDeg = heading,
                    Steps = steps,
                    Confidence = Geo.PoseConfidence(steps, (now - startMs) / 1000.0),
                    Stationary = now - lastStepMs > 1500,
                };
                Ring.Add(Current);
            }

            Status = string.Format("pose {0:0.0}, {1:0.0} m  heading {2:0}°  steps {3}  {4}{5}",
                x, y, heading, steps, Current.Stationary ? "still" : "walking",
                attitude == null && !useHeadYawAsHeading ? "  (no attitude sensor: heading is the AR camera's)" : "");
        }

        double ReadHeading(double previous)
        {
            double raw;
            if (!useHeadYawAsHeading && attitude != null)
            {
                Quaternion q = attitude.attitude.ReadValue();
                if (convertAttitude) q = Quaternion.Euler(90f, 0f, 0f) * new Quaternion(-q.x, -q.y, q.z, q.w);
                raw = Geo.YawOfForward(q.x, q.y, q.z, q.w);
            }
            else
            {
                Camera cam = Camera.main;
                if (cam == null) return previous;
                raw = cam.transform.eulerAngles.y;
            }
            RawHeadingDeg = raw;
            return Geo.Wrap360(invertHeading ? -raw : raw);
        }
    }
}
