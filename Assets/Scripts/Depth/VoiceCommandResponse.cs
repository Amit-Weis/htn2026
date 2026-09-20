using System;

namespace Depth
{
    // JSON returned by the Cloudflare /command endpoint (JsonUtility, so fields keep the wire names).
    // intent is "find" or "none". target is a COCO class label when intent is "find", empty when Omni
    // could not map the request to something the detector knows.
    [Serializable]
    public class VoiceCommandResponse
    {
        public string intent;
        public string target;
        public string heard;
        public string reply;
        public string error;
    }
}
