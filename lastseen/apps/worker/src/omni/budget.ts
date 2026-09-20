import { BudgetExceededError } from "./types";

const KEY = "omni:spend:v1";

export interface Spend {
  cad: number;
  calls: number;
}

/**
 * Global OMNI spend guard in KV. KV is eventually consistent and read-modify-write is not atomic,
 * so this is an estimate with a hard cap, not an accountant: good enough to stop a runaway loop
 * from burning the sponsor credit. The cap check happens before every call.
 */
export class BudgetGuard {
  constructor(
    private readonly kv: KVNamespace,
    readonly capCad: number,
  ) {}

  async read(): Promise<Spend> {
    const v = await this.kv.get<Spend>(KEY, "json");
    return v ?? { cad: 0, calls: 0 };
  }

  async assertAvailable(): Promise<Spend> {
    const s = await this.read();
    if (s.cad >= this.capCad) throw new BudgetExceededError(s.cad, this.capCad);
    return s;
  }

  async charge(costCad: number): Promise<Spend> {
    const s = await this.read();
    const next = { cad: s.cad + costCad, calls: s.calls + 1 };
    await this.kv.put(KEY, JSON.stringify(next));
    return next;
  }
}

export interface Pricing {
  /** CAD per 1M input / output tokens. Defaults are deliberately conservative (over-estimate). */
  inPerM: number;
  outPerM: number;
  /** used when the API returns no usage block */
  flatPerCall: number;
}

export const DEFAULT_PRICING: Pricing = { inPerM: 2, outPerM: 8, flatPerCall: 0.004 };

export function estimateCad(
  usage: { prompt_tokens?: number; completion_tokens?: number } | undefined,
  p: Pricing = DEFAULT_PRICING,
): number {
  if (!usage || (usage.prompt_tokens === undefined && usage.completion_tokens === undefined)) return p.flatPerCall;
  return ((usage.prompt_tokens ?? 0) * p.inPerM + (usage.completion_tokens ?? 0) * p.outPerM) / 1e6;
}
