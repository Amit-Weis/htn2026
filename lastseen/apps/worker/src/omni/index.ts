import type { Env } from "../env";
import { num } from "../env";
import { BudgetGuard, DEFAULT_PRICING } from "./budget";
import { HttpOmni } from "./http";
import { MockOmni } from "./mock";
import type { OmniClient } from "./types";

export * from "./types";
export { BudgetGuard } from "./budget";
export { MockOmni } from "./mock";
export { HttpOmni } from "./http";

/** Mock when MOCK_OMNI=1 or there is no key: never spend credit by accident. */
export function isMockOmni(env: Env): boolean {
  return env.MOCK_OMNI === "1" || !env.OMNI_API_KEY;
}

export function budgetGuard(env: Env): BudgetGuard {
  return new BudgetGuard(env.BUDGET, num(env.OMNI_BUDGET_CAP_CAD, 30));
}

export function createOmni(env: Env): OmniClient {
  if (isMockOmni(env)) return new MockOmni();
  return new HttpOmni({
    apiKey: env.OMNI_API_KEY!,
    baseUrl: env.OMNI_BASE_URL.replace(/\/$/, ""),
    model: env.OMNI_MODEL,
    budget: budgetGuard(env),
    pricing: {
      inPerM: num(env.OMNI_PRICE_IN_PER_M, DEFAULT_PRICING.inPerM),
      outPerM: num(env.OMNI_PRICE_OUT_PER_M, DEFAULT_PRICING.outPerM),
      flatPerCall: DEFAULT_PRICING.flatPerCall,
    },
    audioStyle: env.OMNI_AUDIO_STYLE === "raw" ? "raw" : "datauri",
    voice: env.OMNI_VOICE || undefined,
    capabilities: {
      audioOutput: env.OMNI_AUDIO_OUTPUT !== "0",
    },
    maxFrames: 6,
  });
}
