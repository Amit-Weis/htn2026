import { DatabaseSync } from "node:sqlite";
import type { SqlTag } from "../ledger";

/** In-memory SQLite behind the same tagged-template interface as the Agents SDK's `this.sql`. */
export function memorySql(): SqlTag {
  const db = new DatabaseSync(":memory:");
  return ((strings: TemplateStringsArray, ...values: (string | number | boolean | null)[]) => {
    const q = strings.reduce((acc, s, i) => acc + s + (i < values.length ? "?" : ""), "");
    return db.prepare(q).all(...values.map((v) => (typeof v === "boolean" ? (v ? 1 : 0) : v)));
  }) as SqlTag;
}
