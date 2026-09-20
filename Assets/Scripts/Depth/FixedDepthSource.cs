namespace Depth
{
    // Depth already computed elsewhere (e.g. stereo on the server); just hands it to DepthLocator.
    public class FixedDepthSource : IDepthSource
    {
        readonly float z;

        public FixedDepthSource(float z)
        {
            this.z = z;
        }

        public bool TryGetDepth(in Detection2D detection, out float depth, out float confidence)
        {
            depth = z;
            confidence = detection.confidence;
            return z > 0f;
        }
    }
}
