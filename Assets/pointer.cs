using UnityEngine;

public class LookAtTarget : MonoBehaviour
{
    public Transform target;
    public float x = 90;
    public float y = 97;
    public float z = 4;

    void LateUpdate()
    {
        if (target == null) return;

        transform.LookAt(target);

        // mesh points along local -X, not +Z
        transform.Rotate(x, y, z, Space.Self);
    }
}