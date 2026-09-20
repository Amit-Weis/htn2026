import { expand } from "./text";

export const EMBED_DIMS = 768;

export interface Embedder {
  embed(text: string): Promise<number[]>;
}

/** Deterministic offline embedder: hashed bag of (synonym-expanded) tokens. For local dev, CI and the sim. */
export class LocalEmbedder implements Embedder {
  async embed(text: string): Promise<number[]> {
    const v = new Array<number>(EMBED_DIMS).fill(0);
    for (const t of expand(text)) {
      let h = 2166136261;
      for (let i = 0; i < t.length; i++) h = Math.imul(h ^ t.charCodeAt(i), 16777619);
      v[(h >>> 0) % EMBED_DIMS]! += (h >>> 31) & 1 ? -1 : 1;
      v[((h >>> 0) * 31) % EMBED_DIMS]! += 0.5;
    }
    const norm = Math.hypot(...v) || 1;
    return v.map((x) => x / norm);
  }
}

/** Workers AI `@cf/baai/bge-base-en-v1.5` (768 dims). */
export class WorkersAiEmbedder implements Embedder {
  constructor(private readonly ai: Ai) {}
  async embed(text: string): Promise<number[]> {
    const r = (await this.ai.run("@cf/baai/bge-base-en-v1.5", { text: [text] })) as { data?: number[][] };
    const v = r.data?.[0];
    if (!v) throw new Error("Workers AI returned no embedding");
    return v;
  }
}
