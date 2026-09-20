import { DEFAULT_INGEST } from "./ingest/pipeline";
import type { IngestConfig } from "./ingest/pipeline";
import { DEFAULT_GUARDS } from "./ingest/guards";
import { num } from "./env";
import type { Env } from "./env";

/** All ingest guard/crop/detector settings come from env vars, with the defaults from the patch. */
export function ingestConfig(env: Env): IngestConfig {
  return {
    guards: {
      cooldownMs: num(env.CANDIDATE_COOLDOWN_MS, DEFAULT_GUARDS.cooldownMs),
      maxOmniPerMin: num(env.MAX_OMNI_PER_MIN, DEFAULT_GUARDS.maxOmniPerMin),
      hashWindow: num(env.DEDUPE_WINDOW, DEFAULT_GUARDS.hashWindow),
      walkFraction: num(env.WALK_FRACTION, DEFAULT_GUARDS.walkFraction),
    },
    defaultHfovDeg: num(env.CAMERA_HFOV_DEG, DEFAULT_INGEST.defaultHfovDeg),
    detectorUrl: env.DETECTOR_URL || undefined,
    detectorSecret: env.DETECTOR_SECRET || undefined,
    cropMinPixels: num(env.CROP_MIN_PIXELS, DEFAULT_INGEST.cropMinPixels),
    cropMargin: DEFAULT_INGEST.cropMargin,
    sameObjectSimilarity: DEFAULT_INGEST.sameObjectSimilarity,
    sameSpotMeters: DEFAULT_INGEST.sameSpotMeters,
  };
}
