import type { TrackerAgent } from "./agent";

/** Worker bindings + config. Secrets: DEVICE_TOKEN, OMNI_API_KEY (wrangler secret / .dev.vars). */
export interface Env {
  TrackerAgent: DurableObjectNamespace<TrackerAgent>;
  INGEST_WORKFLOW: Workflow;
  /** Optional until R2 is enabled on the account; thumbnails fall back to SQLite. */
  FRAMES?: R2Bucket;
  VECTORS: VectorizeIndex;
  BUDGET: KVNamespace;
  AI: Ai;
  ASSETS: Fetcher;
  /** Workers Images binding, used to crop the chosen object out of the full-res still (remote/deployed only) */
  IMAGES?: ImagesBinding;

  DEVICE_TOKEN: string;
  OMNI_API_KEY?: string;
  OMNI_BASE_URL: string;
  OMNI_MODEL: string;
  MOCK_OMNI: string;
  OMNI_BUDGET_CAP_CAD: string;
  RETENTION_HOURS: string;
  CAMERA_HFOV_DEG: string;
  STEP_LENGTH_M: string;
  MAX_RANGE_M: string;
  MIN_CONFIDENCE: string;
  /** ingest guards (see docs/DECISIONS.md) */
  CANDIDATE_COOLDOWN_MS?: string;
  MAX_OMNI_PER_MIN?: string;
  DEDUPE_WINDOW?: string;
  WALK_FRACTION?: string;
  CROP_MIN_PIXELS?: string;
  /** optional remote detector; OFF unless DETECTOR_URL is set */
  DETECTOR_URL?: string;
  DETECTOR_SECRET?: string;
  /** "1": Workers AI embeddings + Vectorize; anything else: offline embeddings + SQLite vectors */
  USE_VECTORIZE?: string;
  /** optional OMNI tuning, see .env.example */
  OMNI_PRICE_IN_PER_M?: string;
  OMNI_PRICE_OUT_PER_M?: string;
  OMNI_AUDIO_STYLE?: string;
  OMNI_AUDIO_OUTPUT?: string;
}

export function num(v: string | undefined, fallback: number): number {
  const n = v === undefined ? Number.NaN : Number(v);
  return Number.isFinite(n) ? n : fallback;
}
