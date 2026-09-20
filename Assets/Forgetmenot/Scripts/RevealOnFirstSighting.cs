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

        /// <summary>Where the card was last seen (world position). False until it has been seen once.</summary>
        public bool TryGetAnchorPosition(out Vector3 position)
        {
            position = anchor != null ? anchor.AnchorPosition : Vector3.zero;
            return anchor != null && anchor.HasAnchor;
        }

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

        /// <summary>How long ago the card was last seen; infinity before the first sighting.</summary>
        public float SecondsSinceSeen => anchor != null && anchor.HasAnchor ? anchor.SecondsSinceSeen : float.PositiveInfinity;

        /// <summary>The position is only a bearing (fixed placement): its distance and height are not the card's real ones.</summary>
        public bool PositionIsApproximate => anchor != null && anchor.PositionIsApproximate;

        /// <summary>The position was set by the first sighting and never moves (latched placement), so it can be much older than the last sighting.</summary>
        public bool PositionIsFromFirstSighting => anchor != null && anchor.PositionIsLatched;

        /// <summary>
        /// How old the remembered position is. With a latched placement that is the time since the first sighting (later sightings do not
        /// move it), otherwise the time since the last one. Infinity before the first sighting.
        /// </summary>
        public float SecondsSincePositionSet
        {
            get
            {
                if (anchor == null || !anchor.HasAnchor) return float.PositiveInfinity;
                return anchor.PositionIsLatched ? Time.unscaledTime - positionSetAt : anchor.SecondsSinceSeen;
            }
        }

        float positionSetAt = float.NegativeInfinity;
        float forgottenSetAt;
        bool hadAnchor;

        [Tooltip("After 'I found it' the old position is kept this long, so a wrong 'found' (someone else's words, a mishearing) can be undone by asking again.")]
        [SerializeField, Min(0f)] float keepForgottenSeconds = 600f;

        Vector3 forgottenPosition;
        float forgottenSeenAt;
        float forgottenAt = float.NegativeInfinity;

        /// <summary>
        /// The wearer has the card: hide the objects and clear where it was (the position, and the totem marker there), so the next
        /// request does not point at a stale spot. The next sighting by the detector remembers it again, wherever it is then.
        /// The cleared position is kept for keepForgottenSeconds, see <see cref="RestoreForgotten"/>.
        /// </summary>
        public void Forget()
        {
            Cancel();
            if (anchor == null) return;
            if (anchor.HasAnchor)
            {
                forgottenPosition = anchor.AnchorPosition;
                forgottenSeenAt = Time.unscaledTime - anchor.SecondsSinceSeen;
                forgottenSetAt = positionSetAt;
                forgottenAt = Time.unscaledTime;
            }
            anchor.ClearAnchor();
        }

        /// <summary>True when a position was cleared by Forget() less than keepForgottenSeconds ago and nothing has been seen since.</summary>
        public bool HasRecentlyForgotten => anchor != null && !anchor.HasAnchor && Time.unscaledTime - forgottenAt <= keepForgottenSeconds;

        /// <summary>Undo a Forget(): puts the cleared position back (with its real age). False when there is nothing recent to restore.</summary>
        public bool RestoreForgotten()
        {
            if (!HasRecentlyForgotten) return false;
            anchor.Restore(forgottenPosition, forgottenSeenAt);
            positionSetAt = forgottenSetAt;
            hadAnchor = true; // not a new sighting: keep the original age
            forgottenAt = float.NegativeInfinity;
            return true;
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

            bool has = anchor.HasAnchor;
            if (has && !hadAnchor) positionSetAt = Time.unscaledTime; // a position was just set (first sighting)
            hadAnchor = has;

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
