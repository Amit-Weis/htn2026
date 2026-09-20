using UnityEngine;
using UnityEngine.InputSystem;

public class AnchorPlacer : MonoBehaviour
{
    [SerializeField] AnchorArrow arrow;
    [SerializeField] float assumedDistance = 5f;

    void Update()
    {
        bool pressed =
            (Keyboard.current != null && Keyboard.current.spaceKey.wasPressedThisFrame) ||
            (Touchscreen.current != null && Touchscreen.current.primaryTouch.press.wasPressedThisFrame);

        if (!pressed || Camera.main == null) return;

        // flatten look direction to horizontal, project out to a nominal distance
        Vector3 fwd = Camera.main.transform.forward;
        fwd.y = 0f;
        if (fwd.sqrMagnitude < 0.0001f) return;
        fwd.Normalize();

        Vector3 p = Camera.main.transform.position + fwd * assumedDistance;

        arrow.anchorWorld = p;
        arrow.hasAnchor = true;
        Debug.Log($"ANCHOR bearing {Mathf.Atan2(fwd.x, fwd.z) * Mathf.Rad2Deg:F1}deg");
    }
}