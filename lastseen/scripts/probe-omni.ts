// Probes the OMNI proxy (OpenAI-compatible) and writes docs/omni-capabilities.md.
//   OMNI_API_KEY=... OMNI_BASE_URL=https://yibuapi.com/v1 OMNI_MODEL=... pnpm probe:omni
// Each probe is one tiny call to keep credit use negligible. Nothing here is a guess: the
// document records what actually happened, including failures and raw error bodies.
import { deflateSync } from "node:zlib";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Reads OMNI_* from ./.env when present (Node >= 20.12). Not done for the sim: that .env may hold the production token.
try {
  (process as unknown as { loadEnvFile?: (p: string) => void }).loadEnvFile?.(fileURLToPath(new URL("../.env", import.meta.url)));
} catch {
  /* no .env: rely on the process environment */
}

const KEY = process.env.OMNI_API_KEY ?? "";
const BASE = (process.env.OMNI_BASE_URL ?? "https://yibuapi.com/v1").replace(/\/$/, "");
const MODEL = process.env.OMNI_MODEL ?? "qwen3.5-omni-flash";
const OUT = fileURLToPath(new URL("../docs/omni-capabilities.md", import.meta.url));

if (!KEY) {
  console.error("OMNI_API_KEY is not set. Put it in .env (see .env.example) or export it.");
  process.exit(2);
}

interface Result {
  name: string;
  ok: boolean;
  ms: number;
  detail: string;
}
const results: Result[] = [];
const models: string[] = [];
let audioOut: { b64: string; format: string } | null = null;

async function probe(name: string, fn: () => Promise<string>) {
  const t0 = performance.now();
  try {
    const detail = await fn();
    results.push({ name, ok: true, ms: Math.round(performance.now() - t0), detail });
  } catch (e) {
    results.push({ name, ok: false, ms: Math.round(performance.now() - t0), detail: String(e instanceof Error ? e.message : e) });
  }
  const r = results[results.length - 1]!;
  console.log(`${r.ok ? "PASS" : "FAIL"} ${r.name} (${r.ms} ms) ${r.detail.slice(0, 140).replace(/\n/g, " ")}`);
}

const headers = { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" };

interface ChatJson {
  usage?: unknown;
  choices?: Array<{ message?: { content?: string; tool_calls?: unknown[] } }>;
}

async function chat(body: Record<string, unknown>): Promise<{ json: ChatJson; text: string }> {
  const res = await fetch(`${BASE}/chat/completions`, { method: "POST", headers, body: JSON.stringify({ model: MODEL, ...body }) });
  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 600)}`);
  return { json: JSON.parse(text) as ChatJson, text };
}

/** Streaming call; returns concatenated text, audio base64 chunks, usage, and time to first token. */
async function chatStream(body: Record<string, unknown>) {
  const t0 = performance.now();
  const res = await fetch(`${BASE}/chat/completions`, {
    method: "POST",
    headers,
    body: JSON.stringify({ model: MODEL, stream: true, stream_options: { include_usage: true }, ...body }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 600)}`);
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  let buf = "";
  let text = "";
  const audio: string[] = [];
  let usage: unknown;
  let ttft = 0;
  let chunks = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i: number;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (data === "[DONE]") continue;
      const j = JSON.parse(data);
      chunks++;
      if (j.usage) usage = j.usage;
      const d = j.choices?.[0]?.delta;
      if (d?.content) {
        if (!ttft) ttft = performance.now() - t0;
        text += d.content;
      }
      if (d?.audio?.data) {
        if (!ttft) ttft = performance.now() - t0;
        audio.push(d.audio.data);
      }
    }
  }
  return { text, audio, usage, ttftMs: Math.round(ttft), chunks };
}

/** Solid-color 64x64 PNG built by hand (no deps). */
function tinyPng(r: number, g: number, b: number): string {
  const w = 64;
  const raw = Buffer.alloc((w * 3 + 1) * w);
  for (let y = 0; y < w; y++) {
    raw[y * (w * 3 + 1)] = 0;
    for (let x = 0; x < w; x++) raw.set([r, g, b], y * (w * 3 + 1) + 1 + x * 3);
  }
  const crcT = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (buf: Buffer) => {
    let c = 0xffffffff;
    for (const x of buf) c = crcT[(c ^ x) & 255]! ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const c = Buffer.alloc(4);
    c.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(w, 4);
  ihdr.set([8, 2, 0, 0, 0], 8);
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]).toString("base64");
}

/** Wrap raw 16-bit mono PCM in a WAV header. */
function pcmToWav(pcm: Buffer, rate = 24000): Buffer {
  const h = Buffer.alloc(44);
  h.write("RIFF", 0);
  h.writeUInt32LE(36 + pcm.length, 4);
  h.write("WAVEfmt ", 8);
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);
  h.writeUInt16LE(1, 22);
  h.writeUInt32LE(rate, 24);
  h.writeUInt32LE(rate * 2, 28);
  h.writeUInt16LE(2, 32);
  h.writeUInt16LE(16, 34);
  h.write("data", 36);
  h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}

await probe("model list (GET /models)", async () => {
  const res = await fetch(`${BASE}/models`, { headers });
  const body = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${body.slice(0, 400)}`);
  const ids: string[] = (JSON.parse(body).data ?? []).map((m: { id: string }) => m.id);
  models.push(...ids);
  const omni = ids.filter((i) => /omni|qwen/i.test(i));
  return `${ids.length} models; omni/qwen: ${omni.join(", ") || "(none matched)"}; configured model present: ${ids.includes(MODEL)}`;
});

await probe("text chat", async () => {
  const { json } = await chat({ messages: [{ role: "user", content: "Reply with exactly: pong" }], max_tokens: 16 });
  return `reply=${JSON.stringify(json.choices?.[0]?.message?.content)} usage=${JSON.stringify(json.usage)}`;
});

await probe("image input (base64 data URL)", async () => {
  const { json } = await chat({
    messages: [
      {
        role: "user",
        content: [
          { type: "image_url", image_url: { url: `data:image/png;base64,${tinyPng(220, 20, 20)}` } },
          { type: "text", text: "What is the dominant color of this image? One word." },
        ],
      },
    ],
    max_tokens: 16,
  });
  return `reply=${JSON.stringify(json.choices?.[0]?.message?.content)} (expected red) usage=${JSON.stringify(json.usage)}`;
});

await probe("streaming text (SSE)", async () => {
  const r = await chatStream({ messages: [{ role: "user", content: "Count from 1 to 5." }], max_tokens: 40 });
  return `ttft=${r.ttftMs}ms chunks=${r.chunks} text=${JSON.stringify(r.text)} usage=${JSON.stringify(r.usage)}`;
});

await probe("speech/audio OUTPUT (modalities:[text,audio], stream)", async () => {
  const r = await chatStream({
    messages: [{ role: "user", content: "Say: your keys are on the desk." }],
    modalities: ["text", "audio"],
    audio: { voice: "Cherry", format: "wav" },
    max_tokens: 60,
  });
  if (!r.audio.length) throw new Error(`no audio chunks returned; text=${JSON.stringify(r.text)}`);
  audioOut = { b64: r.audio.join(""), format: "pcm16-24k?" };
  return `ttft=${r.ttftMs}ms audio chunks=${r.audio.length} bytes~${Buffer.from(audioOut.b64, "base64").length} text=${JSON.stringify(r.text)}`;
});

// The API's documented audio input encoding is unverified, so try both and record which passes.
for (const style of ["datauri", "raw"] as const) {
  await probe(`audio INPUT, data as ${style === "datauri" ? "data:;base64 URI" : "raw base64"} (feed the speech back in)`, async () => {
    if (!audioOut) throw new Error("skipped: no audio produced by the previous probe");
    const pcm = Buffer.from(audioOut.b64, "base64");
    const wav = pcm.subarray(0, 4).toString() === "RIFF" ? pcm : pcmToWav(pcm);
    const data = style === "datauri" ? `data:;base64,${wav.toString("base64")}` : wav.toString("base64");
    const r = await chatStream({
      messages: [
        {
          role: "user",
          content: [
            { type: "input_audio", input_audio: { data, format: "wav" } },
            { type: "text", text: "Transcribe the audio exactly." },
          ],
        },
      ],
      max_tokens: 60,
    });
    return `ttft=${r.ttftMs}ms transcript=${JSON.stringify(r.text)} usage=${JSON.stringify(r.usage)}`;
  });
}

await probe("JSON mode (response_format json_object)", async () => {
  const { json } = await chat({
    messages: [{ role: "user", content: 'Return a JSON object {"ok": true, "n": 3}.' }],
    response_format: { type: "json_object" },
    max_tokens: 40,
  });
  const c = json.choices?.[0]?.message?.content ?? "";
  JSON.parse(c);
  return `parsed OK: ${c}`;
});

await probe("native tool calling (tools + tool_choice auto)", async () => {
  const { json } = await chat({
    messages: [{ role: "user", content: "Where are my keys? Use the tool." }],
    tools: [
      {
        type: "function",
        function: {
          name: "find_object",
          description: "Find an object by name",
          parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
        },
      },
    ],
    tool_choice: "auto",
    max_tokens: 60,
  });
  const tc = json.choices?.[0]?.message?.tool_calls;
  if (!tc?.length) throw new Error(`no tool_calls; content=${JSON.stringify(json.choices?.[0]?.message?.content)}`);
  return `tool_calls=${JSON.stringify(tc)}`;
});

const md = `# OMNI capabilities (measured)

Generated by \`pnpm probe:omni\` on ${new Date().toISOString()}.
Base URL: \`${BASE}\` - model: \`${MODEL}\`.

| Probe | Result | Latency | Detail |
| --- | --- | --- | --- |
${results.map((r) => `| ${r.name} | ${r.ok ? "PASS" : "FAIL"} | ${r.ms} ms | ${r.detail.replace(/\|/g, "\\|").replace(/\n/g, " ").slice(0, 400)} |`).join("\n")}

## Models offered
${models.length ? models.map((m) => `- \`${m}\``).join("\n") : "(model list unavailable)"}

## Adapter consequences
- Native tool calling: ${results.find((r) => r.name.startsWith("native tool"))?.ok ? "supported, but the adapter still uses the strict JSON step protocol by default for determinism" : "NOT supported: adapter uses the strict JSON step protocol"}
- Audio output: ${results.find((r) => r.name.startsWith("speech"))?.ok ? "supported (OMNI speech played on the phone)" : "NOT supported: phone falls back to browser speechSynthesis"}
- Audio input: ${results.some((r) => r.name.startsWith("audio INPUT") && r.ok) ? "supported (required by the Huawei track; used on the query path). If only the raw base64 variant passed, set OMNI_AUDIO_STYLE=raw" : "NOT verified: check the failures above before relying on the query path"}
`;
writeFileSync(OUT, md);
console.log(`\nWrote ${OUT}`);
