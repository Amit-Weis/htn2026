import { DetectionSchema } from "@lastseen/shared";
import type { Detection, Frame } from "@lastseen/shared";
import { z } from "zod";

const ResponseSchema = z.object({ detections: z.array(z.array(DetectionSchema)) });

export interface RemoteDetectorConfig {
  url: string;
  secret: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

/**
 * Optional remote detector (DETECTOR_URL, off by default). POSTs {frames:[{t,w,h,jpegBase64}]} with an
 * `X-Detector-Secret` header and expects {detections: Detection[][]} aligned with the frames.
 * Any failure (network, timeout, bad shape) returns null: it must never block ingest.
 */
export async function fetchDetections(frames: Frame[], cfg: RemoteDetectorConfig): Promise<Detection[][] | null> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), cfg.timeoutMs ?? 2000);
  try {
    const res = await (cfg.fetchImpl ?? fetch)(cfg.url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Detector-Secret": cfg.secret },
      body: JSON.stringify({ frames: frames.map((f) => ({ t: f.t, w: f.w, h: f.h, jpegBase64: f.jpegBase64 })) }),
      signal: ctl.signal,
    });
    if (!res.ok) return null;
    const parsed = ResponseSchema.safeParse(await res.json());
    if (!parsed.success) return null;
    // align to the frames we sent
    return frames.map((_, i) => parsed.data.detections[i] ?? []);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
