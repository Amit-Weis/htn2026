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

        [Header("Wait for a request (Omni voice trigger)")]
        [Tooltip("When on, the objects stay hidden even after the card has been seen, until Request() is called, and hide again " +
                 "showForSeconds later. Switched on by OmniVoiceTrigger when it is configured; off keeps the original behaviour.")]
        [SerializeField] bool requireRequest;
        [SerializeField, Min(1f)] float showForSeconds = 20f;

        bool revealed;
        float requestedUntil = float.NegativeInfinity;

        public bool RequireRequest
        {
            get { return requireRequest; }
            set { requireRequest = value; }
        }

        /// <summary>The card has been seen at least once, so there is somewhere to point.</summary>
        public bool HasAnchor => anchor != null && anchor.HasAnchor;

        /// <summary>The wearer asked for the card: show the objects for showForSeconds (once the card has been seen).</summary>
        public void Request()
        {
            requestedUntil = Time.unscaledTime + showForSeconds;
        }

        /// <summary>Hide again now.</summary>
        public void Cancel()
        {
            requestedUntil = float.NegativeInfinity;
        }

        void Awake()
        {
            if (anchor == null) anchor = FindAnyObjectByType<LastSeenAnchor>();
            if (headCamera == null) headCamera = Camera.main;
            SetAll(false);
        }

        void Update()
        {
            if (anchor == null) return;

            bool requested = !requireRequest || Time.unscaledTime <= requestedUntil;
            bool shouldShow = requested && anchor.HasAnchor &&
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
