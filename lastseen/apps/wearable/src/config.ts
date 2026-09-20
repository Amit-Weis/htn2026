import type { Force } from "./native/select";

/** What `startApp` needs. Built from URL params and build-time env (see settingsStore.ts) by routes/hud.ts. */
export interface AppConfig {
  /** worker host, e.g. lastseen.example.workers.dev */
  host: string;
  device: string;
  token: string;
  /** camera horizontal field of view, degrees */
  hfovDeg: number;
  stepLengthM: number;
  force: Force;
  /** CAMERA_ID for the browser fallback */
  cameraId?: string;
  /** show the desktop dev panel (fake pose walk, fake placement, hold-to-talk) */
  dev: boolean;
}
