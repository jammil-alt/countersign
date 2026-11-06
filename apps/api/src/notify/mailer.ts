// How notifications leave (ARCHITECTURE §11.3, docs/plan.md §1.37). Email is Mezonas' own mail
// over the `resend` client with Mezonas' key, from `Mezonas <notify@RESEND_FALLBACK_DOMAIN>`, as
// human-release codes send: not an agent tool, not an external action, no record content. Texts go
// from the client's own Twilio number (its subaccount), exactly as release codes do: no raw record,
// no thread line, no status callback. Without a key nothing is sent and rows are `skipped`.

import {
  type FetchLike,
  globalFetch,
  readTwilioConfig,
  releaseTextSender,
  resendRequest,
  sendReleaseText,
  TWILIO_CONNECTOR_ID,
  twilioCredentialsOf,
} from "@countersign/connectors";
import { connection, type Tx } from "@countersign/db";
import { and, eq } from "drizzle-orm";
import type { Bindings } from "../env";
import { connectionCredentials } from "../secrets";

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
  html?: string;
  /** Resend's Idempotency-Key: the notification's id, so a retried send goes once. */
  idempotencyKey: string;
}

export interface Mailer {
  /** False when no key or sending domain is set: rows are written `skipped`, `not_configured`. */
  readonly isConfigured: boolean;
  /** Returns the provider's id. Throws when the send fails. */
  send(message: MailMessage): Promise<string>;
}

export const NOTIFY_LOCAL_PART = "notify";

/** Mezonas' mail over Resend; unconfigured without RESEND_API_KEY and RESEND_FALLBACK_DOMAIN. */
export function resendMailer(input: {
  apiKey: string | null | undefined;
  domain: string | null | undefined;
  fetch?: FetchLike;
}): Mailer {
  const apiKey = input.apiKey?.trim();
  const domain = input.domain?.trim().toLowerCase();
  if (!apiKey || !domain) return unconfiguredMailer;
  const fetch = input.fetch ?? globalFetch();
  return {
    isConfigured: true,
    async send(m) {
      const out = (await resendRequest(
        fetch,
        apiKey,
        "POST",
        "/emails",
        {
          from: `Mezonas <${NOTIFY_LOCAL_PART}@${domain}>`,
          to: [m.to],
          subject: m.subject,
          text: m.text,
          ...(m.html ? { html: m.html } : {}),
        },
        { "Idempotency-Key": `notify-${m.idempotencyKey}` },
      )) as { id?: unknown } | null;
      return typeof out?.id === "string" ? out.id : "";
    },
  };
}

export const unconfiguredMailer: Mailer = {
  isConfigured: false,
  send() {
    return Promise.reject(new Error("no email sender is set up"));
  },
};

export function mailerFromEnv(env: Bindings, fetch?: FetchLike): Mailer {
  return resendMailer({
    apiKey: env.RESEND_API_KEY,
    domain: env.RESEND_FALLBACK_DOMAIN,
    ...(fetch ? { fetch } : {}),
  });
}

// ── Texts ───────────────────────────────────────────────────────────────────────────────────────

export interface Texter {
  /** The client's number that can text now, or null (no Twilio, no SMS number, A2P pending). */
  from(tx: Tx, tenantId: string): Promise<string | null>;
  /** Sends from the client's number; returns the message SID. Throws when it can't. */
  send(tx: Tx, tenantId: string, input: { to: string; body: string }): Promise<string>;
}

async function twilioConnection(tx: Tx, tenantId: string) {
  const [row] = await tx
    .select()
    .from(connection)
    .where(
      and(
        eq(connection.tenantId, tenantId),
        eq(connection.connector, TWILIO_CONNECTOR_ID),
        eq(connection.status, "connected"),
      ),
    )
    .limit(1);
  return row ?? null;
}

/** Texts through the client's Twilio subaccount, as release codes send. */
export function twilioTexter(input: {
  fetch?: FetchLike;
  secrets: Pick<Bindings, "ENCRYPTION_KEY" | "ENCRYPTION_KEY_PREVIOUS">;
}): Texter {
  const fetch = input.fetch ?? globalFetch();
  return {
    async from(tx, tenantId) {
      const row = await twilioConnection(tx, tenantId);
      return row ? releaseTextSender(readTwilioConfig(row.config)) : null;
    },
    async send(tx, tenantId, m) {
      const row = await twilioConnection(tx, tenantId);
      const from = row ? releaseTextSender(readTwilioConfig(row.config)) : null;
      if (!row || !from) throw new Error("the client's number can't text now");
      const creds = twilioCredentialsOf(
        await (await connectionCredentials(tx, input.secrets, row)).get(),
      );
      if (!creds) throw new Error("the client's Twilio connection has no credentials");
      return sendReleaseText(fetch, creds, { from, to: m.to, body: m.body });
    },
  };
}

export function texterFromEnv(env: Bindings, fetch?: FetchLike): Texter {
  return twilioTexter({
    ...(fetch ? { fetch } : {}),
    secrets: {
      ...(env.ENCRYPTION_KEY ? { ENCRYPTION_KEY: env.ENCRYPTION_KEY } : {}),
      ...(env.ENCRYPTION_KEY_PREVIOUS
        ? { ENCRYPTION_KEY_PREVIOUS: env.ENCRYPTION_KEY_PREVIOUS }
        : {}),
    },
  });
}
