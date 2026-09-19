// The detector only knows COCO classes, so Omni must map what the user says onto one of these.
export const COCO_LABELS = [
  'person', 'bicycle', 'car', 'motorcycle', 'airplane', 'bus', 'train', 'truck', 'boat', 'traffic light',
  'fire hydrant', 'stop sign', 'parking meter', 'bench', 'bird', 'cat', 'dog', 'horse', 'sheep', 'cow',
  'elephant', 'bear', 'zebra', 'giraffe', 'backpack', 'umbrella', 'handbag', 'tie', 'suitcase', 'frisbee',
  'skis', 'snowboard', 'sports ball', 'kite', 'baseball bat', 'baseball glove', 'skateboard', 'surfboard',
  'tennis racket', 'bottle', 'wine glass', 'cup', 'fork', 'knife', 'spoon', 'bowl', 'banana', 'apple',
  'sandwich', 'orange', 'broccoli', 'carrot', 'hot dog', 'pizza', 'donut', 'cake', 'chair', 'couch',
  'potted plant', 'bed', 'dining table', 'toilet', 'tv', 'laptop', 'mouse', 'remote', 'keyboard',
  'cell phone', 'microwave', 'oven', 'toaster', 'sink', 'refrigerator', 'book', 'clock', 'vase',
  'scissors', 'teddy bear', 'hair drier', 'toothbrush',
];

const SYSTEM = `You are the voice controller for AR glasses that can locate everyday objects.
Listen to the user's audio. Reply with ONLY a JSON object, no prose, no code fence:
{"intent":"find"|"none","target":<string or null>,"heard":<what the user said>,"reply":<one short sentence to show the user>}
- intent "find": the user is looking for, or cannot find, a physical object.
- target: that object as ONE label from this list, mapping synonyms to the closest class (e.g. "phone" -> "cell phone", "mug" -> "cup", "TV remote" -> "remote"): ${COCO_LABELS.join(', ')}.
  If nothing in the list fits, use null.
- intent "none": anything else (target null).`;

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function toBase64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

// Omni is asked for bare JSON but may still wrap it in prose or a fence.
function parseModelJson(text) {
  const m = /\{[\s\S]*\}/.exec(text || '');
  if (!m) return null;
  try {
    return JSON.parse(m[0]);
  } catch {
    return null;
  }
}

// Body: WAV audio (16-bit PCM). Calls an OpenAI-compatible chat/completions endpoint (OMNI_BASE_URL)
// with the audio as input_audio. Response matches Depth/VoiceCommandResponse.cs in the Unity project.
export async function handleCommand(request, env) {
  if (request.method !== 'POST') return json({ intent: 'none', error: 'POST WAV audio' }, 405);
  if (!env.OMNI_BASE_URL || !env.OMNI_MODEL || !env.OMNI_API_KEY) {
    return json({ intent: 'none', error: 'OMNI_BASE_URL, OMNI_MODEL and secret OMNI_API_KEY must be set' }, 500);
  }

  const wav = new Uint8Array(await request.arrayBuffer());
  if (wav.length < 100) return json({ intent: 'none', error: 'empty audio' }, 400);

  const res = await fetch(env.OMNI_BASE_URL.replace(/\/+$/, '') + '/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + env.OMNI_API_KEY },
    body: JSON.stringify({
      model: env.OMNI_MODEL,
      temperature: 0,
      messages: [
        { role: 'system', content: SYSTEM },
        { role: 'user', content: [{ type: 'input_audio', input_audio: { data: toBase64(wav), format: 'wav' } }] },
      ],
    }),
  });
  if (!res.ok) return json({ intent: 'none', error: `omni ${res.status}: ${(await res.text()).slice(0, 200)}` }, 502);

  const content = (await res.json())?.choices?.[0]?.message?.content;
  const parsed = parseModelJson(typeof content === 'string' ? content : JSON.stringify(content));
  if (!parsed) return json({ intent: 'none', error: 'omni did not return JSON' }, 502);

  const target = String(parsed.target ?? '').toLowerCase();
  const valid = parsed.intent === 'find' && COCO_LABELS.includes(target);
  return json({
    intent: parsed.intent === 'find' ? 'find' : 'none',
    target: valid ? target : '',
    heard: String(parsed.heard ?? ''),
    reply: String(parsed.reply ?? ''),
  });
}
