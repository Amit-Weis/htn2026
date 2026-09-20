using UnityEngine;

public class AnchorArrow : MonoBehaviour
{
    [SerializeField] Transform arrowPivot;
    [SerializeField] Transform arrowQuad;
    [SerializeField] float hideAngle = 8f;

    public Vector3 anchorWorld;
    public bool hasAnchor;

    void LateUpdate()
    {
        if (!hasAnchor || Camera.main == null)
        {
            if (arrowQuad) arrowQuad.gameObject.SetActive(false);
            return;
        }

        Vector3 local = Camera.main.transform.InverseTransformPoint(anchorWorld);

        Vector2 flat = new Vector2(local.x, local.z);
        if (flat.sqrMagnitude < 0.0001f) return;

        float angle = Mathf.Atan2(flat.x, flat.y) * Mathf.Rad2Deg;

        arrowQuad.gameObject.SetActive(Mathf.Abs(angle) > hideAngle);
        arrowPivot.localRotation = Quaternion.Euler(0f, 0f, -angle);
    }
}
