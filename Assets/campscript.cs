using System.Collections;
using UnityEngine;
using UnityEngine.Android;

public class PhoneCameraFeed : MonoBehaviour
{
    [SerializeField] Renderer[] targetQuads;
    [SerializeField] bool useFrontCamera = false;
    [SerializeField] Vector2Int requested = new Vector2Int(1280, 720);
    [SerializeField] int fps = 30;

    [Header("HUD placement")]
    [SerializeField] Camera viewCam;
    [SerializeField] float distance = 1.5f;
    [SerializeField, Range(0.05f, 0.6f)] float heightFrac = 0.25f;
    [SerializeField, Range(0f, 0.2f)] float margin = 0.04f;

    WebCamTexture cam;
    float lastFov, lastAspect, lastHeightFrac, lastMargin, lastDistance;

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

        string camName = devices[0].name;
        foreach (var d in devices)
            if (d.isFrontFacing == useFrontCamera) { camName = d.name; break; }

        cam = new WebCamTexture(camName, requested.x, requested.y, fps);
        cam.Play();

        foreach (var r in targetQuads)
            if (r != null) r.material.mainTexture = cam;

        while (cam.width < 16) yield return null;

        Debug.Log($"[cam] {cam.width}x{cam.height} rot={cam.videoRotationAngle} mirrored={cam.videoVerticallyMirrored}");

        Fit();
    }

    void LateUpdate()
    {
        if (cam == null || cam.width < 16 || viewCam == null) return;

        if (Mathf.Approximately(lastFov, viewCam.fieldOfView) &&
            Mathf.Approximately(lastAspect, viewCam.aspect) &&
            Mathf.Approximately(lastHeightFrac, heightFrac) &&
            Mathf.Approximately(lastMargin, margin) &&
            Mathf.Approximately(lastDistance, distance)) return;

        lastFov = viewCam.fieldOfView;
        lastAspect = viewCam.aspect;
        lastHeightFrac = heightFrac;
        lastMargin = margin;
        lastDistance = distance;
        Fit();
    }

    void Fit()
    {
        if (viewCam == null) viewCam = Camera.main;
        if (viewCam == null) { Debug.LogError("no viewCam"); return; }

        int rot = cam.videoRotationAngle;
        bool quarter = (rot % 180) != 0;

        float aspect = (float)cam.width / cam.height;
        if (quarter) aspect = 1f / aspect;

        float viewH = 2f * distance * Mathf.Tan(viewCam.fieldOfView * 0.5f * Mathf.Deg2Rad);
        float viewW = viewH * viewCam.aspect;

        float h = viewH * heightFrac;
        float w = h * aspect;

        float x = viewW * 0.5f - w * 0.5f - viewW * margin;
        float y = viewH * 0.5f - h * 0.5f - viewH * margin;

        foreach (var r in targetQuads)
        {
            if (r == null) continue;

            r.transform.localPosition = new Vector3(x, y, distance);
            r.transform.localRotation = Quaternion.Euler(0f, 0f, -rot);
            r.transform.localScale = new Vector3(w, h, 1f);

            r.material.mainTextureScale = cam.videoVerticallyMirrored ? new Vector2(1f, -1f) : Vector2.one;
            r.material.mainTextureOffset = cam.videoVerticallyMirrored ? new Vector2(0f, 1f) : Vector2.zero;
        }
    }

    void OnDisable() { if (cam != null && cam.isPlaying) cam.Stop(); }
}