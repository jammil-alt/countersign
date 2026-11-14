// Signing up for texts (docs/plan.md §1.98). A public page in the client's name, opened by a
// signed link: the client's sign-up link (shared with its own people) or one person's invitation
// (emailed to a vendor or customer). The person enters their mobile number, ticks the box and
// presses "Text me"; we record express consent for texts with the words they saw, then send the
// confirmation text from the client's number. Invitations are a fixed platform email, one and at
// most one reminder, with "don't ask me again".

import {
  type ContactConsent,
  complianceOf,
  hasConsent,
  isNanpNumber,
  normalizeSignupPhone,
  parseCoveredProcessors,
  processingRefusal,
  TEXT_INVITE_DAYS,
  TEXT_INVITE_FEATURE,
  TEXT_INVITE_MAX,
  TEXT_INVITE_REMINDER_AFTER_MS,
  TEXT_SIGNUP_LINK_HOURLY_MAX,
  TEXT_SIGNUP_SOURCES,
  TEXT_SIGNUP_WORDING_VERSION,
  type TextInvitationsResult,
  type TextInviteSkip,
  type TextSignupSubmitInput,
  TextSignupToken,
  type TextSignupView,
  textInvitationEmail,
  textSignupPath,
  textSignupTerms,
} from "@countersign/core";
import { contact, contactChange, type Db, type Tx, tenant, withTenant } from "@countersign/db";
import { and, eq, gt, inArray, sql } from "drizzle-orm";
import type { Bindings } from "../env";
import { HttpError } from "../http";
import type { Mailer } from "../notify/mailer";
import { isProductionEnv } from "../platform";
import {
  type ContactRow,
  createContact,
  logContactChange,
  recordTextSignup,
  updateContact,
} from "./contacts";

type KeyEnv = Pick<Bindings, "ENCRYPTION_KEY" | "ENVIRONMENT">;

const encoder = new TextEncoder();
let devKey: Uint8Array | undefined;

function b64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function unb64url(text: string): Uint8Array {
  const s = atob(text.replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(s, (c) => c.charCodeAt(0));
}

// DECISION: signed like the preview and document links (a key derived from ENCRYPTION_KEY under
// its own label, so no other kind of link opens this page); in development without the key, a
// random key per isolate; production without it makes no links.
async function signupKey(env: KeyEnv) {
  let raw: Uint8Array;
  if (env.ENCRYPTION_KEY?.trim()) {
    raw = new Uint8Array(
      await crypto.subtle.digest(
        "SHA-256",
        encoder.encode(`mezonas-text-signup:${env.ENCRYPTION_KEY.trim()}`),
      ),
    );
  } else if (!isProductionEnv(env)) {
    devKey ??= crypto.getRandomValues(new Uint8Array(32));
    raw = devKey;
  } else {
    throw new HttpError(409, "not_available", "sign-up links need ENCRYPTION_KEY");
  }
  return crypto.subtle.importKey("raw", raw, { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
    "verify",
  ]);
}

export async function signTextSignup(env: KeyEnv, payload: TextSignupToken): Promise<string> {
  const body = encoder.encode(JSON.stringify(payload));
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", await signupKey(env), body));
  return `${b64url(body)}.${b64url(sig)}`;
}

/** The link's payload, or null: forged, malformed, or an invitation past its expiry. */
export async function verifyTextSignup(
  env: KeyEnv,
  token: string,
  now: number = Date.now(),
): Promise<TextSignupToken | null> {
  const [bodyText, sigText, extra] = token.split(".");
  if (!bodyText || !sigText || extra !== undefined || token.length > 2000) return null;
  try {
    const body = unb64url(bodyText);
    const ok = await crypto.subtle.verify("HMAC", await signupKey(env), unb64url(sigText), body);
    if (!ok) return null;
    const parsed = TextSignupToken.safeParse(JSON.parse(new TextDecoder().decode(body)));
    if (!parsed.success) return null;
    if (parsed.data.k === "i" && parsed.data.e * 1000 < now) return null;
    return parsed.data;
  } catch {
    return null;
  }
}

// ── The client's sign-up link ────────────────────────────────────────────────────────────────────

type TenantRow = typeof tenant.$inferSelect;

function settingsOf(t: Pick<TenantRow, "settings">): Record<string, unknown> {
  const s = t.settings;
  return s && typeof s === "object" && !Array.isArray(s) ? (s as Record<string, unknown>) : {};
}

/** The client's current link key (`tenant.settings.messaging.signupLinkKey`), if one was made. */
function linkKeyOf(t: Pick<TenantRow, "settings">): string | null {
  const messaging = settingsOf(t).messaging;
  const key =
    messaging && typeof messaging === "object"
      ? (messaging as Record<string, unknown>).signupLinkKey
      : undefined;
  return typeof key === "string" && key.length >= 8 ? key : null;
}

/**
 * The client's sign-up link, made on first use. `replace` makes a new key, so links shared before
 * stop working (a link that went somewhere it shouldn't).
 */
// DECISION: the link key lives in the client's settings, not a table: a link never expires on its
// own, and one key per client is all there is to keep.
export async function textSignupLink(
  tx: Tx,
  env: KeyEnv,
  origin: string,
  tenantId: string,
  opts: { replace?: boolean } = {},
): Promise<string> {
  const [t] = await tx.select().from(tenant).where(eq(tenant.id, tenantId));
  if (!t) throw new HttpError(404, "not_found", "client not found");
  let key = opts.replace ? null : linkKeyOf(t);
  if (!key) {
    key = b64url(crypto.getRandomValues(new Uint8Array(16)));
    const settings = settingsOf(t);
    const messaging =
      settings.messaging && typeof settings.messaging === "object" ? settings.messaging : {};
    await tx
      .update(tenant)
      .set({ settings: { ...settings, messaging: { ...messaging, signupLinkKey: key } } })
      .where(eq(tenant.id, tenantId));
  }
  const token = await signTextSignup(env, { k: "l", t: tenantId, n: key });
  return `${origin}${textSignupPath(token)}`;
}

// ── The page ─────────────────────────────────────────────────────────────────────────────────────

const GONE = "This link has expired or doesn't exist. Ask the business for a new one.";

function gone(): HttpError {
  return new HttpError(404, "not_found", GONE);
}

async function tenantOf(tx: Tx, tenantId: string): Promise<TenantRow | null> {
  const [t] = await tx.select().from(tenant).where(eq(tenant.id, tenantId));
  return t ?? null;
}

async function contactOf(tx: Tx, tenantId: string, id: string): Promise<ContactRow | null> {
  const [row] = await tx
    .select()
    .from(contact)
    .where(and(eq(contact.id, id), eq(contact.tenantId, tenantId)));
  return row ?? null;
}

function signedUp(row: ContactRow): boolean {
  return !row.optedOutAt && hasConsent((row.consent ?? {}) as ContactConsent, "sms");
}

/** What `contact_change` says about texting invitations for these contacts. */
async function inviteHistory(
  tx: Tx,
  tenantId: string,
  ids: readonly string[],
): Promise<Map<string, { invites: Date[]; declined: boolean }>> {
  const out = new Map<string, { invites: Date[]; declined: boolean }>();
  if (ids.length === 0) return out;
  const rows = await tx
    .select({
      contactId: contactChange.contactId,
      kind: sql<string>`${contactChange.change}->>'kind'`,
      at: contactChange.createdAt,
    })
    .from(contactChange)
    .where(
      and(
        eq(contactChange.tenantId, tenantId),
        inArray(contactChange.contactId, [...ids]),
        sql`${contactChange.change}->>'kind' in ('text_invite', 'text_invite_declined')`,
      ),
    );
  for (const r of rows) {
    const h = out.get(r.contactId) ?? { invites: [], declined: false };
    if (r.kind === "text_invite") h.invites.push(r.at);
    else h.declined = true;
    out.set(r.contactId, h);
  }
  for (const h of out.values()) h.invites.sort((a, b) => a.getTime() - b.getTime());
  return out;
}

/** The page for a link, or null when the link is no good (the page says so, nothing more). */
export async function viewTextSignup(
  db: Db,
  env: KeyEnv,
  token: string,
): Promise<TextSignupView | null> {
  const payload = await verifyTextSignup(env, token);
  if (!payload) return null;
  return withTenant(db, payload.t, async (tx) => {
    const t = await tenantOf(tx, payload.t);
    if (!t) return null;
    const base = {
      client: t.name,
      terms: textSignupTerms(t.name),
      wordingVersion: TEXT_SIGNUP_WORDING_VERSION,
    };
    if (payload.k === "l") {
      if (linkKeyOf(t) !== payload.n) return null;
      return { ...base, kind: "link" as const, name: null, phone: null, state: "open" as const };
    }
    const row = await contactOf(tx, payload.t, payload.c);
    if (!row) return null;
    const history = (await inviteHistory(tx, payload.t, [row.id])).get(row.id);
    const state = signedUp(row) ? "signed_up" : history?.declined ? "declined" : "open";
    return { ...base, kind: "invitation" as const, name: row.name, phone: row.phone, state };
  });
}

export interface TextSignupDone {
  tenantId: string;
  client: string;
  phone: string;
}

/**
 * Records a sign-up: express consent for texts on the number given, with the evidence. On the
 * client's link the person is found by their number or added; on an invitation it is that person,
 * whose number is changed if they gave another.
 */
export async function submitTextSignup(
  db: Db,
  env: KeyEnv,
  token: string,
  body: TextSignupSubmitInput,
  origin: { ip: string | null; userAgent: string | null },
  now: Date = new Date(),
): Promise<TextSignupDone> {
  const payload = await verifyTextSignup(env, token, now.getTime());
  if (!payload) throw gone();
  if (body.wordingVersion !== TEXT_SIGNUP_WORDING_VERSION) {
    throw new HttpError(409, "page_changed", "This page has changed. Reload it and try again.");
  }
  const phone = normalizeSignupPhone(body.phone);
  if (!phone) {
    throw new HttpError(
      422,
      "invalid_phone",
      "Enter your mobile number with its area code, for example (555) 123-4567.",
    );
  }
  return withTenant(db, payload.t, async (tx) => {
    const t = await tenantOf(tx, payload.t);
    if (!t) throw gone();
    const terms = textSignupTerms(t.name);
    const via = payload.k === "l" ? "link" : "invitation";
    const evidence = {
      via,
      wording: terms,
      wordingVersion: TEXT_SIGNUP_WORDING_VERSION,
      phone,
      ip: origin.ip,
      userAgent: origin.userAgent,
    };
    let row: ContactRow;
    if (payload.k === "l") {
      if (linkKeyOf(t) !== payload.n) throw gone();
      // DECISION: the client's link takes US and Canadian numbers only, and at most
      // TEXT_SIGNUP_LINK_HOURLY_MAX sign-ups an hour: a public form that sends a text is what SMS
      // pumping looks for. An invitation is tied to one person and has neither limit.
      if (!isNanpNumber(phone)) {
        throw new HttpError(422, "invalid_phone", "Enter a US or Canadian mobile number.");
      }
      const name = body.name?.trim();
      if (!name) throw new HttpError(422, "invalid_name", "Enter your name.");
      const [recent] = await tx
        .select({ n: sql<number>`count(*)::int` })
        .from(contactChange)
        .where(
          and(
            eq(contactChange.tenantId, payload.t),
            gt(contactChange.createdAt, new Date(now.getTime() - 60 * 60 * 1000)),
            sql`${contactChange.change}->>'kind' = 'opt_in'`,
            sql`${contactChange.change}->>'via' = 'link'`,
          ),
        );
      if ((recent?.n ?? 0) >= TEXT_SIGNUP_LINK_HOURLY_MAX) {
        throw new HttpError(429, "busy", "Too many sign-ups on this link. Try again in an hour.");
      }
      const [found] = await tx
        .select()
        .from(contact)
        .where(and(eq(contact.tenantId, payload.t), eq(contact.phone, phone)));
      row =
        found ??
        (await createContact(tx, payload.t, { name, phone }, null, now, {
          source: "text_signup",
          log: { via: "link" },
        }));
      row = await recordTextSignup(tx, row, { source: TEXT_SIGNUP_SOURCES.link, evidence }, now);
    } else {
      const found = await contactOf(tx, payload.t, payload.c);
      if (!found) throw gone();
      row = found;
      if (row.phone !== phone) {
        // Their own number: the old one's consent for texts and calls goes with it (§1.22).
        row = await updateContact(tx, payload.t, row.id, { phone }, null, {
          log: { via: "text_signup" },
        });
      }
      row = await recordTextSignup(
        tx,
        row,
        { source: TEXT_SIGNUP_SOURCES.invitation, evidence },
        now,
      );
    }
    return { tenantId: payload.t, client: t.name, phone };
  });
}

/** "Don't ask me again" on an invitation: logged once; no invitation goes to them after it. */
export async function declineTextSignup(
  db: Db,
  env: KeyEnv,
  token: string,
  origin: { ip: string | null; userAgent: string | null },
): Promise<void> {
  const payload = await verifyTextSignup(env, token);
  if (payload?.k !== "i") throw gone();
  await withTenant(db, payload.t, async (tx) => {
    const row = await contactOf(tx, payload.t, payload.c);
    if (!row) throw gone();
    const history = (await inviteHistory(tx, payload.t, [row.id])).get(row.id);
    if (history?.declined) return;
    await logContactChange(tx, payload.t, row.id, null, {
      kind: "text_invite_declined",
      by: "contact",
      ip: origin.ip,
      userAgent: origin.userAgent,
    });
  });
}

// ── Invitations ──────────────────────────────────────────────────────────────────────────────────

export interface InviteScope {
  tx: Tx;
  env: KeyEnv & Pick<Bindings, "BAA_PROCESSORS">;
  /** The web app's origin, for the links. */
  origin: string;
  tenantId: string;
  /** The person sending (or signing Sloan's draft); null for none. */
  actorId: string | null;
  via: "portal" | "ops" | "sloan";
  mailer: Mailer;
  now?: Date;
}

/**
 * Emails each person an invitation to get texts, or their one reminder. Left out: anyone not in
 * this client, opted out, already signed up, who said "don't ask me again", with no email, asked
 * twice already, or asked less than three days ago.
 */
export async function sendTextInvitations(
  s: InviteScope,
  contactIds: readonly string[],
): Promise<TextInvitationsResult> {
  const now = s.now ?? new Date();
  const ids = [...new Set(contactIds)];
  const out: TextInvitationsResult = { sent: [], skipped: [] };
  const skip = (id: string, reason: TextInviteSkip) => out.skipped.push({ id, reason });
  if (!s.mailer.isConfigured) {
    for (const id of ids) skip(id, "not_configured");
    return out;
  }
  const t = await tenantOf(s.tx, s.tenantId);
  if (!t) throw new HttpError(404, "not_found", "client not found");
  // HIPAA mode (§1.35): the invitation names the person to Resend.
  const refusal = processingRefusal(
    complianceOf(settingsOf(t)),
    parseCoveredProcessors(s.env.BAA_PROCESSORS),
    TEXT_INVITE_FEATURE.processors,
    TEXT_INVITE_FEATURE.what,
  );
  if (refusal) throw new HttpError(409, "hipaa", refusal);
  const rows = await s.tx
    .select()
    .from(contact)
    .where(and(eq(contact.tenantId, s.tenantId), inArray(contact.id, ids)));
  const byId = new Map(rows.map((r) => [r.id, r]));
  const history = await inviteHistory(s.tx, s.tenantId, ids);
  for (const id of ids) {
    const row = byId.get(id);
    if (!row) {
      skip(id, "not_found");
      continue;
    }
    const h = history.get(id) ?? { invites: [], declined: false };
    const last = h.invites.at(-1);
    if (row.optedOutAt) skip(id, "opted_out");
    else if (signedUp(row)) skip(id, "signed_up");
    else if (h.declined) skip(id, "declined");
    else if (!row.email) skip(id, "no_email");
    else if (h.invites.length >= TEXT_INVITE_MAX) skip(id, "asked_twice");
    else if (last && now.getTime() - last.getTime() < TEXT_INVITE_REMINDER_AFTER_MS) {
      skip(id, "too_soon");
    } else {
      const n = h.invites.length + 1;
      const expires = new Date(now.getTime() + TEXT_INVITE_DAYS * 24 * 60 * 60 * 1000);
      const token = await signTextSignup(s.env, {
        k: "i",
        t: s.tenantId,
        c: row.id,
        e: Math.floor(expires.getTime() / 1000),
      });
      const url = `${s.origin}${textSignupPath(token)}`;
      const email = textInvitationEmail({
        client: t.name,
        name: row.name,
        signUpUrl: url,
        declineUrl: `${url}?decline=1`,
        reminder: n > 1,
      });
      try {
        await s.mailer.send({
          to: row.email,
          subject: email.subject,
          text: email.text,
          html: email.html,
          idempotencyKey: `text-invite-${row.id}-${n}`,
          onBehalfOf: t.name,
        });
      } catch (error) {
        // Logged without the address or the words.
        console.warn(`text invitation to contact ${row.id} failed to send`, error);
        skip(id, "send_failed");
        continue;
      }
      await logContactChange(s.tx, s.tenantId, row.id, s.actorId, {
        kind: "text_invite",
        n,
        via: s.via,
        email: row.email,
        expiresAt: expires.toISOString(),
      });
      out.sent.push({ id, reminder: n > 1 });
    }
  }
  return out;
}
