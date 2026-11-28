// Email intake (owner, 2026-11-28): who may start an agent by emailing its own address, set on the
// agent. By default (`people`) each email message trigger's People filter decides, as before; the
// operator may instead take mail only from one domain, only from a list of addresses and domains,
// or from anyone. What any sender writes stays data, never instructions (invariant 9).
import { z } from "zod";

const DOMAIN_RE = /^(?=.{1,253}$)(?!-)[a-z0-9-]{1,63}(?<!-)(\.(?!-)[a-z0-9-]{1,63}(?<!-))+$/;
const ADDRESS_RE = /^[^\s@]{1,64}@[^\s@]{1,253}$/;

/** A domain (`client.com`) or an address (`ap@client.com`), lower case, no leading `@`. */
export function normalizeIntakeSender(entry: string): string | null {
  const v = entry.trim().toLowerCase().replace(/^@/, "");
  if (ADDRESS_RE.test(v) && DOMAIN_RE.test(v.slice(v.lastIndexOf("@") + 1))) return v;
  if (DOMAIN_RE.test(v)) return v;
  return null;
}

// No transforms: the agent definition is also published as JSON Schema. Entries are written
// trimmed and lower case; the settings screen drops a leading `@`.
const IntakeDomain = z
  .string()
  .trim()
  .toLowerCase()
  .max(253)
  .regex(DOMAIN_RE, "a domain such as client.com");

const IntakeSender = z
  .string()
  .trim()
  .toLowerCase()
  .max(320)
  .refine(
    (v) => normalizeIntakeSender(v) === v,
    "an address (ap@client.com) or a domain (client.com)",
  );

export const EMAIL_INTAKE_MODES = ["people", "domain", "list", "open"] as const;
export type EmailIntakeMode = (typeof EMAIL_INTAKE_MODES)[number];

/**
 * - `people`: the email triggers' People filters decide (the default, as before).
 * - `domain`: only mail proven to come from this domain or its subdomains.
 * - `list`: only mail proven to come from one of these addresses or domains.
 * - `open`: anyone, proven or not; a run started this way is marked as from an unknown sender.
 */
// DECISION: `domain` and `list` are strict: a known person outside them is refused too, as "only
// from this domain" says. Proven means SPF passed for the envelope's domain or DMARC for the From
// header's (`authenticatedSenders`), as the forwarding address's allowed senders are checked.
export const EmailIntake = z.discriminatedUnion("mode", [
  z.strictObject({ mode: z.literal("people") }),
  z.strictObject({ mode: z.literal("domain"), domain: IntakeDomain }),
  z.strictObject({ mode: z.literal("list"), senders: z.array(IntakeSender).min(1).max(100) }),
  z.strictObject({ mode: z.literal("open") }),
]);
export type EmailIntake = z.infer<typeof EmailIntake>;

/** Whether an address is the entry (an address) or in its domain or a subdomain of it. */
function senderMatches(entry: string, address: string): boolean {
  const s = address.trim().toLowerCase();
  const at = s.lastIndexOf("@");
  if (at < 0) return false;
  if (entry.includes("@")) return entry === s;
  const domain = s.slice(at + 1);
  return domain === entry || domain.endsWith(`.${entry}`);
}

/**
 * Whether the agent's intake takes this mail on its own, past the triggers' People filters:
 * `proven` are the addresses the message is proven to come from (`authenticatedSenders`). Null for
 * `people`, where the People filters decide.
 */
export function emailIntakeAdmits(
  intake: EmailIntake | undefined,
  proven: readonly string[],
): boolean | null {
  if (!intake || intake.mode === "people") return null;
  if (intake.mode === "open") return true;
  const entries = intake.mode === "domain" ? [intake.domain] : intake.senders;
  return proven.some((p) => entries.some((e) => senderMatches(e, p)));
}

/** The setting in words, for the agent's settings and its triggers. */
export function emailIntakeWords(intake: EmailIntake | undefined): string {
  if (!intake || intake.mode === "people") return "From the people its email triggers name";
  if (intake.mode === "domain") return `Only from ${intake.domain}`;
  if (intake.mode === "list") {
    const n = intake.senders.length;
    return `Only from ${n} listed ${n === 1 ? "sender" : "senders"}`;
  }
  return "From anyone";
}
