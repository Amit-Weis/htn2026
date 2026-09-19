import { AgentStepSchema, PlacementResultSchema, VerifyResultSchema } from "@lastseen/shared";
import { describe, expect, it } from "vitest";
import { BudgetGuard, estimateCad } from "./budget";
import { HttpOmni, extractJson, pcm16ToWav } from "./http";
import { MockOmni } from "./mock";
import { BudgetExceededError } from "./types";
import type { UtteranceCtx } from "./types";

const enc = (o: unknown) => btoa(JSON.stringify(o));

class MemKV {
  private m = new Map<string, string>();
  async get(k: string, type?: string) {
    const v = this.m.get(k);
    return v === undefined ? null : type === "json" ? JSON.parse(v) : v;
  }
  async put(k: string, v: string) {
    this.m.set(k, v);
  }
}
const kv = () => new MemKV() as unknown as KVNamespace;

interface Sent {
  stream: boolean;
  messages: Array<{ content: Array<{ type: string; input_audio?: { format: string }; image_url?: { url: string } }> }>;
}

const ctx = (over: Partial<UtteranceCtx> = {}): UtteranceCtx => ({ memorySummary: "", history: [], ...over });

describe("MockOmni step protocol", () => {
  const omni = new MockOmni();

  it("returns schema-valid placements, scripted or canned", async () => {
    const scripted = { mock: { events: [{ kind: "placed", label: "keys", description: "d", distinguishing_features: [], surface: "desk", zone_name: "desk", bbox: [0.4, 0.5, 0.2, 0.2], distance_m: 1, holder: "wearer", confidence: 0.9 }] } };
    const a = await omni.extractPlacements([{ b64: enc(scripted) }], { knownZones: [] });
    expect(PlacementResultSchema.parse(a.value).events[0]?.label).toBe("keys");
    const b = await omni.extractPlacements([{ b64: "AAAA" }], { knownZones: [] });
    expect(PlacementResultSchema.safeParse(b.value).success).toBe(true);
  });

  it("where are my keys -> find_object", async () => {
    const r = await omni.understandUtterance(null, ctx({ text: "Where are my keys?" }));
    expect(AgentStepSchema.parse(r.value)).toMatchObject({ type: "tool", tool: "find_object", args: { query: "keys" } });
  });

  it("find_object result -> guide_to -> final", async () => {
    const found = { tool: "find_object", args: { query: "keys" }, result: { candidates: [{ objectId: "o1", label: "keys", score: 0.9 }] } };
    const s2 = await omni.understandUtterance(null, ctx({ history: [{ role: "user", content: "where are my keys" }, { role: "tool", content: JSON.stringify(found) }] }));
    expect(s2.value).toMatchObject({ type: "tool", tool: "guide_to", args: { objectId: "o1" } });
    const guided = { tool: "guide_to", args: { objectId: "o1" }, result: { ok: true, label: "keys", zone: "desk", ageSec: 720 } };
    const s3 = await omni.understandUtterance(null, ctx({ history: [{ role: "user", content: "where are my keys" }, { role: "tool", content: JSON.stringify(guided) }] }));
    expect(s3.value).toMatchObject({ type: "final" });
    expect((s3.value as { text: string }).text).toContain("12 min ago");
  });

  it("asks to clarify when two different objects score the same", async () => {
    const found = { tool: "find_object", args: { query: "screwdriver" }, result: { candidates: [{ objectId: "a", label: "phillips screwdriver", score: 0.8 }, { objectId: "b", label: "flathead screwdriver", score: 0.79 }] } };
    const r = await omni.understandUtterance(null, ctx({ history: [{ role: "user", content: "where is my screwdriver" }, { role: "tool", content: JSON.stringify(found) }] }));
    expect(r.value).toMatchObject({ type: "tool", tool: "clarify" });
  });

  it("ignores ambient chatter (addressed=false)", async () => {
    const r = await omni.understandUtterance({ b64: enc({ mockTranscript: "did you see the game", addressed: false }), mime: "audio/wav" }, ctx());
    expect(r.value).toMatchObject({ type: "final", addressed: false, text: "" });
  });

  it("handles list_recent, forget-all and forget-X", async () => {
    expect((await omni.understandUtterance(null, ctx({ text: "what did I put down last" }))).value).toMatchObject({ tool: "list_recent" });
    expect((await omni.understandUtterance(null, ctx({ text: "forget everything" }))).value).toMatchObject({ tool: "forget", args: { objectId: "all" } });
    expect((await omni.understandUtterance(null, ctx({ text: "forget the keys" }))).value).toMatchObject({ tool: "find_object", args: { query: "keys" } });
  });

  it("verifyVisible honors a scripted frame", async () => {
    const r = await omni.verifyVisible({ b64: enc({ mock: { visible: false, note: "gone" } }) }, "keys");
    expect(VerifyResultSchema.parse(r.value)).toMatchObject({ visible: false, note: "gone" });
  });
});

describe("extractJson", () => {
  it("tolerates fences, prose, braces in strings", () => {
    expect(extractJson('sure!\n```json\n{"a":"}{","b":{"c":1}}\n```')).toEqual({ a: "}{", b: { c: 1 } });
  });
  it("throws without an object", () => expect(() => extractJson("no json")).toThrow());
});

describe("pcm16ToWav", () => {
  it("writes a valid 44-byte header", () => {
    const wav = pcm16ToWav(new Uint8Array(10), 24000);
    expect(new TextDecoder().decode(wav.subarray(0, 4))).toBe("RIFF");
    expect(new DataView(wav.buffer).getUint32(40, true)).toBe(10);
    expect(wav.length).toBe(54);
  });
});

function sse(...chunks: unknown[]): Response {
  const body = chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("") + "data: [DONE]\n\n";
  return new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream" } });
}
const delta = (content: string) => ({ choices: [{ delta: { content } }] });
const usage = { usage: { prompt_tokens: 1000, completion_tokens: 100 }, choices: [] };

describe("HttpOmni", () => {
  it("parses a streamed step, sends audio+image parts, and charges the budget", async () => {
    let sent: Sent | undefined;
    const budget = new BudgetGuard(kv(), 30);
    const omni = new HttpOmni({
      apiKey: "k",
      baseUrl: "https://x/v1",
      model: "m",
      budget,
      fetchImpl: (async (_u: string, init: RequestInit) => {
        sent = JSON.parse(String(init.body)) as Sent;
        return sse(delta('{"type":"tool","addressed":true,"transcript":"where are my keys",'), delta('"tool":"find_object","args":{"query":"keys"}}'), usage);
      }) as unknown as typeof fetch,
    });
    const r = await omni.understandUtterance({ b64: "QUJD", mime: "audio/wav" }, ctx({ latestFrame: { b64: "SU1H" } }));
    expect(r.value).toMatchObject({ type: "tool", tool: "find_object" });
    expect(r.costCad).toBeCloseTo(estimateCad({ prompt_tokens: 1000, completion_tokens: 100 }));
    expect(sent?.stream).toBe(true);
    const parts = sent?.messages[1]?.content ?? [];
    expect(parts.some((p) => p.type === "input_audio" && p.input_audio?.format === "wav")).toBe(true);
    expect(parts.some((p) => p.type === "image_url" && p.image_url?.url.startsWith("data:image/jpeg;base64,"))).toBe(true);
    expect((await budget.read()).calls).toBe(1);
  });

  it("retries once on invalid JSON, then succeeds", async () => {
    let calls = 0;
    const omni = new HttpOmni({
      apiKey: "k", baseUrl: "https://x/v1", model: "m", budget: new BudgetGuard(kv(), 30),
      fetchImpl: (async () => (++calls === 1 ? sse(delta("I think you want keys")) : sse(delta('{"type":"final","addressed":true,"text":"ok"}')))) as unknown as typeof fetch,
    });
    const r = await omni.understandUtterance(null, ctx({ text: "hi" }));
    expect(calls).toBe(2);
    expect(r.value).toMatchObject({ type: "final", text: "ok" });
  });

  it("refuses to call once the budget cap is reached", async () => {
    const store = kv();
    const budget = new BudgetGuard(store, 0.01);
    await budget.charge(0.02);
    let called = false;
    const omni = new HttpOmni({ apiKey: "k", baseUrl: "https://x/v1", model: "m", budget, fetchImpl: (async () => { called = true; return sse(); }) as unknown as typeof fetch });
    await expect(omni.understandUtterance(null, ctx({ text: "hi" }))).rejects.toBeInstanceOf(BudgetExceededError);
    expect(called).toBe(false);
  });

  it("speak() assembles streamed PCM into a WAV, and degrades to null on failure", async () => {
    const pcmB64 = btoa(String.fromCharCode(...new Uint8Array(8)));
    const ok = new HttpOmni({
      apiKey: "k", baseUrl: "https://x/v1", model: "m", budget: new BudgetGuard(kv(), 30),
      fetchImpl: (async () => sse({ choices: [{ delta: { audio: { data: pcmB64 } } }] }, { choices: [{ delta: { audio: { data: pcmB64 } } }] })) as unknown as typeof fetch,
    });
    const r = await ok.speak("hello");
    expect(r.value?.mime).toBe("audio/wav");
    expect(atob(r.value!.b64).length).toBe(44 + 16);

    const bad = new HttpOmni({
      apiKey: "k", baseUrl: "https://x/v1", model: "m", budget: new BudgetGuard(kv(), 30),
      fetchImpl: (async () => new Response("nope", { status: 400 })) as unknown as typeof fetch,
    });
    expect((await bad.speak("hello")).value).toBeNull();
    expect(bad.capabilities.audioOutput).toBe(false);
  });
});
