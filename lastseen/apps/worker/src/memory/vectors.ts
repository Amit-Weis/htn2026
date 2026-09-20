import type { Ledger } from "../ledger";
import { cosine } from "./text";

export interface VectorMatch {
  id: string;
  score: number;
}

/** Semantic index over objects, isolated per device. */
export interface VectorStore {
  upsert(id: string, values: number[]): Promise<void>;
  query(values: number[], topK: number): Promise<VectorMatch[]>;
  remove(ids: string[]): Promise<void>;
}

/** Cloudflare Vectorize, one namespace per device. Note: upserts become queryable asynchronously. */
export class VectorizeStore implements VectorStore {
  constructor(
    private readonly index: VectorizeIndex,
    private readonly namespace: string,
  ) {}
  async upsert(id: string, values: number[]) {
    await this.index.upsert([{ id, values, namespace: this.namespace }]);
  }
  async query(values: number[], topK: number) {
    const r = await this.index.query(values, { topK, namespace: this.namespace, returnMetadata: "none" });
    return r.matches.map((m) => ({ id: m.id, score: m.score }));
  }
  async remove(ids: string[]) {
    if (ids.length) await this.index.deleteByIds(ids);
  }
}

/** Brute-force cosine over SQLite-stored vectors (local dev / CI, or as a fallback). */
export class SqlVectorStore implements VectorStore {
  constructor(private readonly ledger: Ledger) {}
  async upsert(id: string, values: number[]) {
    this.ledger.putVector(id, values);
  }
  async query(values: number[], topK: number) {
    return this.ledger
      .allVectors()
      .map((v) => ({ id: v.id, score: cosine(values, v.vec) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, topK);
  }
  async remove(ids: string[]) {
    for (const id of ids) this.ledger.deleteVector(id);
  }
}
