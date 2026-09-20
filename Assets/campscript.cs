using System.Collections;
using UnityEngine;
using UnityEngine.Android;

public class PhoneCameraFeed : MonoBehaviour
{
    [SerializeField] Renderer[] targetQuads;   // quads with an Unlit material
    [SerializeField] bool useFrontCamera = false;
    [SerializeField] Vector2Int requested = new Vector2Int(1280, 720);
    [SerializeField] int fps = 30;

    WebCamTexture cam;

    IEnumerator Start()
    {
        if (targetQuads == null || targetQuads.Length == 0)
        {
            Debug.LogError("no target quads assigned");
            yield break;
        }

        if (!Permission.HasUserAuthorizedPermission(Permission.Camera))
        {
            Permission.RequestUserPermission(Permission.Camera);
            while (!Permission.HasUserAuthorizedPermission(Permission.Camera))
                yield return null;
        }

        var devices = WebCamTexture.devices;
        foreach (var d in devices)
            Debug.Log($"[cam] {d.name} front={d.isFrontFacing}");

        if (devices.Length == 0) { Debug.LogError("no cameras"); yield break; }

        string name = devices[0].name;
        foreach (var d in devices)
            if (d.isFrontFacing == useFrontCamera) { name = d.name; break; }

        cam = new WebCamTexture(name, requested.x, requested.y, fps);
        cam.Play();

        foreach (var r in targetQuads)
            if (r != null) r.material.mainTexture = cam;

        // wait for a real frame before trusting width/height
        while (cam.width < 16) yield return null;

        Fit();
    }

    void Fit()
    {
        float aspect = (float)cam.width / cam.height;
        float h = 1.0f;   // metres tall at its parent distance

        foreach (var r in targetQuads)
        {
            if (r == null) continue;

            r.transform.localScale = new Vector3(h * aspect, h, 1f);
            r.transform.localRotation = Quaternion.Euler(0f, 0f, -cam.videoRotationAngle);

            if (cam.videoVerticallyMirrored)
                r.material.mainTextureScale = new Vector2(1f, -1f);
        }
    }

    void OnDisable() { if (cam != null && cam.isPlaying) cam.Stop(); }
}