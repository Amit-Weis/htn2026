# OMNI capabilities

**Status: NOT YET MEASURED.** No `OMNI_API_KEY` was available when M0 was built (keys are issued by email after the Luma application), and the yibuapi docs/pricing pages are client-rendered and could not be read. The challenge README documents no endpoint, model id, or request shape. Nothing below is a finding; it is what the adapter assumes and how it degrades.

Run `pnpm probe:omni` (needs `OMNI_API_KEY`, optionally `OMNI_BASE_URL`, `OMNI_MODEL`). It **overwrites this file** with measured results: model list, text, image (base64), audio input (two encodings), audio output, streaming, JSON mode, native tool calling, and latency for each.

## What the adapter assumes (OpenAI-compatible chat completions)

| Area | Assumption | If wrong |
| --- | --- | --- |
| Endpoint | `POST {OMNI_BASE_URL}/chat/completions`, `Authorization: Bearer` | set `OMNI_BASE_URL` |
| Streaming | Always `stream: true` with `stream_options.include_usage` | probe records it |
| Image in | `image_url` part with a `data:image/jpeg;base64,...` URL | probe records it |
| Audio in | `input_audio` part, `format: "wav"`, `data` as `data:;base64,...` | set `OMNI_AUDIO_STYLE=raw` |
| Audio out | `modalities: ["text","audio"]`, `audio: {voice, format}`, base64 PCM16 24 kHz deltas | `speak()` returns `null`, phone uses browser `speechSynthesis` |
| Tools | not used; strict JSON step protocol validated by zod | n/a |
| Cost | estimated from `usage`, see DECISIONS #13 | tune `OMNI_PRICE_*` |

Runtime degradation is automatic: if audio output fails once, `capabilities.audioOutput` flips to `false` and the phone speaks with `speechSynthesis` from then on.
