using UnityEngine;

namespace Forgetmenot
{
    public class DetectionSimulator : MonoBehaviour
    {
        [SerializeField] DetectionAnchorController m_AnchorController;
        [SerializeField] string m_ClassName = "cell phone";
        [SerializeField, Range(0f, 1f)] float m_Confidence = 0.93f;

        [ContextMenu("Simulate Center Detection")]
        public void SimulateCenterDetection()
        {
            var box = new DetectionBox { x1 = 480, y1 = 270, x2 = 800, y2 = 450 };
            m_AnchorController.HandleDetections(new DetectionFrameResult
            {
                image_width = 1280,
                image_height = 720,
                detections = new[]
                {
                    new DetectionResult
                    {
                        class_name = m_ClassName,
                        confidence = m_Confidence,
                        bbox = box,
                        center = new DetectionPoint { x = 640, y = 360 }
                    }
                }
            });
        }
    }
}
