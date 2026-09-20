import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { VECTORS_PATH, buildVectors } from "./gen-vectors";

describe("cross-language test vectors", () => {
  it("packages/shared/test-vectors/geometry.json is up to date (run `pnpm vectors`)", () => {
    const onDisk = JSON.parse(readFileSync(VECTORS_PATH, "utf8"));
    expect(onDisk).toEqual(JSON.parse(JSON.stringify(buildVectors())));
  });

  it("the accelerometer stream contains the steps it was built with", () => {
    const v = buildVectors();
    // 10 s at 1.8 Hz + 8 s at 2.2 Hz = 18 + 17.6 steps, and none while standing still
    expect(v.stepDetector.stepTimesMs.length).toBeGreaterThan(28);
    expect(v.stepDetector.stepTimesMs.length).toBeLessThan(40);
    const t0 = 1_000_000;
    for (const t of v.stepDetector.stepTimesMs) {
      const s = (t - t0) / 1000;
      expect((s >= 1.9 && s <= 12.2) || (s >= 15.9 && s <= 24.2)).toBe(true);
    }
  });
});
