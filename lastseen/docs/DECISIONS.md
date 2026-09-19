# Decisions

Reasonable choices made without asking, newest last. Each line: decision, then why.

## M0

1. **Workspace lives in `lastseen/`, not the repo root.** The repo is a Unity project with a `Packages/` directory; on case-insensitive Windows/macOS filesystems `packages/shared` would collide with it. The brief's layout (`apps/`, `packages/`, `tools/`, `docs/`) is preserved one level down.
2. **Agent route is `/agents/tracker-agent/<deviceId>`.** The Agents SDK routes on the Durable Object *binding name*, so the binding is named `TrackerAgent` (same as the class) rather than `TRACKER`.
3. **Auth is a bearer token, also accepted as `?token=`.** Browsers cannot set headers on a WebSocket. Fail closed: no `DEVICE_TOKEN` configured means every request to `/agents/*` and `/api/*` (except `/api/health`) is rejected. Static assets are public (they contain no data); all data sits behind the agent.
4. **Clients never write agent state.** `validateStateChange` rejects any `setState` that does not originate on the server. Clients talk to the agent through typed messages (`ClientMessageSchema`).
5. **R2 is deferred.** R2 has to be enabled once in the Cloudflare dashboard (API error 10042); the binding is commented out in `wrangler.jsonc` and `env.FRAMES` is optional. Until it is enabled, small (160 px) thumbnails are kept in SQLite as data URLs, and keyframes are not persisted after OMNI has seen them. Enabling R2 is a two-line change (create the bucket, uncomment the binding).
6. **Keyframes go to R2 from the agent, before the Workflow starts, not inside it.** Workflow params and step outputs are capped (about 1 MiB), so six base64 JPEGs would not fit. The Workflow receives object keys. This reorders step (1) of the brief's pipeline; the pipeline is otherwise unchanged.
7. **Vectorize isolation uses the `namespace` query option (one per device), not a metadata filter.** No metadata index is needed and there is nothing to create up front. Index: `lastseen-objects`, 768 dims, cosine (Workers AI `@cf/baai/bge-base-en-v1.5`).
8. **OMNI adapter methods return `{ value, latencyMs, costCad }`** instead of the bare value in the brief's signatures, because the agent has to write latency and cost into every trace row.
9. **Strict JSON step protocol is the default even if native tool calling works.** One code path across proxies, and the same schema (`AgentStepSchema`) validates both real and mock output. One corrective retry on invalid JSON, then fail.
10. **Every OMNI call is streaming.** Qwen-Omni style endpoints are stream-only for audio output; using one code path for everything keeps it simple.
11. **The mock is the default whenever `MOCK_OMNI=1` *or* no `OMNI_API_KEY` is set.** Spending credit by accident is worse than silently mocking, and `/api/health` reports `mockOmni` so it is never invisible. `wrangler.jsonc` ships `MOCK_OMNI=1`; flip it to `0` after `wrangler secret put OMNI_API_KEY`.
12. **Mock test hook: base64 that decodes to JSON is a script.** A frame `{"mock":{"events":[...]}}` or audio `{"mockTranscript":"where are my keys"}` drives the mock deterministically, so the sim runs the real pipeline without images or speech. Anything else falls back to canned data.
13. **Cost is an estimate.** Pricing was not readable (yibuapi's pricing page is a client-rendered SPA). Defaults are deliberately high (2 / 8 CAD per M input / output tokens, 0.004 CAD flat when no usage block is returned) so the guard trips early, not late. Tunable with `OMNI_PRICE_IN_PER_M` / `OMNI_PRICE_OUT_PER_M`. The KV budget is read-modify-write and not atomic; it is a hard-ish cap, not an accountant.
14. **`vitest` v3, `eslint` v10, `typescript` 5.9.** Newer majors exist (TS 7, vitest 5) but the goal is a stable toolchain over a hackathon weekend. Tests are Node-only (no workerd pool); the Durable Object path is exercised by the sim over a real WebSocket against `wrangler dev`.
15. **Web apps are built into `apps/worker/public/`** (`/` from the wearable, `/dash/` from the dashboard) and served by Workers static assets. `run_worker_first` covers `/agents/*` and `/api/*` so assets can never shadow the backend.
