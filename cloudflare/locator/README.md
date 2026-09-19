# htn-locator

Cloudflare Worker: side-by-side stereo JPEG in, target position out.

- `POST /?label=<coco class or "target">` with the JPEG as the body (left camera | right camera).
- Optional query overrides: `fx`, `fy`, `cx`, `cy` (pixels at the sent size), `baseline` (meters).
- Response is `Assets/Scripts/Depth/LocateResponse.cs` (`found`, `u`, `v`, `depth_m`, intrinsics, ...).
- Detection: Workers AI (`DETECT_MODEL`, COCO classes only). Depth: block match of the box center patch.

```
npm install
npm test            # local, no Cloudflare account needed
npx wrangler login  # once
npx wrangler dev    # local server; the AI binding calls Cloudflare
npx wrangler deploy
```

Then set `TargetLocator.endpointUrl` in Unity to the deployed `https://htn-locator.<you>.workers.dev/`.

Calibration in `wrangler.toml` (`BASELINE_M`, `HFOV_DEG`, `STEREO_SWAP`) is a placeholder until measured.
