import { KEYCODE } from "./native/types";
import type { KeyEvent } from "./native/types";

/**
 * Hardware keys arrive from the native Activity (phone buttons, Bluetooth clicker/headset). The web layer
 * cannot see volume keys, and screen taps are useless with the screen against the chest, so all push-to-talk
 * comes from here.
 */
export type KeyAction =
  | { type: "ptt"; action: "down" | "up"; mode: "query" | "narrate" }
  | { type: "recenter" };

export interface KeyMap {
  query: number[];
  narrate: number[];
  recenter: number[];
  /** hold a recenter key at least this long */
  longPressMs: number;
}

export const DEFAULT_KEYMAP: KeyMap = {
  query: [KEYCODE.VOLUME_UP, KEYCODE.HEADSETHOOK, KEYCODE.MEDIA_PLAY_PAUSE],
  narrate: [KEYCODE.VOLUME_DOWN],
  recenter: [KEYCODE.MEDIA_NEXT, KEYCODE.MEDIA_PREVIOUS],
  longPressMs: 1200,
};

export class KeyGestures {
  private readonly downAt = new Map<number, number>();
  constructor(private readonly map: KeyMap = DEFAULT_KEYMAP) {}

  handle(e: KeyEvent): KeyAction[] {
    const isQuery = this.map.query.includes(e.keyCode);
    const isNarrate = this.map.narrate.includes(e.keyCode);
    const isRecenter = this.map.recenter.includes(e.keyCode);

    if (e.action === "down") {
      if (this.downAt.has(e.keyCode)) return []; // auto-repeat
      this.downAt.set(e.keyCode, e.t);
      if (isQuery) return [{ type: "ptt", action: "down", mode: "query" }];
      if (isNarrate) return [{ type: "ptt", action: "down", mode: "narrate" }];
      return [];
    }

    const start = this.downAt.get(e.keyCode);
    this.downAt.delete(e.keyCode);
    if (start === undefined) return [];
    if (isQuery) return [{ type: "ptt", action: "up", mode: "query" }];
    if (isNarrate) return [{ type: "ptt", action: "up", mode: "narrate" }];
    if (isRecenter && e.t - start >= this.map.longPressMs) return [{ type: "recenter" }];
    return [];
  }
}
