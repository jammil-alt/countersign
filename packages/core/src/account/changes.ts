// Sloan, the account agent (ARCHITECTURE §9.8; docs/plan.md §1.47): who may ask Sloan for what,
// and the changes Sloan drafts for the client admin to sign. Sloan writes only the platform's own
// records for the person asking (invariant 11): a pause as the client admin's own, a drafted
// change as a Desk item the client admin signs, a request to the lead. It never loosens a rule.

import { z } from "zod";
import { ContactPatch, EmailAddress } from "../api/messaging";
import {
  ApproverMatch,
  type ApproverRule,
  type ApproverRuleInput,
  clientTighteningProblems,
} from "../approvals/rules";
import { isUuid } from "../ids";

const Id = z.string().refine((v) => isUuid(v), "not an id");

/** The inbox item's `subject_type` for a drafted change (§1.47 "Drafted changes"). */
export const ACCOUNT_CHANGE_SUBJECT = "account_change";

/** Sloan's identity and the service name a new client fork takes (§1.47 "Template"). */
export const ACCOUNT_AGENT_NAME = "Sloan";
export const ACCOUNT_AGENT_SERVICE_NAME = "Sloan, your account agent";

/** The skill of the template's `chat` workflow. */
export const ACCOUNT_CHAT_SKILL = "account.chat";

/** What a tool does for the person asking, and so the role it needs (§1.47 "Asking user"). */
export type AccountAction = "read" | "pause" | "draft" | "pass";

/** Client people only: Sloan answers the client's own people (operators use the back office). */
// DECISION: an operator posting in an account thread is answered by nothing Sloan reads or does:
// the account tools act for client people only, so Sloan never acts with an operator's reach.
// DECISION: passing a request to the lead is open to every member, as raising a request in the
// portal is.
export const ACCOUNT_ACTION_ROLES: Record<
  AccountAction,
  readonly ("client_admin" | "client_user")[]
> = {
  read: ["client_admin", "client_user"],
  pause: ["client_admin"],
  draft: ["client_admin"],
  pass: ["client_admin", "client_user"],
};

export function mayAskFor(role: string | null | undefined, action: AccountAction): boolean {
  return (ACCOUNT_ACTION_ROLES[action] as readonly string[]).includes(role ?? "");
}

// ── Drafted changes ──────────────────────────────────────────────────────────────────────────────

export const ACCOUNT_SIGNER_RULES_MAX = 10;

/**
 * A rule the new signer brings: what changes it matches and who signs them, the new signer (set
 * when the change is applied: they have no id before) or the client's admins (so "bills under
 * $2,000" is two rules: over $2,000 to the admins, then the rest to the new signer).
 */
// DECISION: §1.47 names `rules: ApproverRule[]`; a new person has no user id until invited, so the
// draft carries each rule's match, note and `signer` or `client_admin`, and the stored rule is
// built when the change is applied.
export const SignerRule = z.strictObject({
  match: ApproverMatch,
  approver: z.enum(["signer", "client_admin"]).default("signer"),
  note: z.string().trim().max(200).optional(),
});
export type SignerRule = z.infer<typeof SignerRule>;

export const AddSignerChange = z.strictObject({
  kind: z.literal("add_signer"),
  email: EmailAddress,
  name: z.string().trim().min(1).max(200),
  /** Only `client_user`: a new admin is the operator's to add (asking for one is loosening). */
  role: z.enum(["client_user", "client_admin"]).default("client_user"),
  canSign: z.boolean().default(true),
  rules: z.array(SignerRule).max(ACCOUNT_SIGNER_RULES_MAX).default([]),
});
export type AddSignerChange = z.infer<typeof AddSignerChange>;

/** A person's own details in the directory (the portal's contact edit, without addresses). */
export const PersonFields = ContactPatch.pick({
  name: true,
  title: true,
  notes: true,
  language: true,
  timezone: true,
  quietHours: true,
  preferredChannels: true,
  roles: true,
  organizationId: true,
  relationship: true,
});
export type PersonFields = z.infer<typeof PersonFields>;

export const EditPersonChange = z.strictObject({
  kind: z.literal("edit_person"),
  contactId: Id,
  fields: PersonFields.refine((f) => Object.keys(f).length > 0, "name at least one field"),
});
export type EditPersonChange = z.infer<typeof EditPersonChange>;

/** How a person is reached: their email address, phone and WhatsApp number (null removes one). */
// DECISION: §1.47 leaves `change_contact {…}` open; it is the contact's addresses, the part of the
// portal's contact edit that changes where agents reach someone, kept apart from their details.
export const ContactAddresses = ContactPatch.pick({ email: true, phone: true, whatsapp: true });
export type ContactAddresses = z.infer<typeof ContactAddresses>;

export const ChangeContactChange = z.strictObject({
  kind: z.literal("change_contact"),
  contactId: Id,
  addresses: ContactAddresses.refine(
    (f) => Object.keys(f).length > 0,
    "name an email address, phone or WhatsApp number",
  ),
});
export type ChangeContactChange = z.infer<typeof ChangeContactChange>;

export const AccountChange = z.discriminatedUnion("kind", [
  AddSignerChange,
  EditPersonChange,
  ChangeContactChange,
]);
export type AccountChange = z.infer<typeof AccountChange>;
export type AccountChangeInput = z.input<typeof AccountChange>;

/** Why a draft would loosen something: only the operator loosens (invariant 8). */
export interface LooseningProblem {
  code: "new_admin" | "rules";
  message: string;
}

/** A stand-in id for the new signer while their rules are checked (they have none yet). */
const NEW_SIGNER = "00000000-0000-4000-8000-000000000000";

/** The client's rules after adding the new signer's: appended, so no existing rule is overridden. */
// DECISION: the new rules go after the client's existing ones: the first match wins, so a rule the
// client or the operator already has keeps deciding what it decides.
export function signerRules(
  current: readonly ApproverRule[],
  rules: readonly SignerRule[],
  userId: string,
): ApproverRuleInput[] {
  return [
    ...current,
    ...rules.map((r) => ({
      match: r.match,
      approver:
        r.approver === "client_admin"
          ? { kind: "client_admin" as const }
          : { kind: "user" as const, userId },
      setBy: "client" as const,
      ...(r.note ? { note: r.note } : {}),
    })),
  ];
}

/**
 * What in a change would loosen the client's rules: a new admin, or approver rules the client
 * admin couldn't save themselves (core's clientTighteningProblems). Empty: the draft may go ahead.
 */
export function looseningProblems(
  change: AccountChange,
  currentRules: readonly ApproverRule[],
): LooseningProblem[] {
  if (change.kind !== "add_signer") return [];
  const problems: LooseningProblem[] = [];
  if (change.role === "client_admin") {
    problems.push({ code: "new_admin", message: "a new admin is added by your lead" });
  }
  const next = signerRules(currentRules, change.rules, NEW_SIGNER);
  for (const p of clientTighteningProblems(currentRules, next)) {
    problems.push({ code: "rules", message: p.message });
  }
  return problems;
}

/** A change that can't be drafted as asked, whatever it loosens. */
export function changeProblem(change: AccountChange): string | null {
  if (change.kind === "add_signer" && !change.canSign && change.rules.length > 0) {
    return "someone who approves nothing can't have rules: make them an approver or drop the rules";
  }
  return null;
}

/** What `inbox_item.payload.accountChange` keeps: the change and its words, for the Desk. */
export const StoredAccountChange = z.object({
  change: AccountChange,
  /** Plain words, in the client's language: how it is now and how it would be. */
  now: z.array(z.string()),
  after: z.array(z.string()),
  /** The person who asked Sloan. */
  askedBy: z.string(),
  threadId: z.string().nullable(),
  runId: z.string().nullable(),
  agentVersionId: z.string().nullable(),
  sources: z.array(z.string()),
});
export type StoredAccountChange = z.infer<typeof StoredAccountChange>;

export function readStoredAccountChange(payload: unknown): StoredAccountChange | null {
  const p =
    payload !== null && typeof payload === "object" && !Array.isArray(payload)
      ? (payload as Record<string, unknown>).accountChange
      : undefined;
  const parsed = StoredAccountChange.safeParse(p);
  return parsed.success ? parsed.data : null;
}
