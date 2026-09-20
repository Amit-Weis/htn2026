import { describe, expect, it } from "vitest";
import { agentSocketUrl, buildDefaults, checkWorkerUrl, redactUrl, resolveSettings } from "./settingsStore";

describe("checkWorkerUrl", () => {
  it("accepts a bare host, https, and wss URLs", () => {
    expect(checkWorkerUrl("lastseen.m55chan.workers.dev")).toEqual({ ok: true, origin: "https://lastseen.m55chan.workers.dev", host: "lastseen.m55chan.workers.dev" });
    expect(checkWorkerUrl(" https://lastseen.example.dev/ ")).toMatchObject({ ok: true, host: "lastseen.example.dev" });
    expect(checkWorkerUrl("wss://lastseen.example.dev/agents/x")).toMatchObject({ ok: true, origin: "https://lastseen.example.dev" });
  });
  it("refuses cleartext except for localhost dev", () => {
    expect(checkWorkerUrl("http://lastseen.example.dev")).toMatchObject({ ok: false, error: expect.stringContaining("cleartext") });
    expect(checkWorkerUrl("ws://10.0.0.5:8787")).toMatchObject({ ok: false });
    expect(checkWorkerUrl("http://localhost:8787")).toMatchObject({ ok: true, host: "localhost:8787" });
    expect(checkWorkerUrl("http://127.0.0.1:8787")).toMatchObject({ ok: true });
  });
  it("rejects empty and garbage", () => {
    expect(checkWorkerUrl("")).toMatchObject({ ok: false });
    expect(checkWorkerUrl("   ")).toMatchObject({ ok: false });
    expect(checkWorkerUrl("https://")).toMatchObject({ ok: false });
    expect(checkWorkerUrl("ftp://example.com")).toMatchObject({ ok: false });
  });
});

describe("agentSocketUrl / redactUrl", () => {
  const s = { workerUrl: "https://lastseen.example.dev", deviceId: "my phone", deviceToken: "a b&c" };
  it("builds the agent WebSocket URL with an encoded device id and token", () => {
    expect(agentSocketUrl(s)).toBe("wss://lastseen.example.dev/agents/tracker-agent/my%20phone?token=a%20b%26c");
    expect(agentSocketUrl({ ...s, workerUrl: "http://localhost:8787", deviceId: "" })).toMatch(/^ws:\/\/localhost:8787\/agents\/tracker-agent\/demo\?/);
  });
  it("throws for an unusable Worker URL", () => {
    expect(() => agentSocketUrl({ ...s, workerUrl: "http://evil.example" })).toThrow(/cleartext/);
  });
  it("never leaves the token in a logged URL", () => {
    expect(redactUrl(agentSocketUrl(s))).not.toContain("a%20b");
    expect(redactUrl(agentSocketUrl(s))).toContain("token=***");
  });
});

describe("build-time defaults", () => {
  it("come from VITE_* env, not from source", () => {
    expect(buildDefaults({ VITE_WORKER_URL: "https://w.example.dev", VITE_DEVICE_TOKEN: "tok", VITE_DEVICE_ID: "d1" })).toEqual({ workerUrl: "https://w.example.dev", deviceToken: "tok", deviceId: "d1" });
    expect(buildDefaults({})).toEqual({ workerUrl: "", deviceToken: "", deviceId: "demo" });
  });
});

describe("resolveSettings", () => {
  const defaults = { workerUrl: "https://build.example.dev", deviceId: "demo", deviceToken: "build-token" };
  it("prefers URL query params over build defaults", () => {
    expect(resolveSettings(new URLSearchParams("host=w.example.dev&device=d2&token=t2"), defaults)).toEqual({ workerUrl: "w.example.dev", deviceId: "d2", deviceToken: "t2" });
  });
  it("falls back to the build defaults for whatever the query omits", () => {
    expect(resolveSettings(new URLSearchParams("token=t2"), defaults)).toEqual({ workerUrl: "https://build.example.dev", deviceId: "demo", deviceToken: "t2" });
    expect(resolveSettings(new URLSearchParams(""), defaults)).toEqual(defaults);
  });
});
