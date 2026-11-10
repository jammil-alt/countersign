// BILL's v3 API as the billcom connector calls it: the host per environment, the sign-in with the
// client's login and our developer key, the session it gives (sent as headers, signed in again once
// when BILL says it has expired), BILL's error answers mapped to the framework's kinds, and amounts
// written onto the wire from their decimal text. Nothing here is checked against BILL yet:
// ./NOTES.md lists each fact and its status.

import { dec, toNumeric } from "@countersign/core";
import { z } from "zod";
import { type ToolContext, ToolRefused, UnconfirmedWriteError } from "../connector";
import { formEncode, type HttpResponseLike, timeoutSignal } from "../http";
import { ReconnectRequiredError } from "../oauth/tokens";

export const BILLCOM_API_BASE = {
  sandbox: "https://gateway.stage.bill.com/connect/v3",
  production: "https://gateway.prod.bill.com/connect/v3",
} as const;

export const BillcomEnvironment = z.enum(["sandbox", "production"]);
export type BillcomEnvironment = z.infer<typeof BillcomEnvironment>;

/** `BILL_ENV`: `production` only when it says so; anything else is the sandbox. */
export function billcomEnvironment(raw: string | null | undefined): BillcomEnvironment {
  return raw?.trim().toLowerCase() === "production" ? "production" : "sandbox";
}

/**
 * A BILL id (vendor `009…`, bill `00n…`, organization `008…`): letters and digits only, so nothing
 * else reaches a URL path or a filter.
 */
// UNCHECKED (NOTES.md): the prefixes and length; only the character set is relied on.
export const BillcomId = z.string().regex(/^[A-Za-z0-9]{1,40}$/, "a BILL id (letters and digits)");

/**
 * The client admin's entry in the vault for the BILL user we sign in as (docs/plan.md §1.87). The
 * password is secret: write-only, never returned, logged or shown (invariant 13).
 */
export const BILLCOM_CREDENTIAL_FIELDS = [
  {
    name: "username",
    label: "BILL user's email",
    secret: false,
    hint: "A BILL user made for us, with the smallest role that does the job. Not an administrator.",
  },
  { name: "password", label: "BILL user's password", secret: true },
  {
    name: "organizationId",
    label: "BILL organization id",
    secret: false,
    hint: "In BILL, Settings, then Profiles, then Organization: the id that starts with 008.",
  },
] as const;

export const BillcomCredentials = z.object({
  username: z.string().trim().min(1).max(320),
  password: z.string().min(1).max(4000),
  organizationId: BillcomId,
});
export type BillcomCredentials = z.infer<typeof BillcomCredentials>;

/** fetch, with a body that may be bytes (a document uploaded to a bill). */
export interface BillcomRequestInit {
  method?: string;
  headers?: Record<string, string>;
  body?: string | Uint8Array;
  redirect?: "manual" | "follow" | "error";
  signal?: unknown;
}
export type BillcomFetch = (url: string, init?: BillcomRequestInit) => Promise<HttpResponseLike>;

export function runtimeBillcomFetch(): BillcomFetch {
  const f = (globalThis as unknown as { fetch?: BillcomFetch }).fetch;
  if (!f) throw new Error("fetch is not available in this runtime");
  return (url, init) => f(url, init);
}

// ── Errors ──────────────────────────────────────────────────────────────────────────────────────

/** What kind of no BILL gave (the framework's kinds; a sign-in that needs a person is separate). */
export type BillcomErrorKind =
  | "invalid_input"
  | "not_found"
  | "forbidden"
  | "conflict"
  | "rate_limited"
  | "unavailable"
  | "refused";

/**
 * BILL answered and said no. Every 4xx answer means nothing was written (`notWritten`), so a step
 * with `onError: continue` may go on; 429 and 5xx on a read may get through on the step's retry.
 * A write that may have been made never ends here: it is an UnconfirmedWriteError.
 */
export class BillcomApiError extends Error {
  readonly notWritten: boolean;
  constructor(
    readonly status: number,
    /** BILL's error code (`BDC_…`), or `HTTP_<n>`. */
    readonly code: string,
    message: string,
    readonly kind: BillcomErrorKind,
    readonly retryable: boolean,
    notWritten = true,
  ) {
    super(message);
    this.name = "BillcomApiError";
    this.notWritten = notWritten;
  }
}

/** A change BILL can't take as asked (its own validation, or ours before sending): not written. */
export class BillcomInvalidInputError extends BillcomApiError {
  constructor(message: string, code = "INVALID_INPUT", status = 422) {
    super(status, code, message, "invalid_input", false);
    this.name = "BillcomInvalidInputError";
  }
}

/** BILL isn't set up on this deployment: no developer key. A refusal; nothing was sent. */
export class BillcomNotConfiguredError extends ToolRefused {
  readonly notWritten = true;
  constructor(why = "BILL isn't set up here yet: this deployment has no BILL developer key") {
    super(why);
    this.name = "BillcomNotConfiguredError";
  }
}

/**
 * Codes BILL gives for a session that has ended (signed out, timed out).
 * UNCHECKED (NOTES.md): BDC_1109 is v2's "session is invalid"; v3 is expected to answer 401.
 */
const SESSION_CODES: ReadonlySet<string> = new Set(["BDC_1109"]);

/** BILL's error answer: an array of `{code, message}` (v3), or one such object. */
export function readBillcomError(body: unknown): { code: string | null; message: string | null } {
  const first = Array.isArray(body) ? body[0] : body;
  if (!first || typeof first !== "object") return { code: null, message: null };
  const b = first as Record<string, unknown>;
  const nested = (b.error ?? b.response_data) as Record<string, unknown> | undefined;
  const pick = (...vals: unknown[]): string | undefined =>
    vals.find((v): v is string => typeof v === "string" && v.length > 0);
  return {
    code: pick(b.code, b.errorCode, b.error_code, nested?.code, nested?.error_code) ?? null,
    message:
      pick(b.message, b.errorMessage, b.error_message, nested?.message, nested?.error_message) ??
      null,
  };
}

/** Text from BILL with every secret we hold taken out, cut to a length a step's error can show. */
function scrub(text: string, secrets: readonly string[]): string {
  let out = text;
  for (const s of secrets) {
    if (s.length >= 4) out = out.split(s).join("[hidden]");
  }
  return out.length > 300 ? `${out.slice(0, 300)}…` : out;
}

const KIND_OF_STATUS: Record<number, BillcomErrorKind> = {
  400: "invalid_input",
  403: "forbidden",
  404: "not_found",
  409: "conflict",
  422: "invalid_input",
  429: "rate_limited",
};

// ── Wire JSON ───────────────────────────────────────────────────────────────────────────────────

/** A decimal that goes onto the wire as a JSON number, written from its text. */
export class WireDecimal {
  constructor(readonly text: string) {}
}

/** A money string → its wire form (`831.2500` → `831.25`). */
export function wire(value: string): WireDecimal {
  return new WireDecimal(dec(value).toString());
}

const MARK = "\u0000billdec:";

/**
 * JSON for BILL with WireDecimal values written as numbers straight from their decimal text.
 */
// DECISION: BILL takes amounts as JSON numbers (NOTES.md); invariant 6 says no floats, so the
// number is written from the decimal's text, as QuickBooks' amounts are (qbo/records.ts).
export function billcomJson(body: unknown): string {
  const text = JSON.stringify(body, (_key, value) =>
    value instanceof WireDecimal ? `${MARK}${value.text}` : value,
  );
  return text.replace(/"\\u0000billdec:(-?\d+(?:\.\d+)?)"/g, "$1");
}

/** BILL's amount (a JSON number, or text) → `numeric(14,4)` text, never computed as a float. */
export function billcomAmount(v: number | string): string {
  return toNumeric(dec(String(v)));
}

// ── The client ──────────────────────────────────────────────────────────────────────────────────

interface Session {
  id: string;
  /** Whether BILL counts the session as confirmed with a second factor (payments need it). */
  trusted: boolean;
}

/** One tool call's (or one skill run's) BILL session, filled lazily and cleared on expiry. */
export interface SessionHolder {
  session: Session | null;
}

const LoginAnswer = z.looseObject({
  sessionId: z.string().min(8).max(500),
  organizationId: z.string().optional(),
  userId: z.string().optional(),
  trusted: z.boolean().optional(),
});

/** What a write says about itself if it may have been made without our knowing. */
export interface WriteNote {
  /** "The bill INV-1 from Acme may have been created in BILL". */
  title: string;
  details?: Record<string, string>;
}

export interface BillcomClientOptions {
  base: string;
  devKey: string;
  fetch: BillcomFetch;
}

/**
 * BILL for one connection. Signs in on its first request (the login is read from the vault then,
 * used once, and kept nowhere), sends the session as headers, signs in again once when BILL says
 * the session has ended, and signs out when the call (or the run holding it) is done.
 */
export class BillcomClient {
  constructor(
    private readonly opts: BillcomClientOptions,
    private readonly ctx: ToolContext,
    private readonly holder: SessionHolder,
  ) {}

  /** Signs in with the client's login. The password is read here and goes nowhere else. */
  private async login(): Promise<Session> {
    const creds = BillcomCredentials.safeParse(await this.ctx.credentials.get());
    if (!creds.success) {
      throw signInNeeded("the BILL connection has no complete login");
    }
    const { username, password, organizationId } = creds.data;
    const secrets = [password, this.opts.devKey];
    this.ctx.logger.info("signing in to BILL");
    let res: HttpResponseLike;
    try {
      res = await this.opts.fetch(`${this.opts.base}/login`, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({ username, password, organizationId, devKey: this.opts.devKey }),
        redirect: "manual",
        signal: timeoutSignal(20_000),
      });
    } catch {
      throw new BillcomApiError(
        0,
        "NETWORK",
        "BILL didn't answer the sign-in",
        "unavailable",
        true,
      );
    }
    const body = await readJson(res);
    if (!res.ok) {
      const e = readBillcomError(body);
      const said = scrub(e.message ?? `HTTP ${res.status}`, secrets);
      const code = e.code ?? `HTTP_${res.status}`;
      if (res.status === 429) {
        throw new BillcomApiError(429, code, "BILL is limiting our requests", "rate_limited", true);
      }
      if (res.status >= 500) {
        throw new BillcomApiError(
          res.status,
          code,
          `BILL's sign-in failed: ${said}`,
          "unavailable",
          true,
        );
      }
      // UNCHECKED (NOTES.md): how BILL says the developer key itself is wrong. That is ours to fix,
      // not the client's, so it doesn't put their connection in error.
      if (/dev(eloper)?\s*key/i.test(e.message ?? "")) {
        throw new BillcomNotConfiguredError(`BILL refused our developer key: ${said}`);
      }
      throw signInNeeded(`BILL refused the login: ${said}`);
    }
    const answer = LoginAnswer.safeParse(body);
    if (!answer.success) {
      throw new BillcomApiError(
        res.status,
        "BAD_LOGIN_ANSWER",
        "BILL's sign-in answer has an unexpected shape",
        "unavailable",
        true,
      );
    }
    const session = { id: answer.data.sessionId, trusted: answer.data.trusted === true };
    this.holder.session = session;
    return session;
  }

  /** Whether this client's session (signing in first) is MFA-trusted. */
  async trusted(): Promise<boolean> {
    return (this.holder.session ?? (await this.login())).trusted;
  }

  /**
   * One request. `write` marks a request that changes something in BILL: an answer that never
   * came, a 5xx or an answer that doesn't read is then an UnconfirmedWriteError (it may have been
   * made), never a plain failure.
   */
  async request(
    method: "GET" | "POST" | "PATCH",
    path: string,
    opts: {
      query?: Record<string, string>;
      json?: unknown;
      bytes?: { data: Uint8Array; type: string };
      write?: WriteNote;
    } = {},
  ): Promise<unknown> {
    const qs = opts.query && Object.keys(opts.query).length > 0 ? `?${formEncode(opts.query)}` : "";
    const url = `${this.opts.base}${path}${qs}`;
    for (let attempt = 0; ; attempt++) {
      const session = this.holder.session ?? (await this.login());
      const secrets = [this.opts.devKey, session.id];
      let res: HttpResponseLike;
      try {
        res = await this.opts.fetch(url, {
          method,
          headers: {
            accept: "application/json",
            devKey: this.opts.devKey,
            sessionId: session.id,
            ...(opts.json !== undefined ? { "content-type": "application/json" } : {}),
            ...(opts.bytes ? { "content-type": opts.bytes.type } : {}),
          },
          ...(opts.json !== undefined ? { body: billcomJson(opts.json) } : {}),
          ...(opts.bytes ? { body: opts.bytes.data } : {}),
          redirect: "manual",
          signal: timeoutSignal(30_000),
        });
      } catch {
        if (opts.write) throw unconfirmed(opts.write, "BILL didn't answer");
        throw new BillcomApiError(0, "NETWORK", "BILL didn't answer", "unavailable", true);
      }
      const body = await readJson(res);
      if (res.ok) return body;
      const e = readBillcomError(body);
      const code = e.code ?? `HTTP_${res.status}`;
      const ended = res.status === 401 || SESSION_CODES.has(code);
      if (ended && attempt === 0) {
        // The session ended: BILL refused the request, so nothing was done. Sign in once more.
        this.holder.session = null;
        this.ctx.logger.info("BILL session ended; signing in again");
        continue;
      }
      if (ended) throw signInNeeded("BILL refused our session right after signing in");
      const said = scrub(e.message ?? `BILL answered ${res.status}`, secrets);
      if (res.status >= 500) {
        if (opts.write) throw unconfirmed(opts.write, `BILL answered ${res.status}: ${said}`);
        throw new BillcomApiError(res.status, code, said, "unavailable", true);
      }
      const kind = KIND_OF_STATUS[res.status] ?? "refused";
      if (kind === "invalid_input") throw new BillcomInvalidInputError(said, code, res.status);
      throw new BillcomApiError(res.status, code, said, kind, kind === "rate_limited");
    }
  }

  /** Ends the session at BILL, best effort: the session is dropped here whatever BILL says. */
  async logout(): Promise<void> {
    const session = this.holder.session;
    this.holder.session = null;
    if (!session) return;
    try {
      await this.opts.fetch(`${this.opts.base}/logout`, {
        method: "POST",
        headers: { accept: "application/json", devKey: this.opts.devKey, sessionId: session.id },
        redirect: "manual",
        signal: timeoutSignal(10_000),
      });
    } catch {
      // The session times out at BILL on its own.
    }
  }
}

/**
 * The client must enter the login again: the connection is marked as needing a person. Every such
 * refusal comes before BILL took any change (a sign-in, or a request BILL turned away), so it is
 * marked not written too.
 */
function signInNeeded(message: string): ReconnectRequiredError {
  return Object.assign(new ReconnectRequiredError(message), { notWritten: true as const });
}

function unconfirmed(note: WriteNote, why: string): UnconfirmedWriteError {
  return new UnconfirmedWriteError(note.title, why, {
    connector: "billcom",
    ...(note.details ?? {}),
  });
}

/** A write's answer read with its schema; one that doesn't read may still have been made. */
export function writeAnswer<T extends z.ZodType>(
  schema: T,
  answer: unknown,
  note: WriteNote,
): z.output<T> {
  const parsed = schema.safeParse(answer);
  if (!parsed.success) throw unconfirmed(note, "BILL's answer didn't read as expected");
  return parsed.data;
}

async function readJson(res: HttpResponseLike): Promise<unknown> {
  const text = await res.text();
  try {
    return text ? JSON.parse(text) : null;
  } catch {
    return null;
  }
}

/** A refusal before anything was sent: what the change asks for isn't possible. */
export function refuse(message: string): BillcomInvalidInputError {
  return new BillcomInvalidInputError(message);
}
