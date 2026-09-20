using System;
using System.Collections.Generic;
using Newtonsoft.Json.Linq;
using NUnit.Framework;

namespace Lastseen.Tests
{
    public class StabilityTrackerTests
    {
        const long T0 = 1_800_000_000_000;
        static readonly Box KeysBox = new Box(0.5f, 0.5f, 0.1f, 0.08f);

        static List<Detection> One(string label, Box b, float score = 0.9f)
        {
            return new List<Detection> { new Detection(label, score, b) };
        }

        /// <summary>Runs the tracker at 2.5 Hz for `seconds`, returns the events it fired.</summary>
        static List<PlacedEvent> Run(ObjectStabilityTracker tr, long start, double seconds, Func<double, List<Detection>> at, bool stationary = true)
        {
            var events = new List<PlacedEvent>();
            Action<PlacedEvent> h = e => events.Add(e);
            tr.Placed += h;
            for (double s = 0; s <= seconds + 1e-9; s += 0.4) tr.Update(start + (long)(s * 1000), at(s), stationary);
            tr.Placed -= h;
            return events;
        }

        [Test]
        public void AnObjectThatHoldsStillFiresOnceAfterTheHoldTime()
        {
            var tr = new ObjectStabilityTracker();
            var ev = Run(tr, T0, 10, s => One("keys", KeysBox));
            Assert.AreEqual(1, ev.Count);
            Assert.AreEqual("keys", ev[0].Label);
            Assert.IsFalse(ev[0].Refresh);
            Assert.GreaterOrEqual(ev[0].TMs - T0, 3500);
            Assert.Less(ev[0].TMs - T0, 4200);
        }

        [Test]
        public void NothingFiresBeforeTheHoldTime()
        {
            var ev = Run(new ObjectStabilityTracker(), T0, 3.0, s => One("keys", KeysBox));
            Assert.AreEqual(0, ev.Count);
        }

        [Test]
        public void AnObjectThatKeepsMovingNeverFires()
        {
            var ev = Run(new ObjectStabilityTracker(), T0, 20, s => One("cup", new Box(0.2f + (float)(s * 0.02), 0.5f, 0.1f, 0.08f)));
            Assert.AreEqual(0, ev.Count);
        }

        [Test]
        public void SettlingAfterAMoveStartsTheClockAgain()
        {
            // moves for 5 s, then holds still: the clock starts at the settle point, not at the first sighting
            var ev = Run(new ObjectStabilityTracker(), T0, 12, s => One("cup", s < 5 ? new Box(0.2f + (float)(s * 0.03), 0.5f, 0.1f, 0.08f) : new Box(0.35f, 0.5f, 0.1f, 0.08f)));
            Assert.AreEqual(1, ev.Count);
            Assert.GreaterOrEqual(ev[0].TMs - T0, 5000 + 3400);
        }

        [Test]
        public void EverythingIsIgnoredWhileTheWearerWalks()
        {
            var tr = new ObjectStabilityTracker();
            var ev = Run(tr, T0, 15, s => One("keys", KeysBox), stationary: false);
            Assert.AreEqual(0, ev.Count);
            Assert.AreEqual(0, tr.ActiveTracks);
        }

        [Test]
        public void WalkingResetsTheClock()
        {
            var tr = new ObjectStabilityTracker();
            var events = new List<PlacedEvent>();
            tr.Placed += events.Add;
            for (double s = 0; s <= 3.0; s += 0.4) tr.Update(T0 + (long)(s * 1000), One("keys", KeysBox), true);
            tr.Update(T0 + 3200, One("keys", KeysBox), false); // a step
            for (double s = 3.6; s <= 6.0; s += 0.4) tr.Update(T0 + (long)(s * 1000), One("keys", KeysBox), true);
            Assert.AreEqual(0, events.Count, "3 s + step + 2.4 s is not 3.5 s of stillness");
        }

        [Test]
        public void LowScoreAndPeopleAreIgnored()
        {
            Assert.AreEqual(0, Run(new ObjectStabilityTracker(), T0, 10, s => One("keys", KeysBox, 0.2f)).Count);
            Assert.AreEqual(0, Run(new ObjectStabilityTracker(), T0, 10, s => One("person", KeysBox)).Count);
        }

        [Test]
        public void ARemovedObjectThatComesBackIsALaterPlacementButNotBeforeTheLabelGap()
        {
            var cfg = new StabilityConfig { SameLabelGapSeconds = 20 };
            var tr = new ObjectStabilityTracker(cfg);
            var ev = Run(tr, T0, 40, s => (s < 8 || s > 12) ? One("keys", KeysBox) : new List<Detection>());
            // fires at ~4 s; disappears 8-12 s; the new track would be ready at ~16 s but the same-label gap holds it until 24 s
            Assert.AreEqual(2, ev.Count);
            Assert.GreaterOrEqual(ev[1].TMs - ev[0].TMs, 20000);
        }

        [Test]
        public void ADifferentLabelIsNotHeldBackByTheGap()
        {
            var tr = new ObjectStabilityTracker();
            var ev = Run(tr, T0, 10, s => new List<Detection> { new Detection("keys", 0.9f, KeysBox), new Detection("cup", 0.9f, new Box(0.1f, 0.1f, 0.1f, 0.1f)) });
            Assert.AreEqual(2, ev.Count);
        }

        [Test]
        public void AStillObjectIsRefreshedOnTheRefreshTimer()
        {
            var cfg = new StabilityConfig { RefreshSeconds = 30, SameLabelGapSeconds = 5 };
            var ev = Run(new ObjectStabilityTracker(cfg), T0, 70, s => One("keys", KeysBox));
            Assert.AreEqual(3, ev.Count); // ~4 s, ~34 s, ~64 s
            Assert.IsTrue(ev[1].Refresh);
        }

        [Test]
        public void TwoObjectsOfTheSameLabelAreTrackedSeparately()
        {
            var cfg = new StabilityConfig { SameLabelGapSeconds = 0 };
            var ev = Run(new ObjectStabilityTracker(cfg), T0, 6, s => new List<Detection> { new Detection("cup", 0.9f, new Box(0.1f, 0.1f, 0.1f, 0.1f)), new Detection("cup", 0.9f, new Box(0.7f, 0.6f, 0.1f, 0.1f)) });
            Assert.AreEqual(2, ev.Count);
        }

        [Test]
        public void BoxHelpers()
        {
            var b = Box.FromCorners(64, 48, 192, 144, 640, 480);
            Assert.AreEqual(0.1f, b.X, 1e-6);
            Assert.AreEqual(0.1f, b.Y, 1e-6);
            Assert.AreEqual(0.2f, b.W, 1e-6);
            Assert.AreEqual(0.2f, b.H, 1e-6);
            Assert.AreEqual(1f, Box.Iou(b, b), 1e-6);
            Assert.AreEqual(0f, Box.Iou(b, new Box(0.5f, 0.5f, 0.1f, 0.1f)), 1e-6);
            var clamped = Box.FromCorners(-10, -10, 700, 500, 640, 480);
            Assert.AreEqual(0f, clamped.X);
            Assert.AreEqual(1f, clamped.W, 1e-6);
        }
    }

    public class PoseRingTests
    {
        static PoseSample At(long t, bool stationary = true) { return new PoseSample { TMs = t, Stationary = stationary }; }

        [Test]
        public void KeepsOrderDropsOldAndThins()
        {
            var ring = new PoseRing(1000);
            for (long t = 0; t <= 3000; t += 100) ring.Add(At(t));
            ring.Add(At(2500)); // out of order: ignored
            Assert.AreEqual(11, ring.Count); // 2000..3000
            var slice = ring.Slice(2000, 3000, 4);
            Assert.AreEqual(4, slice.Count);
            Assert.AreEqual(2000, slice[0].TMs);
            Assert.AreEqual(3000, slice[3].TMs);
            PoseSample latest;
            Assert.IsTrue(ring.TryGetLatest(out latest));
            Assert.AreEqual(3000, latest.TMs);
        }

        [Test]
        public void MovingFraction()
        {
            var ring = new PoseRing();
            for (long t = 0; t < 1000; t += 100) ring.Add(At(t, stationary: t >= 500));
            Assert.AreEqual(0.5, ring.MovingFraction(0, 999), 1e-9);
            Assert.AreEqual(0, ring.MovingFraction(5000, 6000), 1e-9);
        }
    }

    public class PayloadTests
    {
        static FrameData Frame(long t, string hash = "0f0f0f0f0f0f0f0f") { return new FrameData { TMs = t, W = 640, H = 480, Hash = hash, Jpeg = new byte[] { 1, 2, 3, 4 } }; }
        static PoseSample Pose(long t) { return new PoseSample { TMs = t, X = 1.23456789, Y = -2, HeadingDeg = -10, Steps = 5, Confidence = 1.5, Stationary = true }; }

        [Test]
        public void IngestHasTheWorkersShapeAndOmitsWhatIsAbsent()
        {
            var json = Payloads.BuildIngest(1_800_000_000_000, "detector", new List<FrameData> { Frame(1) }, null, null, null, new List<PoseSample> { Pose(1) }, 65);
            var o = JObject.Parse(json);
            Assert.AreEqual("detector", (string)o["trigger"]);
            Assert.AreEqual(65.0, (double)o["hfovDeg"], 1e-9);
            Assert.AreEqual(1, ((JArray)o["frames"]).Count);
            Assert.AreEqual("AQIDBA==", (string)o["frames"][0]["jpegBase64"]);
            Assert.AreEqual(640, (int)o["frames"][0]["w"]);
            Assert.IsNull(o["detections"]);
            Assert.IsNull(o["stereo"]);
            Assert.IsNull(o["stillFrame"]);
            Assert.IsNull(o["type"], "the HTTP body has no WebSocket type tag");
            // the pose is normalized: heading wrapped to [0,360), confidence clamped to 1, rounded to 4 decimals
            Assert.AreEqual(350.0, (double)o["poseSlice"][0]["headingDeg"], 1e-9);
            Assert.AreEqual(1.0, (double)o["poseSlice"][0]["confidence"], 1e-9);
            Assert.AreEqual(1.2346, (double)o["poseSlice"][0]["x"], 1e-9);
        }

        [Test]
        public void IngestCarriesDetectionsAndAStereoPairWithoutZeroedOptionals()
        {
            var dets = new List<IList<Detection>> { new List<Detection> { new Detection("keys", 0.87f, new Box(0.6f, 0.5f, 0.2f, 0.15f)) } };
            var stereo = new StereoData { Jpeg = new byte[] { 9, 9 } };
            var o = JObject.Parse(Payloads.BuildIngest(1, "detector", new List<FrameData> { Frame(1) }, dets, null, stereo, new List<PoseSample>(), 65));
            Assert.AreEqual("keys", (string)o["detections"][0][0]["label"]);
            Assert.AreEqual(4, ((JArray)o["detections"][0][0]["bbox"]).Count);
            Assert.AreEqual(0.6, (double)o["detections"][0][0]["bbox"][0], 1e-6);
            Assert.AreEqual("CQk=", (string)o["stereo"]["jpegBase64"]);
            Assert.IsNull(o["stereo"]["baselineM"], "an unset baseline must be absent: the Worker rejects 0");
            Assert.IsNull(o["stereo"]["swap"]);

            stereo.BaselineM = 0.065;
            stereo.Swap = true;
            o = JObject.Parse(Payloads.BuildIngest(1, "detector", new List<FrameData> { Frame(1) }, null, null, stereo, null, 65));
            Assert.AreEqual(0.065, (double)o["stereo"]["baselineM"], 1e-9);
            Assert.IsTrue((bool)o["stereo"]["swap"]);
        }

        [Test]
        public void IngestRejectsWhatTheWorkerWouldReject()
        {
            Assert.Throws<ArgumentException>(() => Payloads.BuildIngest(1, "detector", new List<FrameData>(), null, null, null, null, 65));
            Assert.Throws<ArgumentException>(() => Payloads.BuildIngest(1, "detector", new List<FrameData> { Frame(1) }, new List<IList<Detection>>(), null, null, null, 65));
            var nine = new List<FrameData>();
            for (int i = 0; i < 9; i++) nine.Add(Frame(i));
            Assert.Throws<ArgumentException>(() => Payloads.BuildIngest(1, "detector", nine, null, null, null, null, 65));
        }

        [Test]
        public void IngestCapsThePoseSliceAndClampsTheFov()
        {
            var poses = new List<PoseSample>();
            for (int i = 0; i < 700; i++) poses.Add(Pose(i));
            var o = JObject.Parse(Payloads.BuildIngest(1, "manual", new List<FrameData> { Frame(1) }, null, null, null, poses, 500));
            Assert.AreEqual(600, ((JArray)o["poseSlice"]).Count);
            Assert.AreEqual(699, (long)o["poseSlice"][599]["t"], "the newest samples are kept");
            Assert.AreEqual(180.0, (double)o["hfovDeg"], 1e-9);
        }

        [Test]
        public void QueryTextAudioFrameAndPose()
        {
            var o = JObject.Parse(Payloads.BuildQuery("q1", "where are my keys", null, null, Pose(5), null));
            Assert.AreEqual("where are my keys", (string)o["text"]);
            Assert.IsNull(o["audioB64"]);
            Assert.AreEqual(5, (long)o["poseAtT"]["t"]);

            o = JObject.Parse(Payloads.BuildQuery(null, null, new byte[] { 1, 2, 3 }, null, null, Frame(7)));
            Assert.AreEqual("AQID", (string)o["audioB64"]);
            Assert.AreEqual("audio/wav", (string)o["mime"]);
            Assert.IsNull(o["turnId"]);
            Assert.IsNull(o["poseAtT"]);
            Assert.AreEqual(7, (long)o["frame"]["t"]);

            Assert.Throws<ArgumentException>(() => Payloads.BuildQuery("q", "", null, null, null, null));
        }

        [Test]
        public void NonFiniteNumbersNeverReachTheWire()
        {
            var p = Pose(1);
            p.X = double.NaN;
            p.Y = double.PositiveInfinity;
            var o = JObject.Parse(Payloads.BuildQuery("q", "hi", null, null, p, null));
            Assert.AreEqual(0.0, (double)o["poseAtT"]["x"]);
            Assert.AreEqual(0.0, (double)o["poseAtT"]["y"]);
        }
    }

    public class RepliesTests
    {
        // Shaped like the Worker's real output (see tools/sim/src/http.ts and apps/worker/src/agent.ts).
        const string QueryWithTarget = "{\"turnId\":\"q_1\",\"addressed\":true,\"text\":\"Your keys is near the desk.\",\"audioB64\":\"AQID\",\"mime\":\"audio/wav\"," +
            "\"target\":{\"objectId\":\"o_1\",\"label\":\"keys\",\"x\":1.4,\"y\":3.5,\"bearingDeg\":21.8,\"zone\":\"desk\",\"ageSec\":12,\"confidence\":0.8,\"heightM\":-0.2,\"thumbUrl\":null,\"mode\":\"arrow\",\"setAt\":1800000000000}}";

        [Test]
        public void QueryReplyWithATarget()
        {
            QueryReply r;
            string err;
            Assert.IsTrue(Replies.TryParseQuery(QueryWithTarget, out r, out err), err);
            Assert.IsTrue(r.Addressed);
            Assert.AreEqual("Your keys is near the desk.", r.Text);
            CollectionAssert.AreEqual(new byte[] { 1, 2, 3 }, r.Audio);
            Assert.AreEqual("keys", r.Target.Label);
            Assert.AreEqual(1.4, r.Target.X, 1e-9);
            Assert.AreEqual(3.5, r.Target.Y, 1e-9);
            Assert.AreEqual(-0.2, r.Target.HeightM.Value, 1e-9);
            Assert.AreEqual("arrow", r.Target.Mode);
            Assert.AreEqual(1800000000000L, r.Target.SetAtMs);
        }

        [Test]
        public void QueryReplyWithoutATargetOrAudio()
        {
            QueryReply r;
            string err;
            Assert.IsTrue(Replies.TryParseQuery("{\"turnId\":\"q\",\"addressed\":true,\"text\":\"Sorry.\",\"target\":null}", out r, out err), err);
            Assert.IsNull(r.Target);
            Assert.IsNull(r.Audio);
        }

        [Test]
        public void AnIgnoredTurnIsNotAddressed()
        {
            QueryReply r;
            string err;
            Assert.IsTrue(Replies.TryParseQuery("{\"turnId\":\"q\",\"addressed\":false,\"text\":\"\",\"target\":null}", out r, out err), err);
            Assert.IsFalse(r.Addressed);
        }

        [Test]
        public void ATargetWithoutHeightHasNullHeight()
        {
            QueryReply r;
            string err;
            Assert.IsTrue(Replies.TryParseQuery("{\"addressed\":true,\"text\":\"ok\",\"target\":{\"objectId\":\"o\",\"label\":\"mug\",\"x\":0,\"y\":2,\"heightM\":null,\"mode\":\"zone\"}}", out r, out err), err);
            Assert.IsFalse(r.Target.HeightM.HasValue);
            Assert.AreEqual("zone", r.Target.Mode);
        }

        [Test]
        public void ErrorBodiesAreNotReplies()
        {
            QueryReply q;
            string err;
            Assert.IsFalse(Replies.TryParseQuery("{\"error\":\"invalid query: send text or audioB64\"}", out q, out err));
            Assert.AreEqual("invalid query: send text or audioB64", err);
            Assert.IsFalse(Replies.TryParseQuery("<html>bad gateway</html>", out q, out err));
            Assert.AreEqual("invalid query: send text or audioB64", Replies.ErrorOf("{\"error\":\"invalid query: send text or audioB64\"}", 400));
            Assert.AreEqual("HTTP 502", Replies.ErrorOf("", 502));
            Assert.AreEqual("unauthorized", Replies.ErrorOf("unauthorized", 401));
        }

        [Test]
        public void IngestReplies()
        {
            IngestReply r;
            string err;
            string accepted = "{\"accepted\":true,\"candidateId\":\"c_1\",\"status\":\"done\",\"objects\":[{\"id\":\"o_1\",\"label\":\"keys\",\"description\":\"d\",\"zone\":\"desk\",\"status\":\"placed\",\"x\":1.1,\"y\":2.2,\"heightM\":-0.3,\"posSource\":\"stereo\",\"confidence\":0.8}]}";
            Assert.IsTrue(Replies.TryParseIngest(accepted, out r, out err), err);
            Assert.IsTrue(r.Accepted);
            Assert.AreEqual("c_1", r.CandidateId);
            Assert.AreEqual("stereo", r.Objects[0].PosSource);
            Assert.AreEqual(-0.3, r.Objects[0].HeightM.Value, 1e-9);

            Assert.IsTrue(Replies.TryParseIngest("{\"accepted\":false,\"reason\":\"walking\",\"detail\":\"60% of poses\"}", out r, out err), err);
            Assert.IsFalse(r.Accepted);
            Assert.AreEqual("walking", r.Reason);
            Assert.AreEqual(0, r.Objects.Count);
        }
    }

    public class MediaTests
    {
        static byte[] Wav(short[] samples, int rate, int channels = 1, int bits = 16, bool streamedSize = false)
        {
            var ms = new System.IO.MemoryStream();
            var w = new System.IO.BinaryWriter(ms);
            int dataLen = samples.Length * 2;
            w.Write(new[] { (byte)'R', (byte)'I', (byte)'F', (byte)'F' });
            w.Write(36 + dataLen);
            w.Write(new[] { (byte)'W', (byte)'A', (byte)'V', (byte)'E', (byte)'f', (byte)'m', (byte)'t', (byte)' ' });
            w.Write(16);
            w.Write((short)1);
            w.Write((short)channels);
            w.Write(rate);
            w.Write(rate * channels * bits / 8);
            w.Write((short)(channels * bits / 8));
            w.Write((short)bits);
            w.Write(new[] { (byte)'d', (byte)'a', (byte)'t', (byte)'a' });
            w.Write(streamedSize ? 0 : dataLen);
            foreach (var s in samples) w.Write(s);
            return ms.ToArray();
        }

        [Test]
        public void DecodesTheWorkersSpeechFormat()
        {
            WavData d;
            string err;
            Assert.IsTrue(WavDecoder.TryDecode(Wav(new short[] { 0, 16384, -16384, 32767 }, 24000), out d, out err), err);
            Assert.AreEqual(24000, d.SampleRate);
            Assert.AreEqual(1, d.Channels);
            Assert.AreEqual(4, d.Samples.Length);
            Assert.AreEqual(0.5f, d.Samples[1], 1e-4);
            Assert.AreEqual(-0.5f, d.Samples[2], 1e-4);
            Assert.AreEqual(1f, d.Samples[3], 1e-3);
        }

        [Test]
        public void ATrustedLengthIsNotRequired()
        {
            WavData d;
            string err;
            Assert.IsTrue(WavDecoder.TryDecode(Wav(new short[] { 1, 2, 3, 4, 5, 6 }, 16000, 2, streamedSize: true), out d, out err), err);
            Assert.AreEqual(6, d.Samples.Length);
            Assert.AreEqual(2, d.Channels);
        }

        [Test]
        public void RejectsWhatItCannotPlay()
        {
            WavData d;
            string err;
            Assert.IsFalse(WavDecoder.TryDecode(new byte[10], out d, out err));
            Assert.IsFalse(WavDecoder.TryDecode(System.Text.Encoding.ASCII.GetBytes("ID3 this is an mp3 header, not a wav file at all, sorry"), out d, out err));
            StringAssert.Contains("RIFF", err);
            Assert.IsFalse(WavDecoder.TryDecode(Wav(new short[] { 1, 2 }, 8000, 1, 8), out d, out err));
            StringAssert.Contains("16-bit", err);
        }

        [Test]
        public void EncodedWavRoundTripsThroughTheDecoder()
        {
            var samples = new[] { 0f, 0.5f, -0.5f, 1f, -1f, 2f, float.NaN };
            var wav = WavEncoder.EncodePcm16(samples, samples.Length, 1, 16000);
            Assert.AreEqual(44 + samples.Length * 2, wav.Length);
            WavData d;
            string err;
            Assert.IsTrue(WavDecoder.TryDecode(wav, out d, out err), err);
            Assert.AreEqual(16000, d.SampleRate);
            Assert.AreEqual(7, d.Samples.Length);
            Assert.AreEqual(0.5f, d.Samples[1], 1e-3);
            Assert.AreEqual(-0.5f, d.Samples[2], 1e-3);
            Assert.AreEqual(1f, d.Samples[5], 1e-3, "values above 1 are clipped");
            Assert.AreEqual(0f, d.Samples[6], 1e-6, "NaN becomes silence");
            Assert.Throws<ArgumentException>(() => WavEncoder.EncodePcm16(samples, 3, 0, 16000));
        }

        static byte[] Image(int w, int h, Func<int, int, byte> lum)
        {
            var px = new byte[w * h * 4];
            for (int y = 0; y < h; y++)
                for (int x = 0; x < w; x++)
                {
                    byte v = lum(x, y);
                    int i = (y * w + x) * 4;
                    px[i] = px[i + 1] = px[i + 2] = v;
                    px[i + 3] = 255;
                }
            return px;
        }

        [Test]
        public void ImageHashIsStableAndSeparatesScenes()
        {
            var a = Image(640, 480, (x, y) => (byte)(x < 320 ? 30 : 220));
            var b = Image(640, 480, (x, y) => (byte)(y < 240 ? 30 : 220));
            string ha = ImageHash.AHash(a, 640, 480), hb = ImageHash.AHash(b, 640, 480);
            Assert.AreEqual(16, ha.Length);
            Assert.AreEqual(ha, ImageHash.AHash(a, 640, 480));
            Assert.Greater(ImageHash.Distance(ha, hb), 4, "different scenes are more than 4 bits apart");

            // small noise: still the same scene
            var noisy = Image(640, 480, (x, y) => (byte)((x < 320 ? 30 : 220) + ((x * 7 + y * 13) % 5)));
            Assert.LessOrEqual(ImageHash.Distance(ha, ImageHash.AHash(noisy, 640, 480)), 4);
            Assert.AreEqual(-1, ImageHash.Distance(ha, "abcd"));
            Assert.IsNull(ImageHash.AHash(new byte[4], 1, 1));
        }
    }

    public class ConfigTests
    {
        [Test]
        public void ParsesAndDefaults()
        {
            var c = LastseenConfig.Parse("{\"workerUrl\":\"https://x.workers.dev/\",\"token\":\"t\",\"deviceId\":\"beam-1\",\"hfovDeg\":62.5,\"baselineM\":0.064,\"stereoSwap\":true}");
            Assert.IsNull(c.Problem());
            Assert.AreEqual("https://x.workers.dev/api/query?device=beam-1", c.Url("/api/query"));
            Assert.AreEqual("https://x.workers.dev/api/ingest?wait=1&device=beam-1", c.Url("/api/ingest?wait=1"));
            Assert.AreEqual(62.5, c.HfovDeg, 1e-9);
            Assert.AreEqual(0.064, c.BaselineM.Value, 1e-9);
            Assert.IsTrue(c.StereoSwap.Value);

            var empty = LastseenConfig.Parse("");
            Assert.IsNotNull(empty.Problem());
            Assert.AreEqual("default", empty.DeviceId);
            Assert.IsNull(empty.BaselineM);
            Assert.IsNotNull(LastseenConfig.Parse("{not json").Problem());
            Assert.IsNotNull(LastseenConfig.Parse("{\"workerUrl\":\"ftp://x\",\"token\":\"t\"}").Problem());
            Assert.IsNotNull(LastseenConfig.Parse("{\"workerUrl\":\"https://x\"}").Problem());
        }
    }
}
