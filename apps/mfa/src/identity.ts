// The `Identity` Durable Object: one per agent identity, named by its id, with SQLite storage. It
// holds the identity (client, label, address, phone), its authenticator secrets (sealed with
// MFA_ENCRYPTION_KEY), open waits, codes received for them (until claimed or ten minutes), the daily
// count of code requests, and alerts about messages no wait was open for. Every call from apps/api
// names the client; an identity of another client answers `not_found`, as one that doesn't exist.

import { DurableObject } from "cloudflare:workers";
import {
  type AuthenticatorView,
  type ClaimResult,
  CODES_DAILY_CAP_DEFAULT,
  CODES_MESSAGE_TTL_SECONDS,
  type CodeAlert,
  type CodeAlertKind,
  type CodesResponse,
  type IdentityView,
  type OpenWaitResult,
} from "@countersign/core";
import { SealKey, sealContext } from "./crypto";
import type { CodesEnv } from "./env";
import { logEvent } from "./log";
import { classifyUnmatched, extractCode, matchableText, senderMatches } from "./match";
import {
  decodeBase32,
  encodeBase32,
  OtpauthError,
  parseOtpauthUri,
  type TotpAlgorithm,
  totp,
} from "./totp";

const MINUTE = 60_000;
/** Waits are kept this long after they expire, then deleted (a later claim reads `expired`). */
const WAIT_KEEP_MS = 10 * MINUTE;
const MESSAGE_TTL_MS = CODES_MESSAGE_TTL_SECONDS * 1000;
/** Alerts are kept 30 days for apps/api's cron to read. */
const ALERT_KEEP_MS = 30 * 24 * 60 * MINUTE;

type Fail = {
  ok: false;
  error: {
    code: "not_found" | "invalid" | "daily_cap" | "conflict" | "not_configured";
    message: string;
  };
};
const fail = (code: Fail["error"]["code"], message: string): Fail => ({
  ok: false,
  error: { code, message },
});
const ok = <T>(value: T): { ok: true; value: T } => ({ ok: true, value });
const NOT_FOUND = () => fail("not_found", "no such identity for this client");

const SCHEMA = [
  `create table if not exists identity (
     id text primary key, tenant_id text not null, label text not null, email text not null,
     phone text, phone_sid text, created_at integer not null)`,
  `create table if not exists authenticator (
     site_key text primary key, secret text not null, algorithm text not null,
     digits integer not null, period integer not null, updated_at integer not null)`,
  `create table if not exists wait (
     id text primary key, site_key text not null, channel text not null, sender text,
     pattern text, status text not null, created_at integer not null, expires_at integer not null)`,
  `create table if not exists message (
     id text primary key, wait_id text not null, channel text not null, sender text,
     code text not null, received_at integer not null, expires_at integer not null)`,
  "create table if not exists request_count (day text primary key, n integer not null)",
  `create table if not exists alert (
     id text primary key, kind text not null, channel text not null, sender text,
     received_at integer not null, created_at integer not null)`,
  "create index if not exists alert_created_idx on alert (created_at)",
];

interface IdentityRow {
  id: string;
  tenant_id: string;
  label: string;
  email: string;
  phone: string | null;
  phone_sid: string | null;
  created_at: number;
  [key: string]: SqlStorageValue;
}

interface WaitRow {
  id: string;
  site_key: string;
  channel: "sms" | "email" | "totp";
  sender: string | null;
  pattern: string | null;
  status: "open" | "filled" | "claimed";
  created_at: number;
  expires_at: number;
  [key: string]: SqlStorageValue;
}

export interface InboundMessage {
  channel: "sms" | "email";
  /** Twilio's From, or the email's From address. */
  sender: string | null;
  /** For texts: the number it was sent to (must be this identity's). */
  to?: string | null;
  subject?: string | null;
  text: string;
  /** Email: SPF, DKIM and DMARC passed for the From domain. Texts: Twilio's signature checked. */
  authenticated: boolean;
}

export type ReceiveOutcome =
  | { outcome: "matched"; waitId: string }
  | { outcome: "alert"; kind: CodeAlertKind; alertId: string }
  | { outcome: "ignored"; reason: "unknown_identity" | "unauthenticated" | "wrong_number" };

const iso = (ms: number) => new Date(ms).toISOString();
const utcDay = (ms: number) => iso(ms).slice(0, 10);

export class Identity extends DurableObject<CodesEnv> {
  private sealKey: Promise<SealKey> | null = null;

  private get sql() {
    return this.ctx.storage.sql;
  }

  private key(): Promise<SealKey> {
    this.sealKey ??= SealKey.fromBase64(this.env.MFA_ENCRYPTION_KEY);
    // A failed import (no key yet) is not cached, so a key set later takes effect.
    this.sealKey.catch(() => {
      this.sealKey = null;
    });
    return this.sealKey;
  }

  /** Whether this object holds an identity at all; objects for unknown ids stay empty. */
  private hasSchema(): boolean {
    return (
      this.sql
        .exec("select count(*) as n from sqlite_master where type = 'table' and name = 'identity'")
        .one().n === 1
    );
  }

  private row(): IdentityRow | null {
    if (!this.hasSchema()) return null;
    return this.sql.exec<IdentityRow>("select * from identity limit 1").toArray()[0] ?? null;
  }

  /** The identity, if it exists and belongs to `tenantId`. */
  private owned(tenantId: string): IdentityRow | null {
    const r = this.row();
    return r && r.tenant_id === tenantId ? r : null;
  }

  private view(r: IdentityRow): IdentityView {
    const auths = this.sql
      .exec<{
        site_key: string;
        algorithm: TotpAlgorithm;
        digits: number;
        period: number;
        updated_at: number;
      }>(
        "select site_key, algorithm, digits, period, updated_at from authenticator order by site_key",
      )
      .toArray();
    return {
      id: r.id,
      tenantId: r.tenant_id,
      label: r.label,
      email: r.email,
      phone: r.phone,
      authenticators: auths.map((a) => ({
        siteKey: a.site_key,
        algorithm: a.algorithm,
        digits: a.digits,
        period: a.period,
        updatedAt: iso(a.updated_at),
      })),
      createdAt: iso(r.created_at),
    };
  }

  private async scheduleAt(at: number): Promise<void> {
    const current = await this.ctx.storage.getAlarm();
    if (current === null || current > at) await this.ctx.storage.setAlarm(at);
  }

  // ── Called by the entry point (apps/api's RPC) ────────────────────────────────────────────────

  async init(input: {
    id: string;
    tenantId: string;
    label: string;
    email: string;
  }): Promise<CodesResponse<IdentityView>> {
    if (this.row()) return fail("conflict", "identity id already in use");
    for (const stmt of SCHEMA) this.sql.exec(stmt);
    this.sql.exec(
      "insert into identity (id, tenant_id, label, email, created_at) values (?, ?, ?, ?, ?)",
      input.id,
      input.tenantId,
      input.label,
      input.email,
      Date.now(),
    );
    const r = this.row() as IdentityRow;
    logEvent("identity.created", { identityId: r.id, tenantId: r.tenant_id });
    return ok(this.view(r));
  }

  async get(input: { tenantId: string }): Promise<CodesResponse<IdentityView>> {
    const r = this.owned(input.tenantId);
    return r ? ok(this.view(r)) : NOT_FOUND();
  }

  /** The number Twilio sold us for this identity (the entry point bought it). */
  async setPhone(input: {
    tenantId: string;
    phone: string;
    sid: string;
  }): Promise<CodesResponse<IdentityView>> {
    const r = this.owned(input.tenantId);
    if (!r) return NOT_FOUND();
    if (r.phone) return fail("conflict", "this identity already has a phone number");
    this.sql.exec("update identity set phone = ?, phone_sid = ?", input.phone, input.sid);
    logEvent("identity.phone_added", { identityId: r.id, tenantId: r.tenant_id });
    return ok(this.view(this.row() as IdentityRow));
  }

  /** Whether a phone may be added (exists, belongs to the client, has none yet). */
  async canAddPhone(input: { tenantId: string }): Promise<CodesResponse<{ id: string }>> {
    const r = this.owned(input.tenantId);
    if (!r) return NOT_FOUND();
    if (r.phone) return fail("conflict", "this identity already has a phone number");
    return ok({ id: r.id });
  }

  async setAuthenticator(input: {
    tenantId: string;
    siteKey: string;
    otpauthUri: string;
  }): Promise<CodesResponse<AuthenticatorView>> {
    const r = this.owned(input.tenantId);
    if (!r) return NOT_FOUND();
    let params: ReturnType<typeof parseOtpauthUri>;
    try {
      params = parseOtpauthUri(input.otpauthUri);
    } catch (error) {
      if (error instanceof OtpauthError) return fail("invalid", error.message);
      throw error;
    }
    const key = await this.key();
    const secret = await key.seal(
      encodeBase32(params.secret),
      sealContext({ identityId: r.id, siteKey: input.siteKey, purpose: "authenticator" }),
    );
    const now = Date.now();
    this.sql.exec(
      `insert into authenticator (site_key, secret, algorithm, digits, period, updated_at)
       values (?, ?, ?, ?, ?, ?)
       on conflict (site_key) do update set secret = excluded.secret, algorithm = excluded.algorithm,
         digits = excluded.digits, period = excluded.period, updated_at = excluded.updated_at`,
      input.siteKey,
      secret,
      params.algorithm,
      params.digits,
      params.period,
      now,
    );
    logEvent("authenticator.set", { identityId: r.id, tenantId: r.tenant_id, site: input.siteKey });
    return ok({
      siteKey: input.siteKey,
      algorithm: params.algorithm,
      digits: params.digits,
      period: params.period,
      updatedAt: iso(now),
    });
  }

  async openWait(input: {
    tenantId: string;
    siteKey: string;
    channel: "sms" | "email" | "totp";
    sender?: string;
    pattern?: string;
    ttlSeconds: number;
  }): Promise<CodesResponse<OpenWaitResult>> {
    const r = this.owned(input.tenantId);
    if (!r) return NOT_FOUND();
    if (input.channel === "sms" && !r.phone) {
      return fail("not_configured", "this identity has no phone number");
    }
    if (input.channel === "totp") {
      const has = this.sql
        .exec("select count(*) as n from authenticator where site_key = ?", input.siteKey)
        .one().n;
      if (has === 0) return fail("not_found", "no authenticator for this site");
    }
    const now = Date.now();
    const day = utcDay(now);
    const cap =
      Number(this.env.MFA_DAILY_CAP ?? CODES_DAILY_CAP_DEFAULT) || CODES_DAILY_CAP_DEFAULT;
    const used =
      this.sql.exec<{ n: number }>("select n from request_count where day = ?", day).toArray()[0]
        ?.n ?? 0;
    if (used >= cap) {
      logEvent("wait.refused", { identityId: r.id, tenantId: r.tenant_id, reason: "daily_cap" });
      return fail("daily_cap", `this identity reached its ${cap} code requests for today`);
    }
    this.sql.exec(
      "insert into request_count (day, n) values (?, 1) on conflict (day) do update set n = n + 1",
      day,
    );
    const id = crypto.randomUUID();
    const expiresAt = now + input.ttlSeconds * 1000;
    this.sql.exec(
      `insert into wait (id, site_key, channel, sender, pattern, status, created_at, expires_at)
       values (?, ?, ?, ?, ?, 'open', ?, ?)`,
      id,
      input.siteKey,
      input.channel,
      input.sender ?? null,
      input.pattern ?? null,
      now,
      expiresAt,
    );
    await this.scheduleAt(expiresAt + WAIT_KEEP_MS);
    logEvent("wait.opened", {
      identityId: r.id,
      tenantId: r.tenant_id,
      waitId: id,
      site: input.siteKey,
      channel: input.channel,
    });
    return ok({ waitId: id, expiresAt: iso(expiresAt) });
  }

  /** The code, once; then `expired`. `pending` until a matching message arrives. */
  async claim(input: { tenantId: string; waitId: string }): Promise<CodesResponse<ClaimResult>> {
    const r = this.owned(input.tenantId);
    if (!r) return NOT_FOUND();
    const w = this.sql.exec<WaitRow>("select * from wait where id = ?", input.waitId).toArray()[0];
    const now = Date.now();
    if (!w || w.status === "claimed" || now >= w.expires_at) {
      if (w) this.closeWait(w.id);
      return ok({ status: "expired" });
    }
    const meta = { identityId: r.id, tenantId: r.tenant_id, waitId: w.id, channel: w.channel };
    if (w.channel === "totp") {
      // Closed before the code is computed, so two claims at once can't both get one.
      this.closeWait(w.id);
      const code = await this.authenticatorCode(r.id, w.site_key, now);
      if (code === null) return ok({ status: "expired" });
      logEvent("wait.claimed", meta);
      return ok({ status: "code", code });
    }
    if (w.status === "open") return ok({ status: "pending", expiresAt: iso(w.expires_at) });
    const m = this.sql
      .exec<{ id: string; code: string }>("select id, code from message where wait_id = ?", w.id)
      .toArray()[0];
    this.closeWait(w.id);
    if (!m) return ok({ status: "expired" });
    const key = await this.key();
    const code = await key.open(
      m.code,
      sealContext({ identityId: r.id, siteKey: w.site_key, purpose: `code:${w.id}` }),
    );
    logEvent("wait.claimed", meta);
    return ok({ status: "code", code });
  }

  /** Marks a wait claimed and deletes what it held. */
  private closeWait(waitId: string): void {
    this.sql.exec("update wait set status = 'claimed' where id = ?", waitId);
    this.sql.exec("delete from message where wait_id = ?", waitId);
  }

  private async authenticatorCode(
    identityId: string,
    siteKey: string,
    now: number,
  ): Promise<string | null> {
    const a = this.sql
      .exec<{ secret: string; algorithm: TotpAlgorithm; digits: number; period: number }>(
        "select secret, algorithm, digits, period from authenticator where site_key = ?",
        siteKey,
      )
      .toArray()[0];
    if (!a) return null;
    const key = await this.key();
    const secret = decodeBase32(
      await key.open(a.secret, sealContext({ identityId, siteKey, purpose: "authenticator" })),
    );
    if (!secret) return null;
    return totp(
      {
        secret,
        algorithm: a.algorithm,
        digits: a.digits,
        period: a.period,
      },
      new Date(now),
    );
  }

  async alerts(input: {
    tenantId: string;
    since: string;
    limit: number;
  }): Promise<CodesResponse<{ alerts: CodeAlert[] }>> {
    const r = this.owned(input.tenantId);
    if (!r) return NOT_FOUND();
    const rows = this.sql
      .exec<{
        id: string;
        kind: CodeAlertKind;
        channel: "sms" | "email";
        sender: string | null;
        received_at: number;
        created_at: number;
      }>(
        "select * from alert where created_at >= ? order by created_at, id limit ?",
        Date.parse(input.since),
        input.limit,
      )
      .toArray();
    return ok({
      alerts: rows.map((a) => ({
        id: a.id,
        tenantId: r.tenant_id,
        identityId: r.id,
        identityLabel: r.label,
        kind: a.kind,
        channel: a.channel,
        sender: a.sender,
        receivedAt: iso(a.received_at),
        createdAt: iso(a.created_at),
      })),
    });
  }

  /** Deletes everything this identity holds; answers its phone number's sid to release. */
  async destroy(input: {
    tenantId: string;
  }): Promise<CodesResponse<{ phoneSid: string | null; label: string }>> {
    const r = this.owned(input.tenantId);
    if (!r) return NOT_FOUND();
    await this.ctx.storage.deleteAlarm();
    for (const t of ["message", "wait", "authenticator", "request_count", "alert", "identity"]) {
      this.sql.exec(`drop table if exists ${t}`);
    }
    await this.ctx.storage.deleteAll();
    logEvent("identity.deleted", { identityId: r.id, tenantId: r.tenant_id });
    return ok({ phoneSid: r.phone_sid, label: r.label });
  }

  // ── Called by the inbound handlers (Twilio's webhook, email) ──────────────────────────────────

  /**
   * A text or an email for this identity. The first open wait on its channel whose sender matches
   * and whose pattern finds a code takes it (the code is sealed and held until claimed or ten
   * minutes). Anything else raises an alert with metadata only and is never handed out.
   */
  async receive(message: InboundMessage): Promise<ReceiveOutcome> {
    const r = this.row();
    if (!r) return { outcome: "ignored", reason: "unknown_identity" };
    const meta = { identityId: r.id, tenantId: r.tenant_id, channel: message.channel };
    if (!message.authenticated) {
      logEvent("message.ignored", { ...meta, reason: "unauthenticated" });
      return { outcome: "ignored", reason: "unauthenticated" };
    }
    if (message.channel === "sms" && (!r.phone || !message.to || message.to !== r.phone)) {
      logEvent("message.ignored", { ...meta, reason: "wrong_number" });
      return { outcome: "ignored", reason: "wrong_number" };
    }
    const now = Date.now();
    const text = matchableText([message.subject, message.text]);
    const waits = this.sql
      .exec<WaitRow>(
        `select * from wait where status = 'open' and channel = ? and expires_at > ?
         order by created_at, id`,
        message.channel,
        now,
      )
      .toArray();
    for (const w of waits) {
      if (!w.sender || !w.pattern) continue;
      if (!senderMatches(message.channel, w.sender, message.sender)) continue;
      const code = extractCode(w.pattern, text);
      if (code === null) continue;
      const key = await this.key();
      const sealed = await key.seal(
        code,
        sealContext({ identityId: r.id, siteKey: w.site_key, purpose: `code:${w.id}` }),
      );
      // Another message may have filled this wait while the code was being sealed: then this one
      // looks for another wait, or becomes an alert. The check and the writes run with no await
      // between them.
      const still = this.sql
        .exec("select count(*) as n from wait where id = ? and status = 'open'", w.id)
        .one().n;
      if (still === 0) continue;
      this.sql.exec(
        `insert into message (id, wait_id, channel, sender, code, received_at, expires_at)
         values (?, ?, ?, ?, ?, ?, ?)`,
        crypto.randomUUID(),
        w.id,
        message.channel,
        message.sender,
        sealed,
        now,
        now + MESSAGE_TTL_MS,
      );
      this.sql.exec("update wait set status = 'filled' where id = ?", w.id);
      await this.scheduleAt(now + MESSAGE_TTL_MS);
      logEvent("message.matched", { ...meta, waitId: w.id });
      return { outcome: "matched", waitId: w.id };
    }
    // DECISION: the alert's kind comes from the whole message, links included (a reset link's
    // path says "reset"); only the kind, the channel and the sender are kept.
    const kind = classifyUnmatched(
      [message.subject ?? "", message.text].join("\n").slice(0, 20_000),
    );
    const alertId = crypto.randomUUID();
    this.sql.exec(
      "insert into alert (id, kind, channel, sender, received_at, created_at) values (?, ?, ?, ?, ?, ?)",
      alertId,
      kind,
      message.channel,
      message.sender,
      now,
      now,
    );
    await this.scheduleAt(now + ALERT_KEEP_MS);
    logEvent("message.alert", { ...meta, kind, alertId });
    return { outcome: "alert", kind, alertId };
  }

  // ── Housekeeping ───────────────────────────────────────────────────────────────────────────────

  /** Deletes held codes after ten minutes, old waits, counters and alerts; sets the next alarm. */
  override async alarm(): Promise<void> {
    if (!this.hasSchema()) return;
    const now = Date.now();
    this.sql.exec("delete from message where expires_at <= ?", now);
    const old = this.sql
      .exec<{ id: string }>("select id from wait where expires_at <= ?", now - WAIT_KEEP_MS)
      .toArray();
    for (const w of old) {
      this.sql.exec("delete from message where wait_id = ?", w.id);
      this.sql.exec("delete from wait where id = ?", w.id);
    }
    this.sql.exec("delete from alert where created_at <= ?", now - ALERT_KEEP_MS);
    this.sql.exec("delete from request_count where day < ?", utcDay(now - 24 * 60 * MINUTE));
    const next = this.sql
      .exec<{ at: number | null }>(
        `select min(at) as at from (
           select min(expires_at) as at from message
           union all select min(expires_at) + ? from wait
           union all select min(created_at) + ? from alert)`,
        WAIT_KEEP_MS,
        ALERT_KEEP_MS,
      )
      .one().at;
    if (next !== null) await this.ctx.storage.setAlarm(Math.max(next, now + 1000));
  }
}
