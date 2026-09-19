import { Agent } from "agents";
import type { Connection, WSMessage } from "agents";
import { ClientMessageSchema, INITIAL_STATE } from "@lastseen/shared";
import type { ServerMessage, TrackerState } from "@lastseen/shared";
import type { Env } from "./env";

export class TrackerAgent extends Agent<Env, TrackerState> {
  override initialState: TrackerState = INITIAL_STATE;

  /** State is server-owned: clients talk to the agent through messages, never setState. */
  override validateStateChange(_next: TrackerState, source: Connection | "server") {
    if (source !== "server") throw new Error("state is server-owned");
  }

  override onStart() {
    this.sql`CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT)`;
  }

  private send(connection: Connection, msg: ServerMessage) {
    connection.send(JSON.stringify(msg));
  }

  override onMessage(connection: Connection, message: WSMessage) {
    if (typeof message !== "string") return;
    let raw: unknown;
    try {
      raw = JSON.parse(message);
    } catch {
      return this.send(connection, { type: "error", message: "invalid json" });
    }
    const parsed = ClientMessageSchema.safeParse(raw);
    if (!parsed.success) return this.send(connection, { type: "error", message: "invalid message" });

    switch (parsed.data.type) {
      case "hello":
        this.send(connection, { type: "reply", text: `hello ${parsed.data.role} from TrackerAgent ${this.name}` });
        break;
      default:
        break;
    }
  }
}
