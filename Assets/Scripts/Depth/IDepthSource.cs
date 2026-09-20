namespace Depth
{
    public interface IDepthSource
    {
        // z: meters along the camera optical axis; confidence: 0..1
        bool TryGetDepth(in Detection2D detection, out float z, out float confidence);
    }
}
