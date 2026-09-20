using System;
using NUnit.Framework;

namespace Omni.Tests
{
    public class EarconTests
    {
        static int RisingZeroCrossings(float[] s)
        {
            int n = 0;
            for (int i = 1; i < s.Length; i++) if (s[i - 1] < 0f && s[i] >= 0f) n++;
            return n;
        }

        [Test]
        public void ToneHasTheRightLengthLoudnessAndPitch()
        {
            float[] t = Earcon.Tone(880, 0.12, 22050, 0.35);
            Assert.AreEqual(2646, t.Length);
            float peak = 0f;
            foreach (float v in t) peak = Math.Max(peak, Math.Abs(v));
            Assert.That(peak, Is.LessThanOrEqualTo(0.35f + 1e-4f));
            Assert.That(peak, Is.GreaterThan(0.30f), "the tone actually reaches its volume");
            // 880 Hz for 0.12 s is about 105 cycles
            Assert.That(RisingZeroCrossings(t), Is.InRange(103, 107));
        }

        [Test]
        public void ToneFadesInAndOutSoItDoesNotClick()
        {
            float[] t = Earcon.Tone(440, 0.2);
            Assert.AreEqual(0f, t[0], 1e-6f);
            Assert.That(Math.Abs(t[t.Length - 1]), Is.LessThan(0.02f));
        }

        [Test]
        public void BadInputGivesSilenceNotAnException()
        {
            Assert.AreEqual(0, Earcon.Tone(880, 0).Length);
            Assert.AreEqual(0, Earcon.Tone(880, -1).Length);
            Assert.AreEqual(0, Earcon.Tone(0, 0.1).Length);
            Assert.AreEqual(0, Earcon.Tone(double.NaN, 0.1).Length);
            Assert.AreEqual(0, Earcon.Tone(880, 0.1, 0).Length);
        }

        [Test]
        public void TheThreeCuesAreDistinct()
        {
            float[] start = Earcon.Start(), sent = Earcon.Sent(), problem = Earcon.Problem();
            Assert.Greater(start.Length, 0);
            Assert.AreEqual(2 * (int)Math.Round(0.08 * Earcon.SampleRate), sent.Length, "two notes");
            Assert.Greater(problem.Length, start.Length, "the problem tone is the longest");
            Assert.Less(RisingZeroCrossings(problem) / 0.35, RisingZeroCrossings(start) / 0.12, "and the lowest");
        }

        [Test]
        public void ConcatJoinsInOrder()
        {
            float[] joined = Earcon.Concat(new[] { 1f, 2f }, new float[0], new[] { 3f });
            Assert.AreEqual(new[] { 1f, 2f, 3f }, joined);
        }
    }

    public class AgeSpeechTests
    {
        [TestCase(0.0, "a moment ago")]
        [TestCase(29.9, "a moment ago")]
        [TestCase(30.0, "about a minute ago")]
        [TestCase(89.9, "about a minute ago")]
        [TestCase(90.0, "about 2 minutes ago")]
        [TestCase(600.0, "about 10 minutes ago")]
        [TestCase(3599.0, "about an hour ago")]
        [TestCase(3600.0, "about an hour ago")]
        [TestCase(5399.0, "about an hour ago")]
        [TestCase(5400.0, "about 2 hours ago")]
        [TestCase(10800.0, "about 3 hours ago")]
        [TestCase(86400.0, "over a day ago")]
        [TestCase(500000.0, "over a day ago")]
        public void AgoWords(double seconds, string expected)
        {
            Assert.AreEqual(expected, AgeSpeech.Ago(seconds));
        }

        [Test]
        public void UnknownAgesAreNull()
        {
            Assert.IsNull(AgeSpeech.Ago(double.NaN));
            Assert.IsNull(AgeSpeech.Ago(double.PositiveInfinity));
            Assert.IsNull(AgeSpeech.Ago(-5));
        }

        [Test]
        public void MayHaveMovedAfterFiveMinutes()
        {
            Assert.IsFalse(AgeSpeech.MayHaveMoved(0));
            Assert.IsFalse(AgeSpeech.MayHaveMoved(300));
            Assert.IsTrue(AgeSpeech.MayHaveMoved(301));
            Assert.IsFalse(AgeSpeech.MayHaveMoved(double.NaN));
        }
    }

    public class OmniErrorsTests
    {
        [TestCase(401L)]
        [TestCase(403L)]
        public void ARejectedTokenIsASettingsProblemNotAnOutage(long code)
        {
            Failure f = OmniErrors.Classify(code, "HTTP/1.1 401 Unauthorized", "unauthorized");
            Assert.AreEqual(FailureKind.Token, f.Kind);
            Assert.IsFalse(f.OmniUnavailable, "the wearer must hear about a bad token, not have it worked around");
            StringAssert.Contains("token", f.Status);
            StringAssert.Contains("token", f.Spoken.ToLowerInvariant());
        }

        [TestCase(429L)]
        [TestCase(500L)]
        [TestCase(502L)]
        [TestCase(503L)]
        public void OverLimitAndServerErrorsAreOutages(long code)
        {
            Failure f = OmniErrors.Classify(code, "", "{\"error\":\"budget\"}");
            Assert.AreEqual(FailureKind.Server, f.Kind);
            Assert.IsTrue(f.OmniUnavailable);
            Assert.IsNotEmpty(f.Spoken);
        }

        [Test]
        public void OtherClientErrorsAreNotOutages()
        {
            Failure f = OmniErrors.Classify(400, "", "{\"error\":\"send text or audioB64\"}");
            Assert.AreEqual(FailureKind.BadRequest, f.Kind);
            Assert.IsFalse(f.OmniUnavailable);
            StringAssert.Contains("send text or audioB64", f.Status);
        }

        [Test]
        public void NoResponseIsAConnectionOrTimeoutProblem()
        {
            Failure none = OmniErrors.Classify(0, "Cannot connect to destination host", "");
            Assert.AreEqual(FailureKind.NoConnection, none.Kind);
            Assert.IsTrue(none.OmniUnavailable);
            StringAssert.Contains("network", none.Spoken);

            Failure slow = OmniErrors.Classify(0, "Request timeout", null);
            Assert.AreEqual(FailureKind.Timeout, slow.Kind);
            Assert.IsTrue(slow.OmniUnavailable);
            Assert.AreEqual(FailureKind.Timeout, OmniErrors.Classify(0, "the operation timed out", "").Kind);
        }

        [Test]
        public void ALongBodyIsTrimmedAndANullOneIsHandled()
        {
            string longBody = new string('x', 500);
            Failure f = OmniErrors.Classify(500, "", longBody);
            Assert.Less(f.Status.Length, 200);
            StringAssert.EndsWith("...", f.Status);
            Assert.DoesNotThrow(() => OmniErrors.Classify(500, null, null));
        }

        [Test]
        public void AnUnreadableReplyIsNotAnOutage()
        {
            Failure f = OmniErrors.BadReply("<html>oops</html>");
            Assert.AreEqual(FailureKind.BadReply, f.Kind);
            Assert.IsFalse(f.OmniUnavailable);
            StringAssert.Contains("oops", f.Status);
        }

        [Test]
        public void EveryFailureHasSomethingToSay()
        {
            foreach (long code in new long[] { 0, 400, 401, 429, 500 })
            {
                Failure f = OmniErrors.Classify(code, "x", "y");
                Assert.IsNotEmpty(f.Spoken, "code " + code);
                Assert.IsNotEmpty(f.Status, "code " + code);
            }
        }
    }
}
