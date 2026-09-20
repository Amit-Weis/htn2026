// M0 smoke test: WebSocket round trip against a running (local or deployed) worker.
//   LASTSEEN_URL=https://lastseen.<acct>.workers.dev DEVICE_TOKEN=... pnpm --filter @lastseen/sim roundtrip
import { SimClient } from "./client";

const url = process.env.LASTSEEN_URL ?? "http://localhost:8787";
const token = process.env.DEVICE_TOKEN ?? "dev-token";

const c = new SimClient(url, `roundtrip-${Date.now()}`, token);
const t0 = Date.now();
await c.connect();
const reply = await c.waitFor((x) => x.messages.find((m) => m.type === "notice" || m.type === "reply"));
console.log(`round trip ok in ${Date.now() - t0} ms:`, reply);
c.close();
process.exit(0);
