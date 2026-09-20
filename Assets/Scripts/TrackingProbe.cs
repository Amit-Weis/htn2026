using UnityEngine;

public class TrackingProbe : MonoBehaviour
{
    int frame;

    void Update()
    {
        if (Camera.main == null) { Debug.LogError("No MainCamera tag!"); return; }
        if (++frame % 30 != 0) return;

        Vector3 p = Camera.main.transform.position;
        Debug.Log($"POS {p.x:F2} {p.y:F2} {p.z:F2}");
    }
}
