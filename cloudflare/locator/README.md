> **Superseded.** The stereo depth here now lives in the main Worker (`lastseen/apps/worker/src/ingest/stereo.ts`, reached through `POST /api/ingest`), and voice commands go through `POST /api/query`, so the agent keeps memory across questions. This Worker is kept for reference (its tests document the block-matching conventions) and should not be deployed. See `lastseen/docs/DECISIONS.md` entries 59-63.

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

## Voice: `POST /command`

WAV audio in, Omni's reading of it out: `{intent: "find"|"none", target, heard, reply}` (`Depth/VoiceCommandResponse.cs`).
`target` is one of the detector's COCO labels (Omni maps "my phone" to `cell phone`) or empty if nothing fits.
Needs `OMNI_BASE_URL` (OpenAI-compatible root, ending `/v1`) and `OMNI_MODEL` in `wrangler.toml`, plus
`npx wrangler secret put OMNI_API_KEY`. The audio goes as an OpenAI-style `input_audio` part; the base URL, model
id and that audio format are unverified against yibuapi until you run it with a real key.

Then set `TargetLocator.endpointUrl` in Unity to the deployed `https://htn-locator.<you>.workers.dev/`.

Calibration in `wrangler.toml` (`BASELINE_M`, `HFOV_DEG`, `STEREO_SWAP`) is a placeholder until measured.
