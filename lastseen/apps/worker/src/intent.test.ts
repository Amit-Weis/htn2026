import { IntentResultSchema } from "@lastseen/shared";
import { describe, expect, it } from "vitest";
import { TARGETS, isKnownTarget, keywordFound, keywordIntent, matchTarget, resolveIntent } from "./intent";
import { parseIntent } from "./httpParse";
import { BudgetGuard } from "./omni/budget";
import { HttpOmni } from "./omni/http";
import { MockOmni } from "./omni/mock";
import type { OmniClient } from "./omni/types";

const enc = (o: unknown) => btoa(JSON.stringify(o));

describe("naming the hacker badge", () => {
  it.each(["hacker badge", "my hacker tag", "Hacker Card", "hackertag", "hacker's badge", "hacker pass", "my badge", "name tag", "the lanyard", "conference badge"])(
    "%s is the hacker card",
    (say) => {
      expect(matchTarget(say)).toBe("hacker_card");
    },
  );

  it.each(["where are my keys", "what time is it", "my credit card", "the tag on my shirt", "hacker news", ""])("%s is not", (say) => {
    expect(matchTarget(say)).toBeNull();
  });

  it("a name alone is not a request, a name with a 'find' word is", () => {
    expect(keywordIntent("nice hacker badge")).toBeNull();
    expect(keywordIntent("where is my hacker badge")).toBe("hacker_card");
    expect(keywordIntent("Find my hacker tag please")).toBe("hacker_card");
    expect(keywordIntent("I can't find my badge")).toBe("hacker_card");
    expect(keywordIntent("I lost my name tag")).toBe("hacker_card");
    expect(keywordIntent("where are my keys")).toBeNull();
  });

  it("knows its target ids", () => {
    expect(isKnownTarget("hacker_card")).toBe(true);
    expect(isKnownTarget("keys")).toBe(false);
    expect(isKnownTarget(null)).toBe(false);
  });
});

describe("resolveIntent with the mock", () => {
  const omni = new MockOmni();

  it("points at the target for a typed request", async () => {
    const r = await resolveIntent(omni, "where is my hacker badge", null);
    expect(r).toMatchObject({ heard: "where is my hacker badge", wants: "hacker_card", source: "omni" });
    expect(r.say).toContain("hacker badge");
  });

  it("points at the target for a scripted spoken request, and ignores unrelated ones", async () => {
    const yes = await resolveIntent(omni, undefined, { b64: enc({ mockTranscript: "find my hacker tag" }), mime: "audio/wav" });
    expect(yes.wants).toBe("hacker_card");
    const no = await resolveIntent(omni, undefined, { b64: enc({ mockTranscript: "where are my keys" }), mime: "audio/wav" });
    expect(no).toMatchObject({ wants: null, say: "" });
  });
});

describe("saying you found it", () => {
  it.each(["I found my hacker tag", "found my hacker badge", "got my badge", "never mind I have my name tag", "here it is, my hacker badge", "I've got my hacker card"])(
    "%s means the arrow can go away",
    (say) => {
      expect(keywordFound(say)).toBe("hacker_card");
      expect(keywordIntent(say)).toBeNull(); // never both
    },
  );

  it.each(["where is my hacker badge", "have you seen my hacker tag", "can you find my badge", "I found my keys", "nice hacker badge", "I lost my name tag"])(
    "%s does not",
    (say) => {
      expect(keywordFound(say)).toBeNull();
    },
  );

  it("is understood through the mock, typed and spoken", async () => {
    const omni = new MockOmni();
    expect(await resolveIntent(omni, "I found my hacker tag", null)).toMatchObject({ wants: null, found: "hacker_card", source: "omni" });
    const spoken = await resolveIntent(omni, undefined, { b64: enc({ mockTranscript: "got my badge" }), mime: "audio/wav" });
    expect(spoken).toMatchObject({ wants: null, found: "hacker_card" });
    expect(await resolveIntent(omni, "where is my hacker badge", null)).toMatchObject({ wants: "hacker_card", found: null });
    expect(await resolveIntent(omni, "I found my keys", null)).toMatchObject({ wants: null, found: null });
  });

  it("uses OMNI's answer, never sets both, and falls back to the words when OMNI fails", async () => {
    const both = { understandIntent: async () => ({ value: { heard: "x", wants: "hacker_card", found: "hacker_card", say: "" }, latencyMs: 0, costCad: 0 }) } as unknown as OmniClient;
    expect(await resolveIntent(both, "x", null)).toMatchObject({ wants: null, found: "hacker_card" });
    const broken = { understandIntent: () => Promise.reject(new Error("down")) } as unknown as OmniClient;
    expect(await resolveIntent(broken, "I found my hacker tag", null)).toMatchObject({ wants: null, found: "hacker_card", source: "keywords" });
    expect(await resolveIntent(broken, "where is my hacker tag", null)).toMatchObject({ wants: "hacker_card", found: null, source: "keywords" });
  });
});

describe("resolveIntent when OMNI misbehaves", () => {
  const broken = { understandIntent: () => Promise.reject(new Error("OMNI returned invalid JSON twice")) } as unknown as OmniClient;

  it("falls back to the keyword rule for typed text, and says so", async () => {
    const r = await resolveIntent(broken, "where is my hacker badge", null);
    expect(r).toMatchObject({ wants: "hacker_card", source: "keywords" });
    expect(r.note).toContain("invalid JSON");
  });

  it("answers nothing for audio it could not hear, and for text that is not a request", async () => {
    expect((await resolveIntent(broken, undefined, { b64: "QUJD", mime: "audio/wav" })).wants).toBeNull();
    expect((await resolveIntent(broken, "what time is it", null)).wants).toBeNull();
  });

  it("does not trust an id it never offered", async () => {
    const liar = { understandIntent: async () => ({ value: { heard: "x", wants: "nuclear_codes", say: "here" }, latencyMs: 0, costCad: 0 }) } as unknown as OmniClient;
    expect(await resolveIntent(liar, "x", null)).toMatchObject({ wants: null, say: "" });
  });

  it("lets OMNI say no even when the words look like a request", async () => {
    const no = { understandIntent: async () => ({ value: { heard: "where is the badge scanner", wants: null, say: "" }, latencyMs: 0, costCad: 0 }) } as unknown as OmniClient;
    expect((await resolveIntent(no, "where is the badge scanner", null)).wants).toBeNull();
  });
});

describe("HttpOmni.understandIntent", () => {
  const sse = (...chunks: unknown[]) =>
    new Response(chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("") + "data: [DONE]\n\n", { status: 200, headers: { "Content-Type": "text/event-stream" } });
  const delta = (content: string) => ({ choices: [{ delta: { content } }] });
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

  it("sends the target list and the audio, and parses the JSON answer", async () => {
    let sent: { messages: Array<{ role: string; content: unknown }> } | undefined;
    const omni = new HttpOmni({
      apiKey: "k",
      baseUrl: "https://x/v1",
      model: "m",
      budget: new BudgetGuard(new MemKV() as unknown as KVNamespace, 30),
      fetchImpl: (async (_u: string, init: RequestInit) => {
        sent = JSON.parse(String(init.body));
        return sse(delta('{"heard":"where is my hacker tag","wants":"hacker_card",'), delta('"say":"Pointing you to your badge."}'));
      }) as unknown as typeof fetch,
    });
    const r = await omni.understandIntent({ b64: "QUJD", mime: "audio/wav" }, undefined, TARGETS);
    expect(IntentResultSchema.parse(r.value)).toMatchObject({ wants: "hacker_card", say: "Pointing you to your badge." });
    const system = String(sent?.messages[0]?.content);
    expect(system).toContain("hacker_card");
    expect(system).toContain("hacker tag");
    const parts = sent?.messages[1]?.content as Array<{ type: string }>;
    expect(parts.some((p) => p.type === "input_audio")).toBe(true);
  });

  it("accepts a null answer", async () => {
    const omni = new HttpOmni({
      apiKey: "k",
      baseUrl: "https://x/v1",
      model: "m",
      budget: new BudgetGuard(new MemKV() as unknown as KVNamespace, 30),
      fetchImpl: (async () => sse(delta('{"heard":"nice weather","wants":null,"say":""}'))) as unknown as typeof fetch,
    });
    const r = await omni.understandIntent(null, "nice weather", TARGETS);
    expect(r.value.wants).toBeNull();
  });
});

describe("parseIntent", () => {
  it("needs text or audio", () => {
    expect(parseIntent({}).ok).toBe(false);
    expect(parseIntent({ text: "" }).ok).toBe(false);
    expect(parseIntent({ text: "where is my hacker badge" }).ok).toBe(true);
    expect(parseIntent({ audioB64: "QUJD", mime: "audio/wav" }).ok).toBe(true);
    expect(parseIntent(null).ok).toBe(false);
  });
});
