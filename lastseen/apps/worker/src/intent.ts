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

/** Words that say the wearer has the object now. */
const HAVE_IT = /\b(found|got|located|spotted|have it|have my|here it is|there it is|here s my|there s my|never mind|nevermind)\b/;
/** A question is a request, not a report: "have you seen it", "can you find it". */
const QUESTION = /\b(where|have you|do you|did you|can you|could you|help me|show me|find)\b/;

/** A name AND a word that asks for it: "where is my hacker badge", "find my tag". A bare mention ("nice badge") does not count. */
export function keywordIntent(text: string): string | null {
  const id = matchTarget(text);
  return id && ASKING.test(norm(text)) && !keywordFound(text) ? id : null;
}

/** A name AND a word that says they have it: "I found my hacker tag", "got my badge". A question does not count. */
export function keywordFound(text: string): string | null {
  const id = matchTarget(text);
  const t = norm(text);
  return id && HAVE_IT.test(t) && !QUESTION.test(t) ? id : null;
}

export function isKnownTarget(id: string | null | undefined): id is string {
  return Boolean(id) && TARGETS.some((t) => t.id === id);
}

const nameOf = (id: string) => TARGETS.find((t) => t.id === id)?.names[0] ?? id;

/**
 * Ask OMNI whether the wearer asked to be pointed to a known target, or says they found it. OMNI decides. If OMNI cannot answer at
 * all (network, budget cap, invalid reply) and the words are known text, the keyword rules stand in so the arrow still works, and the
 * reply says so (`source: "keywords"`, `note`). Audio with no OMNI has no words to match, so it answers "nothing".
 * `wants` and `found` are never both set.
 */
export async function resolveIntent(omni: OmniClient, text: string | undefined, audio: AudioClip | null): Promise<HttpIntentReply> {
  try {
    const r = await omni.understandIntent(audio, text, TARGETS);
    const heard = r.value.heard || text || "";
    if (isKnownTarget(r.value.found)) {
      return { heard, wants: null, found: r.value.found, say: r.value.say || "Glad you found it.", source: "omni" };
    }
    if (isKnownTarget(r.value.wants)) {
      return { heard, wants: r.value.wants, found: null, say: r.value.say || `Pointing you to your ${nameOf(r.value.wants)}.`, source: "omni" };
    }
    return { heard, wants: null, found: null, say: "", source: "omni" };
  } catch (e) {
    const note = e instanceof Error ? e.message : String(e);
    const heard = text ?? "";
    const found = text ? keywordFound(text) : null;
    if (found) return { heard, wants: null, found, say: "Glad you found it.", source: "keywords", note };
    const wants = text ? keywordIntent(text) : null;
    return { heard, wants, found: null, say: wants ? `Pointing you to your ${nameOf(wants)}.` : "", source: "keywords", note };
  }
}
