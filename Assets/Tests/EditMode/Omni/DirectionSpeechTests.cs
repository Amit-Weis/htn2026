using NUnit.Framework;

namespace Omni.Tests
{
    public class DirectionSpeechTests
    {
        [TestCase(0, "straight ahead")]
        [TestCase(20, "straight ahead")]
        [TestCase(-20, "straight ahead")]
        [TestCase(21, "ahead and to your right")]
        [TestCase(-21, "ahead and to your left")]
        [TestCase(60, "ahead and to your right")]
        [TestCase(61, "to your right")]
        [TestCase(90, "to your right")]
        [TestCase(-90, "to your left")]
        [TestCase(120, "to your right")]
        [TestCase(121, "behind you, to your right")]
        [TestCase(-160, "behind you, to your left")]
        [TestCase(161, "directly behind you")]
        [TestCase(180, "directly behind you")]
        [TestCase(-180, "directly behind you")]
        public void DirectionBins(double angle, string expected)
        {
            Assert.AreEqual(expected, DirectionSpeech.Direction(angle));
        }

        [Test]
        public void PositiveIsRightAndNegativeIsLeft()
        {
            StringAssert.Contains("right", DirectionSpeech.Direction(45));
            StringAssert.Contains("left", DirectionSpeech.Direction(-45));
        }

        [Test]
        public void AnglesWrapAround()
        {
            Assert.AreEqual("straight ahead", DirectionSpeech.Direction(370));
            Assert.AreEqual("straight ahead", DirectionSpeech.Direction(-350));
            Assert.AreEqual("to your left", DirectionSpeech.Direction(270), "270 degrees clockwise is 90 to the left");
            Assert.AreEqual("to your right", DirectionSpeech.Direction(-270));
            Assert.AreEqual("directly behind you", DirectionSpeech.Direction(540));
            Assert.AreEqual(180.0, DirectionSpeech.Wrap(-180.0), 1e-9, "+180, not -180");
            Assert.AreEqual(180.0, DirectionSpeech.Wrap(180.0), 1e-9);
        }

        [Test]
        public void NonNumbersDoNotThrowOrLie()
        {
            Assert.AreEqual("somewhere near you", DirectionSpeech.Direction(double.NaN));
            Assert.AreEqual("somewhere near you", DirectionSpeech.Direction(double.PositiveInfinity));
            Assert.IsNull(DirectionSpeech.Distance(double.NaN));
            Assert.IsNull(DirectionSpeech.Distance(-1));
            Assert.IsNull(DirectionSpeech.Height(double.NaN));
        }

        [TestCase(0.0, "less than a meter away")]
        [TestCase(0.99, "less than a meter away")]
        [TestCase(1.0, "about 1 meter away")]
        [TestCase(1.2, "about 1 meter away")]
        [TestCase(1.3, "about 1.5 meters away")]
        [TestCase(2.0, "about 2 meters away")]
        [TestCase(2.8, "about 3 meters away")]
        [TestCase(3.4, "about 3 meters away")]
        [TestCase(3.6, "about 4 meters away")]
        [TestCase(12.4, "about 12 meters away")]
        public void DistanceWords(double meters, string expected)
        {
            Assert.AreEqual(expected, DirectionSpeech.Distance(meters));
        }

        [Test]
        public void HeightOnlyWhenClearlyAboveOrBelow()
        {
            Assert.IsNull(DirectionSpeech.Height(0));
            Assert.IsNull(DirectionSpeech.Height(29.9));
            Assert.IsNull(DirectionSpeech.Height(-29.9));
            Assert.AreEqual("up high", DirectionSpeech.Height(30));
            Assert.AreEqual("down low", DirectionSpeech.Height(-45));
        }

        [Test]
        public void ABearingOnlySentenceMakesNoClaimAboutDistanceOrHeight()
        {
            Assert.AreEqual("It's ahead and to your left.", DirectionSpeech.DirectionSentence(-40));
            Assert.AreEqual("It's directly behind you.", DirectionSpeech.DirectionSentence(180));
            StringAssert.DoesNotContain("meter", DirectionSpeech.DirectionSentence(30));
            StringAssert.DoesNotContain("low", DirectionSpeech.DirectionSentence(30));
        }

        [Test]
        public void WhereAndSentence()
        {
            Assert.AreEqual("ahead and to your left, about 3 meters away", DirectionSpeech.Where(-40, 0, 3.1));
            Assert.AreEqual("straight ahead, up high, about 2 meters away", DirectionSpeech.Where(5, 50, 2.0));
            Assert.AreEqual("directly behind you, down low, less than a meter away", DirectionSpeech.Where(179, -60, 0.4));
            Assert.AreEqual("to your right", DirectionSpeech.Where(90, 0, double.NaN), "an unknown distance is left out");
            Assert.AreEqual("It's to your right, about 2 meters away.", DirectionSpeech.Sentence(90, 0, 2.0));
        }
    }
}
