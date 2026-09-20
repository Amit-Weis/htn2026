/** Text helpers for fuzzy matching and label compatibility. Pure, no runtime dependencies. */

/** Tiny synonym groups so the offline embedder/fuzzy matcher can map "drinking thing" -> mug. */
const GROUPS: string[][] = [
  ["mug", "cup", "glass", "tumbler", "bottle", "flask", "drinkware", "drink", "beverage", "coffee", "tea"],
  ["key", "keys", "keychain", "keyring", "fob"],
  ["phone", "smartphone", "iphone", "mobile", "cellphone"],
  ["charger", "cable", "adapter", "cord", "usb"],
  ["laptop", "computer", "notebook", "macbook"],
  ["wallet", "purse", "billfold"],
  ["glass", "glasses", "spectacles", "eyeglasses", "sunglasses"],
  ["screwdriver", "driver", "tool"],
  ["remote", "controller", "clicker"],
];

export function stem(w: string): string {
  return w.replace(/(ing|ed|es|s)$/u, (m, _g, off: number) => (off >= 3 ? "" : m));
}

export function tokens(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/u)
    .filter((w) => w.length > 1 && !["the", "my", "a", "an", "of", "and", "with", "thing", "for", "in", "on", "it"].includes(w))
    .map(stem);
}

/** Tokens plus every synonym-group sibling. */
export function expand(text: string): string[] {
  const out = new Set<string>();
  for (const t of tokens(text)) {
    out.add(t);
    for (const g of GROUPS) if (g.map(stem).includes(t)) g.forEach((s) => out.add(stem(s)));
  }
  return [...out];
}

/** How much of the query is covered by the object's text, with synonym expansion. 0..1 */
export function fuzzyScore(query: string, objectText: string, label: string): number {
  const q = tokens(query);
  if (!q.length) return 0;
  const hay = new Set(expand(objectText));
  const labelSet = new Set(expand(label));
  const covered = q.filter((t) => hay.has(t)).length / q.length;
  const inLabel = q.filter((t) => labelSet.has(t)).length / q.length;
  const exact = tokens(label).join(" ") === q.join(" ") ? 1 : 0;
  return Math.min(1, Math.max(exact, 0.55 * covered + 0.45 * inLabel));
}

/**
 * Two labels can name the same physical object: equal, one contained in the other ("keys" / "car keys"),
 * or the same head noun (or a synonym: "mug" / "coffee cup") WITHOUT conflicting modifiers.
 * "phillips screwdriver" and "flathead screwdriver" share a head noun but are different objects.
 */
export function labelsCompatible(a: string, b: string): boolean {
  const ta = tokens(a);
  const tb = tokens(b);
  if (!ta.length || !tb.length) return false;
  const subset = (x: string[], y: string[]) => x.every((t) => y.includes(t));
  if (subset(ta, tb) || subset(tb, ta)) return true;

  const ha = ta[ta.length - 1]!;
  const hb = tb[tb.length - 1]!;
  if (ha !== hb && !expand(ha).includes(hb)) return false;

  const ma = ta.slice(0, -1);
  const mb = tb.slice(0, -1);
  if (ma.length && mb.length) {
    const ea = new Set(ma.flatMap((m) => expand(m)));
    if (!mb.some((m) => expand(m).some((x) => ea.has(x)))) return false; // conflicting modifiers
  }
  return true;
}

export function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}
