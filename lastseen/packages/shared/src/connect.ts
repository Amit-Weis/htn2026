import { AgentClient } from "agents/client";
import { ServerMessageSchema } from "./schemas";
import type { ClientMessage, ServerMessage, TrackerState } from "./schemas";

export interface TrackerConnectionOptions {
  /** e.g. location.host */
  host: string;
  device: string;
  token: string;
  onState?: (state: TrackerState) => void;
  onMessage?: (msg: ServerMessage) => void;
  onOpen?: () => void;
  onClose?: () => void;
}

export interface TrackerConnection {
  send(msg: ClientMessage): void;
  close(): void;
  readonly open: boolean;
}

/** Browser connector to the per-device TrackerAgent (auto-reconnecting via PartySocket). */
export function connectTracker(opts: TrackerConnectionOptions): TrackerConnection {
  const client = new AgentClient<unknown, TrackerState>({
    agent: "TrackerAgent",
    name: opts.device,
    host: opts.host,
    query: { token: opts.token },
    onStateUpdate: (state) => opts.onState?.(state),
  });
  client.addEventListener("open", () => opts.onOpen?.());
  client.addEventListener("close", () => opts.onClose?.());
  client.addEventListener("message", (e: MessageEvent) => {
    if (typeof e.data !== "string") return;
    let raw: unknown;
    try {
      raw = JSON.parse(e.data);
    } catch {
      return;
    }
    const parsed = ServerMessageSchema.safeParse(raw);
    if (parsed.success) opts.onMessage?.(parsed.data);
  });
  return {
    send: (msg) => client.send(JSON.stringify(msg)),
    close: () => client.close(),
    get open() {
      return client.readyState === WebSocket.OPEN;
    },
  };
}
