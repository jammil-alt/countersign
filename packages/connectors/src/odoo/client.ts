// Odoo's external API as the odoo connector calls it: JSON-RPC 2.0 at `<address>/jsonrpc`, signed
// in with the client's own login and API key (`common.authenticate` gives the user id, then every
// call is `object.execute_kw` with the database, that id and the key). Odoo answers each call in
// one database transaction that it rolls back on any error, so an error answer means nothing was
// written. Amounts go onto the wire as JSON numbers written from their decimal text. Nothing here
// is checked against a live Odoo yet: ./NOTES.md lists each fact and its status.

import { dec } from "@countersign/core";
import { z } from "zod";
import { type ToolContext, ToolRefused, UnconfirmedWriteError } from "../connector";
import {
  checkPublicHttpsUrl,
  type FetchLike,
  globalFetch,
  type HttpResponseLike,
  timeoutSignal,
} from "../http";
import { ReconnectRequiredError } from "../oauth/tokens";

/**
 * The client admin's entry in the vault for the Odoo user we act as. The API key is secret:
 * write-only, never returned, logged or shown (invariant 13).
 */
export const ODOO_CREDENTIAL_FIELDS = [
  {
    name: "url",
    label: "Odoo address",
    secret: false,
    hint: "The address you open Odoo at, for example https://yourcompany.odoo.com.",
  },
  {
    name: "database",
    label: "Odoo database",
    secret: false,
    hint: "On Odoo Online, usually the first part of the address (yourcompany). Odoo shows it under Settings, then About.",
  },
  {
    name: "login",
    label: "Odoo user's login",
    secret: false,
    hint: "An Odoo user made for us, with only the apps and rights the work needs. Not an administrator.",
  },
  {
    name: "apiKey",
    label: "Odoo user's API key",
    secret: true,
    hint: "Signed in to Odoo as that user: My Profile, then Account Security, then New API Key.",
  },
] as const;

/** An Odoo database name: what the database manager allows (UNCHECKED, NOTES.md). */
const DatabaseName = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,62}$/, "an Odoo database name");

export const OdooCredentials = z.object({
  url: z.string().trim().min(1).max(2048),
  database: DatabaseName,
  login: z.string().trim().min(1).max(320),
  apiKey: z.string().min(1).max(4000),
});
export type OdooCredentials = z.infer<typeof OdooCredentials>;

/**
 * The address calls go to: the origin of the address the client gave, https on a public host only
 * (no private, loopback or internal address: SSRF), or null.
 */
// DECISION: only the origin is kept (a path the client pasted, like /odoo/action-123, is dropped):
// Odoo's JSON-RPC endpoint is at the root of the address (UNCHECKED for Odoo behind a path prefix,
// NOTES.md).
export function odooOrigin(raw: string): string | null {
  const checked = checkPublicHttpsUrl(raw.trim());
  return checked.ok ? checked.url.origin : null;
}

// ── Errors ──────────────────────────────────────────────────────────────────────────────────────

export type OdooErrorKind =
  | "invalid_input"
  | "not_found"
  | "forbidden"
  | "conflict"
  | "rate_limited"
  | "unavailable"
  | "refused";

/**
 * Odoo answered and said no. An error answer to a JSON-RPC call means Odoo rolled the call's
 * transaction back (`notWritten`); 429 and 5xx on a read may get through on the step's retry. A
 * write that may have been made never ends here: it is an UnconfirmedWriteError.
 */
export class OdooApiError extends Error {
  readonly notWritten: boolean;
  constructor(
    readonly status: number,
    /** Odoo's exception name (`odoo.exceptions.UserError`), or `HTTP_<n>`. */
    readonly code: string,
    message: string,
    readonly kind: OdooErrorKind,
    readonly retryable: boolean,
    notWritten = true,
  ) {
    super(message);
    this.name = "OdooApiError";
    this.notWritten = notWritten;
  }
}

/** A change refused before anything was sent, or one Odoo's own checks turned down. */
export class OdooInvalidInputError extends OdooApiError {
  constructor(message: string, code = "INVALID_INPUT") {
    super(422, code, message, "invalid_input", false);
    this.name = "OdooInvalidInputError";
  }
}

/** The connection's Odoo address isn't one we call (not https, or not a public host). */
export class OdooAddressRefused extends ToolRefused {
  readonly notWritten = true;
  constructor() {
    super(
      "The Odoo address on this connection isn't one we can call: it must be an https address on the internet.",
    );
    this.name = "OdooAddressRefused";
  }
}

/** Odoo's exception names → what kind of no it is. Anything else is a refusal. */
const KIND_OF_EXCEPTION: Record<string, OdooErrorKind> = {
  "odoo.exceptions.AccessError": "forbidden",
  "odoo.exceptions.MissingError": "not_found",
  "odoo.exceptions.ValidationError": "invalid_input",
  "odoo.exceptions.UserError": "invalid_input",
  "odoo.exceptions.RedirectWarning": "invalid_input",
  "builtins.ValueError": "invalid_input",
  "builtins.TypeError": "invalid_input",
  "builtins.KeyError": "invalid_input",
  "psycopg2.errors.UniqueViolation": "conflict",
  "psycopg2.errors.SerializationFailure": "unavailable",
  "odoo.exceptions.ConcurrencyError": "unavailable",
};

/** The client must enter the login again; Odoo turned the call away, so nothing was written. */
function signInNeeded(message: string): ReconnectRequiredError {
  return Object.assign(new ReconnectRequiredError(message), { notWritten: true as const });
}

/** Text from Odoo with every secret we hold taken out, cut to a length a step's error can show. */
function scrub(text: string, secrets: readonly string[]): string {
  let out = text;
  for (const s of secrets) {
    if (s.length >= 4) out = out.split(s).join("[hidden]");
  }
  out = out.replace(/\s+/g, " ").trim();
  return out.length > 300 ? `${out.slice(0, 300)}…` : out;
}

// ── Wire JSON ───────────────────────────────────────────────────────────────────────────────────

/** A decimal that goes onto the wire as a JSON number, written from its text. */
export class OdooDecimal {
  constructor(readonly text: string) {}
}

/** A decimal string → its wire form (`831.2500` → `831.25`). */
export function wireDecimal(value: string): OdooDecimal {
  return new OdooDecimal(dec(value).toString());
}

const MARK = "\u0000odoodec:";

/**
 * JSON for Odoo with OdooDecimal values written as numbers straight from their decimal text.
 */
// DECISION: Odoo takes float and monetary fields as JSON numbers; invariant 6 says no JS floats,
// so the number is written from the decimal's text, as BILL's and QuickBooks' amounts are.
export function odooJson(body: unknown): string {
  const text = JSON.stringify(body, (_key, value) =>
    value instanceof OdooDecimal ? `${MARK}${value.text}` : value,
  );
  return text.replace(/"\\u0000odoodec:(-?\d+(?:\.\d+)?)"/g, "$1");
}

// ── The client ──────────────────────────────────────────────────────────────────────────────────

const RpcAnswer = z.looseObject({
  jsonrpc: z.literal("2.0").optional(),
  result: z.unknown().optional(),
  error: z
    .looseObject({
      code: z.number().optional(),
      message: z.string().optional(),
      data: z
        .looseObject({ name: z.string().optional(), message: z.string().optional() })
        .optional(),
    })
    .optional(),
});

/** What a write says about itself if it may have been made without our knowing. */
export interface WriteNote {
  /** "A quotation for Harbor Millwork may have been created in Odoo". */
  title: string;
  details?: Record<string, string>;
}

function unconfirmed(note: WriteNote, why: string): UnconfirmedWriteError {
  return new UnconfirmedWriteError(note.title, why, { connector: "odoo", ...(note.details ?? {}) });
}

export interface OdooClientOptions {
  fetch?: FetchLike | undefined;
}

/**
 * Odoo for one tool call. Signs in on its first call (the login is read from the vault then and
 * kept only for this call), and calls `execute_kw` with the user id Odoo gave.
 */
// DECISION: JSON-RPC at /jsonrpc, not Odoo 19's /json/2 API: it answers on every Odoo the clients
// we know run (14 to 19, Online and on their own servers), where /json/2 exists only from 19.
// Odoo has said the old endpoints go in a later version (UNCHECKED which, NOTES.md); /json/2 is
// then a change to this file alone.
export class OdooClient {
  private session: { origin: string; creds: OdooCredentials; uid: number } | null = null;
  private seq = 0;

  constructor(
    private readonly ctx: ToolContext,
    private readonly opts: OdooClientOptions = {},
  ) {}

  private doFetch(): FetchLike {
    return this.opts.fetch ?? globalFetch();
  }

  /** The user id Odoo signs us in as (signing in first). */
  async uid(): Promise<number> {
    return (await this.signIn()).uid;
  }

  private async signIn(): Promise<{ origin: string; creds: OdooCredentials; uid: number }> {
    if (this.session) return this.session;
    const parsed = OdooCredentials.safeParse(await this.ctx.credentials.get());
    if (!parsed.success) throw signInNeeded("the Odoo connection has no complete login");
    const creds = parsed.data;
    const origin = odooOrigin(creds.url);
    if (!origin) throw new OdooAddressRefused();
    this.ctx.logger.info("signing in to odoo");
    let uid: unknown;
    try {
      uid = await this.rpc(origin, creds, "common", "authenticate", [
        creds.database,
        creds.login,
        creds.apiKey,
        {},
      ]);
    } catch (error) {
      // A database that isn't there, or a login Odoo refuses outright: the client's to fix.
      if (error instanceof OdooApiError && !error.retryable && error.status === 200) {
        throw signInNeeded(`Odoo refused the sign-in: ${error.message}`);
      }
      throw error;
    }
    // Odoo answers `false` for a login or key it doesn't take.
    if (typeof uid !== "number" || !Number.isInteger(uid) || uid <= 0) {
      throw signInNeeded("Odoo refused the login or API key");
    }
    this.session = { origin, creds, uid };
    return this.session;
  }

  /**
   * One model method (`execute_kw`). `write` marks a call that changes something in Odoo: an answer
   * that never came, a 5xx, or one that doesn't read is then an UnconfirmedWriteError (it may have
   * been made), never a plain failure.
   */
  async execute(
    model: string,
    method: string,
    args: unknown[],
    kwargs: Record<string, unknown> = {},
    write?: WriteNote,
  ): Promise<unknown> {
    const s = await this.signIn();
    return this.rpc(
      s.origin,
      s.creds,
      "object",
      "execute_kw",
      [s.creds.database, s.uid, s.creds.apiKey, model, method, args, kwargs],
      write,
    );
  }

  private async rpc(
    origin: string,
    creds: OdooCredentials,
    service: "common" | "object",
    method: string,
    args: unknown[],
    write?: WriteNote,
  ): Promise<unknown> {
    const secrets = [creds.apiKey];
    this.seq += 1;
    let res: HttpResponseLike;
    try {
      res = await this.doFetch()(`${origin}/jsonrpc`, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: odooJson({
          jsonrpc: "2.0",
          method: "call",
          params: { service, method, args },
          id: this.seq,
        }),
        // A redirect is never followed: the key goes only to the address the client gave.
        redirect: "manual",
        signal: timeoutSignal(30_000),
      });
    } catch {
      if (write) throw unconfirmed(write, "Odoo didn't answer");
      throw new OdooApiError(0, "NETWORK", "Odoo didn't answer", "unavailable", true);
    }
    const text = await res.text();
    if (res.status >= 300 && res.status < 400) {
      // Nothing reached Odoo's database: a redirect is answered before any model code runs.
      throw new OdooApiError(
        res.status,
        `HTTP_${res.status}`,
        "Odoo answered with a redirect: check the Odoo address on the connection",
        "refused",
        false,
      );
    }
    if (res.status === 429) {
      throw new OdooApiError(
        429,
        "HTTP_429",
        "Odoo is limiting our requests",
        "rate_limited",
        true,
      );
    }
    if (res.status >= 500 || !res.ok) {
      if (write && res.status >= 500) {
        throw unconfirmed(write, `Odoo answered ${res.status}`);
      }
      const kind: OdooErrorKind =
        res.status === 404 ? "not_found" : res.status >= 500 ? "unavailable" : "refused";
      throw new OdooApiError(
        res.status,
        `HTTP_${res.status}`,
        res.status === 404
          ? "Odoo has no API at this address: check the Odoo address on the connection"
          : `Odoo answered ${res.status}`,
        kind,
        res.status >= 500,
      );
    }
    let json: unknown = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    const answer = RpcAnswer.safeParse(json);
    if (!answer.success || (answer.data.error === undefined && !("result" in answer.data))) {
      if (write) throw unconfirmed(write, "Odoo's answer didn't read as expected");
      throw new OdooApiError(
        res.status,
        "BAD_ANSWER",
        "Odoo's answer didn't read as expected",
        "unavailable",
        true,
      );
    }
    const error = answer.data.error;
    if (error) {
      // The transaction was rolled back: nothing was written, whatever the call was.
      const name = error.data?.name ?? `JSONRPC_${error.code ?? "ERROR"}`;
      const said = scrub(error.data?.message ?? error.message ?? "Odoo refused the call", secrets);
      if (name === "odoo.exceptions.AccessDenied") {
        throw signInNeeded(`Odoo refused the login or API key: ${said}`);
      }
      const kind = KIND_OF_EXCEPTION[name] ?? "refused";
      if (kind === "invalid_input") throw new OdooInvalidInputError(said, name);
      throw new OdooApiError(200, name, said, kind, kind === "unavailable");
    }
    return answer.data.result;
  }
}

/** A refusal before anything was sent: what the change asks for isn't possible. */
export function refuse(message: string): OdooInvalidInputError {
  return new OdooInvalidInputError(message);
}

/** A write's answer read with its schema; one that doesn't read may still have been made. */
export function writeAnswer<T extends z.ZodType>(
  schema: T,
  answer: unknown,
  note: WriteNote,
): z.output<T> {
  const parsed = schema.safeParse(answer);
  if (!parsed.success) throw unconfirmed(note, "Odoo's answer didn't read as expected");
  return parsed.data;
}
