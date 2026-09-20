import { describe, expect, it } from "vitest";
import { candidate, pose, T0 } from "./testing/fixtures";
import { MAX_WAIT_MS, deviceOf, parseIngest, parseQuery, readJson, waitOf } from "./httpParse";

const u = (q = "") => new URL(`https://x.test/api/ingest${q}`);

describe("deviceOf / waitOf", () => {
  it("defaults, query and header", () => {
    expect(deviceOf(u(), new Headers())).toEqual({ ok: true, value: "default" });
    expect(deviceOf(u("?device=beam-1"), new Headers())).toEqual({ ok: true, value: "beam-1" });
    expect(deviceOf(u(), new Headers({ "X-Device-Id": "pro_2" }))).toEqual({ ok: true, value: "pro_2" });
  });
  it("rejects ids that could escape the route", () => {
    expect(deviceOf(u("?device=../x"), new Headers())).toMatchObject({ ok: false, status: 400 });
    expect(deviceOf(u("?device=a b"), new Headers())).toMatchObject({ ok: false });
    expect(deviceOf(u(`?device=${"a".repeat(65)}`), new Headers())).toMatchObject({ ok: false });
  });
  it("wait is capped", () => {
    expect(waitOf(u())).toBe(0);
    expect(waitOf(u("?wait=1"))).toBe(MAX_WAIT_MS);
    expect(waitOf(u("?wait=3000"))).toBe(3000);
    expect(waitOf(u("?wait=999999"))).toBe(MAX_WAIT_MS);
    expect(waitOf(u("?wait=nope"))).toBe(0);
  });
});

describe("readJson", () => {
  it("parses JSON, rejects garbage and oversize bodies", async () => {
    expect(await readJson(new Request("https://x.test", { method: "POST", body: '{"a":1}' }))).toEqual({ ok: true, value: { a: 1 } });
    expect(await readJson(new Request("https://x.test", { method: "POST", body: "{nope" }))).toMatchObject({ ok: false, status: 400 });
    expect(await readJson(new Request("https://x.test", { method: "POST", body: "{}", headers: { "Content-Length": String(50 * 1024 * 1024) } }))).toMatchObject({ ok: false, status: 413 });
  });
});

describe("parseIngest", () => {
  it("accepts a candidate with or without the WebSocket type tag", () => {
    const { type: _t, ...bare } = candidate();
    expect(parseIngest(bare)).toMatchObject({ ok: true });
    expect(parseIngest(candidate())).toMatchObject({ ok: true });
  });
  it("carries an optional stereo pair through", () => {
    const { type: _t, ...bare } = candidate();
    const r = parseIngest({ ...bare, stereo: { jpegBase64: "AAAA", baselineM: 0.065, swap: true } });
    expect(r.ok && r.value.stereo).toEqual({ jpegBase64: "AAAA", baselineM: 0.065, swap: true });
  });
  it("names what is wrong", () => {
    const r = parseIngest({ t: T0, trigger: "detector", frames: [], poseSlice: [], hfovDeg: 70 });
    expect(r).toMatchObject({ ok: false, status: 400 });
    expect(!r.ok && r.error).toContain("frames");
    expect(parseIngest("hello")).toMatchObject({ ok: false });
    expect(parseIngest(null)).toMatchObject({ ok: false });
  });
});

describe("parseQuery", () => {
  it("needs text or audio", () => {
    expect(parseQuery({ text: "where are my keys" })).toMatchObject({ ok: true });
    expect(parseQuery({ audioB64: "AAAA", mime: "audio/wav", poseAtT: pose(T0) })).toMatchObject({ ok: true });
    expect(parseQuery({})).toMatchObject({ ok: false, status: 400 });
    expect(parseQuery({ text: "" })).toMatchObject({ ok: false });
  });
});
