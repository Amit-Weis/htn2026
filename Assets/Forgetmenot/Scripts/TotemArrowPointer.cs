using UnityEngine;

namespace Forgetmenot
{
    /// <summary>
    /// Points an arrow at the LastSeenAnchor target. Same aiming method as the
    /// original LookAtTarget: LookAt, then a hand-tuned local rotation to account
    /// for the mesh not pointing down its own +Z.
    ///
    /// Unlike LookAtTarget this does not need a target assigned in the inspector,
    /// and it hides itself until the card has been seen at least once. Leave the
    /// arrow parented to the camera exactly as it was; this only writes rotation,
    /// so the parent keeps head-locking the position for free.
    /// </summary>
    public sealed class TotemArrowPointer : MonoBehaviour
    {
        [Header("References")]
        [SerializeField] LastSeenAnchor anchor;
        [SerializeField] Camera headCamera;
        [Tooltip("The arrow mesh. Leave it parented to the camera; only rotation is driven.")]
        [SerializeField] Transform arrow;

        [Header("Mesh correction")]
        [Tooltip("Applied in local space after LookAt. Carried over from LookAtTarget.")]
        [SerializeField] float x = 90f;
        [SerializeField] float y = 97f;
        [SerializeField] float z = 4f;

        [Header("Visibility")]
        [Tooltip("Hide once the target is this close to the centre of view. 0 never hides.")]
        [SerializeField, Range(0f, 45f)] float hideWithinDegrees;
        [Tooltip("Hide if nothing has been seen for this long. 0 keeps it up forever.")]
        [SerializeField, Min(0f)] float expireAfterSeconds;

        void Awake()
        {
            if (headCamera == null) headCamera = Camera.main;
            if (anchor == null) anchor = FindAnyObjectByType<LastSeenAnchor>();
            SetVisible(false);
        }

        void LateUpdate()
        {
            if (anchor == null || arrow == null) return;

            if (!anchor.HasAnchor ||
                (expireAfterSeconds > 0f && anchor.SecondsSinceSeen > expireAfterSeconds))
            {
                SetVisible(false);
                return;
            }

            if (hideWithinDegrees > 0f && headCamera != null)
            {
                float offAxis = Vector3.Angle(
                    headCamera.transform.forward,
                    anchor.AnchorPosition - headCamera.transform.position);
                if (offAxis <= hideWithinDegrees)
                {
                    SetVisible(false);
                    return;
                }
            }

            SetVisible(true);

            // LookAt needs the arrow already at its final position this frame. The
            // parent transform has updated by LateUpdate, so reading it here is safe.
            arrow.LookAt(anchor.AnchorPosition);
            arrow.Rotate(x, y, z, Space.Self);
        }

        void SetVisible(bool visible)
        {
            if (arrow.gameObject.activeSelf != visible)
                arrow.gameObject.SetActive(visible);
        }
    }
}
