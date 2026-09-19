import type { ClientMessage, ServerMessage, TrackerState } from "@lastseen/shared";

/** Minimal Node client speaking the real TrackerAgent WebSocket protocol (used by the sim and tests). */
export class SimClient {
  state: TrackerState | null = null;
  readonly messages: ServerMessage[] = [];
  private ws!: WebSocket;
  private waiters: Array<() => void> = [];

  constructor(
    private readonly baseUrl: string,
    private readonly device: string,
    private readonly token: string,
  ) {}

  async connect(role: "sim" | "dashboard" | "wearable" = "sim"): Promise<void> {
    const u = new URL(this.baseUrl);
    const proto = u.protocol === "https:" ? "wss:" : "ws:";
    const url = `${proto}//${u.host}/agents/tracker-agent/${encodeURIComponent(this.device)}?token=${encodeURIComponent(this.token)}`;
    this.ws = new WebSocket(url);
    this.ws.addEventListener("message", (e) => this.onRaw(String(e.data)));
    await new Promise<void>((resolve, reject) => {
      this.ws.addEventListener("open", () => resolve(), { once: true });
      this.ws.addEventListener("error", () => reject(new Error(`websocket failed: ${url.replace(this.token, "***")}`)), {
        once: true,
      });
    });
    this.send({ type: "hello", role });
  }

  private onRaw(data: string) {
    let m: { type?: string; state?: TrackerState };
    try {
      m = JSON.parse(data);
    } catch {
      return;
    }
    if (m.type === "cf_agent_state" && m.state) this.state = m.state;
    else if (m.type && !m.type.startsWith("cf_agent")) this.messages.push(m as ServerMessage);
    for (const w of this.waiters.splice(0)) w();
  }

  send(msg: ClientMessage) {
    this.ws.send(JSON.stringify(msg));
  }

  /** Wait until `pick` returns a value (checked on every incoming frame). */
  async waitFor<T>(pick: (c: SimClient) => T | undefined | null | false, timeoutMs = 15000): Promise<T> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const v = pick(this);
      if (v) return v;
      const left = deadline - Date.now();
      if (left <= 0) throw new Error("timed out waiting for condition");
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, Math.min(left, 250));
        this.waiters.push(() => {
          clearTimeout(t);
          resolve();
        });
      });
    }
  }

  close() {
    this.ws.close();
  }
}
