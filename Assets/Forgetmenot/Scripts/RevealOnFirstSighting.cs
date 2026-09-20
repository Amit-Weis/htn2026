using UnityEngine;

namespace Forgetmenot
{
    /// <summary>
    /// Keeps a set of objects hidden until LastSeenAnchor gets its first sighting,
    /// then reveals them and leaves them up. Intended for the AirTag-style pill
    /// (the FindingGroup root carrying DistanceReadout) and anything else that
    /// should not exist before the card has been seen once.
    ///
    /// DistanceReadout renders its previewDistance whenever its from/to transforms
    /// are unassigned, so without this it shows a fake "0.7 m" from scene load.
    /// </summary>
    public sealed class RevealOnFirstSighting : MonoBehaviour
    {
        [SerializeField] LastSeenAnchor anchor;

        [Tooltip("Hidden at startup, shown once the card has been seen once.")]
        [SerializeField] GameObject[] revealOnFirstSighting;

        [Header("Optional: wire the readout automatically")]
        [Tooltip("Set DistanceReadout.from/to to the head camera and the totem on reveal.")]
        [SerializeField] DistanceReadout distanceReadout;
        [SerializeField] Camera headCamera;
        [SerializeField] Transform totem;

        [Header("Hide again")]
        [Tooltip("Hide everything if nothing has been seen for this long. 0 keeps it up forever.")]
        [SerializeField, Min(0f)] float hideAfterUnseenSeconds;

        bool revealed;

        void Awake()
        {
            if (anchor == null) anchor = FindAnyObjectByType<LastSeenAnchor>();
            if (headCamera == null) headCamera = Camera.main;
            SetAll(false);
        }

        void Update()
        {
            if (anchor == null) return;

            bool shouldShow = anchor.HasAnchor &&
                (hideAfterUnseenSeconds <= 0f || anchor.SecondsSinceSeen <= hideAfterUnseenSeconds);

            if (shouldShow && !revealed)
            {
                WireReadout();
                SetAll(true);
                revealed = true;
            }
            else if (!shouldShow && revealed)
            {
                SetAll(false);
                revealed = false;
            }
        }

        void WireReadout()
        {
            if (distanceReadout == null) return;
            if (distanceReadout.from == null && headCamera != null)
                distanceReadout.from = headCamera.transform;
            if (distanceReadout.to == null && totem != null)
                distanceReadout.to = totem;
        }

        void SetAll(bool visible)
        {
            foreach (GameObject target in revealOnFirstSighting)
            {
                if (target != null && target.activeSelf != visible)
                    target.SetActive(visible);
            }
        }
    }
}
