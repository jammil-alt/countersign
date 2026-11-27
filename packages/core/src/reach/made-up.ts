import { z } from "zod";
import { E164 } from "../messaging/rules";
import type { ReachChannel } from "./rules";

// Messages to made-up people in the Sandbox (owner, 2026-11-27). The Sandbox client
// (`tenant.settings.sandbox`) is filled with invented people: addresses on reserved domains
// (example.com) and numbers in the fictional 555-01xx range. When a Sandbox agent runs live and
// reaches one of them, the message goes to where the operator set (`tenant.settings.sandboxDelivery`)
// instead, marked with the person's name, so the operator can play them and reply. Unset, it is
// refused in words, never sent to the made-up address. Pure: the API and the web app share it.

/** Domains reserved for examples (RFC 2606, RFC 6761): mail there reaches nobody. */
const RESERVED_DOMAINS = ["example.com", "example.org", "example.net"] as const;
/** Top-level domains reserved for testing and documentation (RFC 2606, RFC 6761). */
const RESERVED_TLDS = ["example", "test", "invalid", "localhost"] as const;

/** An email address on a reserved domain: `example.com`, `*.example.com`, `.test` and the like. */
// DECISION: subdomains of example.org and example.net count too: RFC 2606 reserves them all.
export function isMadeUpEmail(address: string): boolean {
  const at = address.trim().lastIndexOf("@");
  if (at < 0) return false;
  const domain = address
    .trim()
    .slice(at + 1)
    .toLowerCase()
    .replace(/\.$/, "");
  if (!domain) return false;
  if (RESERVED_DOMAINS.some((d) => domain === d || domain.endsWith(`.${d}`))) return true;
  const tld = domain.slice(domain.lastIndexOf(".") + 1);
  return (RESERVED_TLDS as readonly string[]).includes(tld);
}

/** A number in the fictional US range: +1 NXX-555-0100 to 0199 (a `whatsapp:` prefix allowed). */
export function isMadeUpPhone(number: string): boolean {
  const v = number.trim().replace(/^whatsapp:/i, "");
  if (!/^\+?[\d\s().-]+$/.test(v)) return false;
  let digits = v.replace(/\D/g, "");
  if (digits.length === 10) digits = `1${digits}`;
  return /^1[2-9]\d{2}55501\d{2}$/.test(digits);
}

/** Whether a contact's address on a channel is made up (email, or a number for the others). */
export function isMadeUpAddress(channel: ReachChannel, address: string): boolean {
  return channel === "email" ? isMadeUpEmail(address) : isMadeUpPhone(address);
}

/** The Sandbox's setting: where its messages to made-up people go. */
export const SANDBOX_DELIVERY_SETTING = "sandboxDelivery";

export const SandboxDelivery = z.object({
  email: z.email().max(254).nullable(),
  phone: E164.nullable(),
});
export type SandboxDelivery = z.infer<typeof SandboxDelivery>;

/** The setting as stored on `tenant.settings`; a field missing or not valid reads as unset. */
export function readSandboxDelivery(settings: unknown): SandboxDelivery {
  const raw =
    settings && typeof settings === "object"
      ? (settings as Record<string, unknown>)[SANDBOX_DELIVERY_SETTING]
      : undefined;
  const v = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const email = SandboxDelivery.shape.email.safeParse(v.email ?? null);
  const phone = SandboxDelivery.shape.phone.safeParse(v.phone ?? null);
  return {
    email: email.success ? (email.data?.toLowerCase() ?? null) : null,
    phone: phone.success ? phone.data : null,
  };
}

/** What happens to a message to `address` on `channel`. */
export type SandboxRedirect =
  | { kind: "as_is" }
  | { kind: "redirect"; to: string }
  | { kind: "refused"; reason: string };

/**
 * Where a message goes: as addressed outside the Sandbox or to a real address; to the Sandbox's
 * delivery address or number when the person is made up; refused in words when none is set.
 */
// DECISION: texts, WhatsApp messages and calls to a made-up number all go to the delivery phone.
export function sandboxRedirect(input: {
  sandbox: boolean;
  settings: unknown;
  channel: ReachChannel;
  address: string;
  name: string;
}): SandboxRedirect {
  if (!input.sandbox || !isMadeUpAddress(input.channel, input.address)) return { kind: "as_is" };
  const target = readSandboxDelivery(input.settings);
  const to = input.channel === "email" ? target.email : target.phone;
  if (to) return { kind: "redirect", to };
  const what = input.channel === "email" ? "address" : "number";
  return {
    kind: "refused",
    reason: `${input.name}'s ${what} is made up: set where the Sandbox's messages to made-up people go`,
  };
}

/** An email's subject as redirected: `[For Dana Whitfield] …`. */
export function redirectedSubject(subject: string, name: string): string {
  return `[For ${name}] ${subject}`;
}

/** A text's words as redirected: `For Dana Whitfield: …`. */
export function redirectedText(text: string, name: string): string {
  return `For ${name}: ${text}`;
}

// ── The test person (owner, 2026-11-27) ──────────────────────────────────────────────────────────
// A Sandbox test run started with "Ask me" (`people: "ask_me"`) runs as a full simulation: every
// message it sends goes to one test person, whoever the step names, and they answer, approve and
// decide for everyone. The test person is the operator who started the run (their login email,
// their phone from the Sandbox contact with that email); the Sandbox's `sandboxDelivery` setting,
// when set, overrides where the messages go. Kept on the run's trigger (`trigger.testPeople`).

/** Who stands in for everyone in a Sandbox test run: the operator who started it, and where. */
export const TestPeople = z.object({
  /** The operator's user id: their Your call gets the run's approvals and decisions. */
  by: z.string().min(1),
  email: z.email().max(254).nullable(),
  phone: E164.nullable(),
});
export type TestPeople = z.infer<typeof TestPeople>;

/** The run trigger's key for the test person. */
export const TEST_PEOPLE_TRIGGER = "testPeople";

/** The test person a run's trigger carries; null when the run was started without "Ask me". */
export function readTestPeople(trigger: unknown): TestPeople | null {
  const raw =
    trigger && typeof trigger === "object"
      ? (trigger as Record<string, unknown>)[TEST_PEOPLE_TRIGGER]
      : undefined;
  const p = TestPeople.safeParse(raw);
  return p.success ? p.data : null;
}

/**
 * Where a test run's message on `channel` goes: the Sandbox's delivery setting when set, else the
 * operator's own address or number. Null when there is none for the channel.
 */
// DECISION: texts, WhatsApp messages and calls all go to the one phone, as for made-up people.
export function testPersonAddress(
  settings: unknown,
  people: Pick<TestPeople, "email" | "phone">,
  channel: ReachChannel,
): string | null {
  const override = readSandboxDelivery(settings);
  if (channel === "email") return override.email ?? people.email?.toLowerCase() ?? null;
  return override.phone ?? people.phone ?? null;
}

/** An email's subject in a test run: `[Test · For Dana Whitfield] …`. */
export function testPersonSubject(subject: string, name: string): string {
  return `[Test · For ${name}] ${subject}`;
}

/** A text's words in a test run: `Test · For Dana Whitfield: …`. */
export function testPersonText(text: string, name: string): string {
  return `Test · For ${name}: ${text}`;
}
