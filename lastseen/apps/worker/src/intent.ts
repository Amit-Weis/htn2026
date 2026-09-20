import type { HttpIntentReply } from "@lastseen/shared";
import type { AudioClip, IntentTarget, OmniClient } from "./omni/types";

/**
 * The things a client can ask to be pointed to by name. `id` is what the client's detector calls the object; `names` are the
 * ways a wearer might say it. Add an entry here and OMNI (and the keyword backstop below) will recognise it.
 */
export const TARGETS: IntentTarget[] = [
  {
    id: "hacker_card",
    names: ["hacker badge", "hacker tag", "hacker card", "hacker pass", "hackathon badge", "conference badge", "name tag", "name badge", "badge", "lanyard"],
  },
];

const norm = (s: string) =>
  s
    .toLowerCase()
    .replace(/['’]s?\b/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

/** Also matches "hackertag" and "hacker's badge" (the possessive is stripped by `norm`). */
const NAME_PATTERNS: Array<{ id: string; re: RegExp }> = [
  { id: "hacker_card", re: /\b(hacker ?(tag|badge|card|pass)|hackathon (badge|tag|pass)|conference (badge|tag|pass)|name ?(tag|badge)|badge|lanyard)\b/ },
];

/** The id of the target whose name appears in the text, or null. Used only as a backstop and for typed text. */
export function matchTarget(text: string): string | null {
  const t = norm(text);
  for (const p of NAME_PATTERNS) if (p.re.test(t)) return p.id;
  return null;
}

const ASKING = /\b(where|find|locate|look(ing)? for|show|point|guide|take me|lost|missing|misplaced|cant find|cannot find|need|have you seen|seen)\b/;

/** A name AND a word that asks for it: "where is my hacker badge", "find my tag". A bare mention ("nice badge") does not count. */
export function keywordIntent(text: string): string | null {
  const id = matchTarget(text);
  return id && ASKING.test(norm(text)) ? id : null;
}

export function isKnownTarget(id: string | null | undefined): id is string {
  return Boolean(id) && TARGETS.some((t) => t.id === id);
}

const nameOf = (id: string) => TARGETS.find((t) => t.id === id)?.names[0] ?? id;

/**
 * Ask OMNI whether the wearer asked to be pointed to a known target. OMNI decides. If OMNI cannot answer at all (network, budget
 * cap, invalid reply) and the wearer's words are known text, the keyword rule stands in so the arrow still works, and the reply
 * says so (`source: "keywords"`, `note`). Audio with no OMNI has no words to match, so it answers "nothing".
 */
export async function resolveIntent(omni: OmniClient, text: string | undefined, audio: AudioClip | null): Promise<HttpIntentReply> {
  try {
    const r = await omni.understandIntent(audio, text, TARGETS);
    const heard = r.value.heard || text || "";
    if (!isKnownTarget(r.value.wants)) return { heard, wants: null, say: "", source: "omni" };
    return { heard, wants: r.value.wants, say: r.value.say || `Pointing you to your ${nameOf(r.value.wants)}.`, source: "omni" };
  } catch (e) {
    const note = e instanceof Error ? e.message : String(e);
    const id = text ? keywordIntent(text) : null;
    return { heard: text ?? "", wants: id, say: id ? `Pointing you to your ${nameOf(id)}.` : "", source: "keywords", note };
  }
}
