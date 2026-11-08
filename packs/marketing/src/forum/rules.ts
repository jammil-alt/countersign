// §1.77: the forum watch's rules for a reply draft, in code (docs/marketing-plan.md §4.6,
// "Guardrails in code"): it opens with the disclosure ("I work at Mezonas"), it never links to or
// names the client's own site, and it has no exclamation mark. A draft that breaks one is refused,
// never just flagged; the agent may correct it and try again. Pure: no database, no clock.

/** How long a reply draft may be (HN's comments are rarely longer). */
export const FORUM_REPLY_MAX = 5000;

/** The words every reply opens with, for a client called `clientName`. */
export function defaultDisclosure(clientName: string): string {
  return `I work at ${clientName.trim()}`;
}

/**
 * The disclosure a reply must open with: the skill's `disclosure` setting when it is one ("I work
 * at …"), else "I work at <client name>". A setting can change the words, never drop them.
 */
export function disclosureFor(
  settings: Readonly<Record<string, unknown>>,
  clientName: string,
): string {
  const set = settings.disclosure;
  if (typeof set === "string") {
    const v = set.trim();
    if (/^I work at \S/i.test(v) && v.length <= 120) return v;
  }
  return defaultDisclosure(clientName);
}

export type ReplyProblem = "empty" | "too_long" | "no_disclosure" | "exclamation" | "own_site";

const WORDS: Record<ReplyProblem, string> = {
  empty: "The reply is empty.",
  too_long: `The reply is longer than ${FORUM_REPLY_MAX} characters.`,
  no_disclosure: "",
  exclamation: "The reply has an exclamation mark; write it without one.",
  own_site: "",
};

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Whether `text` names `domain` or any of its subdomains as a host (a link or a bare name). */
export function mentionsDomain(text: string, domain: string): boolean {
  const d = domain
    .trim()
    .toLowerCase()
    .replace(/^www\./, "");
  if (!d) return false;
  // A host that is the domain or ends in `.domain`, not part of a longer name (`notmezonas.com`).
  const re = new RegExp(`(^|[^a-z0-9.-])([a-z0-9-]+\\.)*${escapeRe(d)}(?![a-z0-9-])`, "i");
  return re.test(text);
}

/** What is wrong with a reply draft, each in plain words; empty when it may be kept. */
export function replyProblems(
  body: string,
  rules: { disclosure: string; domains: readonly string[] },
): { code: ReplyProblem; message: string }[] {
  const text = body.trim();
  const out: { code: ReplyProblem; message: string }[] = [];
  if (!text) return [{ code: "empty", message: WORDS.empty }];
  if (text.length > FORUM_REPLY_MAX) out.push({ code: "too_long", message: WORDS.too_long });
  const lead = rules.disclosure.trim();
  const opens =
    text.slice(0, lead.length).toLowerCase() === lead.toLowerCase() &&
    (text.length === lead.length || /[\s.,;:)—-]/.test(text.charAt(lead.length)));
  if (!opens) {
    out.push({ code: "no_disclosure", message: `The reply must open with "${lead}".` });
  }
  // The ASCII mark and its full-width and inverted forms.
  if (/[!！¡]/.test(text)) out.push({ code: "exclamation", message: WORDS.exclamation });
  for (const d of rules.domains) {
    if (mentionsDomain(text, d)) {
      out.push({
        code: "own_site",
        message: `The reply links to or names ${d}; forum replies never point at our own site.`,
      });
      break;
    }
  }
  return out;
}
