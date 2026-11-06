// "qbo": QuickBooks Online over OAuth 2.0 (ARCHITECTURE §6.2, plan M9). The client signs in to its
// own QuickBooks from the portal; tokens and the company id are kept encrypted in the client's vault
// (§6.9), refreshed before expiry and on a 401, the new refresh token stored every time. Sync reads
// raw records (./sync.ts), webhooks only nudge a sync (./webhook.ts), and the tools (./tools.ts)
// read and, behind approval, write. What was and wasn't checked against Intuit: ./NOTES.md.

import { QBO_CONNECTOR_ID, QBO_SYNCED_ENTITIES } from "@countersign/core";
import {
  type AttachmentRef,
  type ConnectionContext,
  type Connector,
  defineConnector,
  type RawRecordInput,
  type ToolContext,
} from "../connector";
import { formEncode, globalFetch, timeoutSignal } from "../http";
import {
  basicAuth,
  QBO_API_BASE,
  QBO_AUTHORIZE_URL,
  QBO_MINOR_VERSION,
  QBO_REVOKE_URL,
  QBO_SCOPE,
  type QboAppKeys,
  type QboClient,
  QboCredentials,
  type QboEnvironment,
  type QboFetch,
  QboNotConfiguredError,
  qboClient,
  qboLiteral,
  qboRefresher,
  qboTokenCall,
  RealmId,
  tokensFrom,
} from "./api";
import { type QboSyncCursor, qboRawRecord, qboSyncPage } from "./sync";
import { qboTools } from "./tools";
import { QBO_SIGNATURE_HEADER, verifyQboWebhook } from "./webhook";

export * from "./api";
export * from "./ar";
export * from "./bill-create";
export * from "./records";
export * from "./skills";
export * from "./sync";
export * from "./tools";
export * from "./webhook";
export { QBO_CONNECTOR_ID };

export interface QboOptions {
  /** The Intuit app's OAuth client (QBO_CLIENT_ID, QBO_CLIENT_SECRET). */
  clientId?: string | undefined;
  clientSecret?: string | undefined;
  /** Which QuickBooks this deployment talks to (QBO_ENV); default sandbox. */
  environment?: QboEnvironment;
  /** The app's webhook verifier token (QBO_WEBHOOK_VERIFIER). */
  webhookVerifier?: string | undefined;
  fetch?: QboFetch;
  minorVersion?: string;
  /** Waits between 429 retries (tests pass a fast one). */
  sleep?: (ms: number) => Promise<void>;
  /** The clock for tokens issued at sign-in (tests pass a fixed one). */
  now?: () => Date;
}

/** The connector plus what the platform's sync and webhook need beyond the Connector interface. */
export interface QboConnector extends Connector {
  /** A client over one connection's company (tokens refreshed as needed). */
  client(ctx: ConnectionContext): Promise<QboClient>;
  environment: QboEnvironment;
}

export function createQboConnector(options: QboOptions = {}): QboConnector {
  const environment = options.environment ?? "sandbox";
  const doFetch = (): QboFetch => options.fetch ?? (globalFetch() as unknown as QboFetch);
  const configured = Boolean(options.clientId && options.clientSecret);
  const keys = (): QboAppKeys => {
    if (!options.clientId || !options.clientSecret) throw new QboNotConfiguredError();
    return { clientId: options.clientId, clientSecret: options.clientSecret };
  };
  const refresher = qboRefresher(doFetch, keys);
  const client = (ctx: ToolContext) =>
    qboClient(ctx, {
      fetch: doFetch(),
      environment,
      refresher,
      ...(options.minorVersion ? { minorVersion: options.minorVersion } : {}),
      ...(options.sleep ? { sleep: options.sleep } : {}),
    });

  const connector = defineConnector({
    id: QBO_CONNECTOR_ID,
    name: "QuickBooks Online",
    description:
      "Bills, purchases, vendors, items, attachments, and invoices, customers and payments in your QuickBooks Online. You sign in to QuickBooks yourself.",
    icon: "book",
    auth: "oauth2",
    entities: [...QBO_SYNCED_ENTITIES],
    isConfigured: () => configured,

    async authorize(req) {
      const k = keys();
      const query = formEncode({
        client_id: k.clientId,
        response_type: "code",
        scope: QBO_SCOPE,
        redirect_uri: req.redirectUri,
        state: req.state,
      });
      return { redirectUrl: `${QBO_AUTHORIZE_URL}?${query}` };
    },

    async handleCallback(params, req) {
      const code = params.code;
      if (!code) throw new Error("the QuickBooks callback has no code");
      const realm = RealmId.safeParse(params.realmId);
      if (!realm.success) throw new Error("the QuickBooks callback names no company (realmId)");
      const answer = await qboTokenCall(doFetch(), keys(), {
        grant_type: "authorization_code",
        code,
        redirect_uri: req.redirectUri,
      });
      if ("error" in answer) throw new Error(`Intuit refused the sign-in: ${answer.error}`);
      const credentials = QboCredentials.parse({
        ...tokensFrom(answer, (options.now ?? (() => new Date()))()),
        realmId: realm.data,
        environment,
      });
      // The company's name names the connection; a failure here fails the sign-in.
      const url = `${QBO_API_BASE[environment]}/v3/company/${realm.data}/companyinfo/${realm.data}?${formEncode({ minorversion: options.minorVersion ?? QBO_MINOR_VERSION })}`;
      const res = await doFetch()(url, {
        headers: { authorization: `Bearer ${answer.access_token}`, accept: "application/json" },
        redirect: "manual",
        signal: timeoutSignal(15_000),
      });
      let info: { CompanyInfo?: { CompanyName?: unknown; Country?: unknown } } = {};
      try {
        info = JSON.parse((await res.text()) || "{}");
      } catch {
        info = {};
      }
      const name = info.CompanyInfo?.CompanyName;
      if (!res.ok || typeof name !== "string") {
        throw new Error("could not read the QuickBooks company");
      }
      return {
        externalAccountId: realm.data,
        credentials: credentials as unknown as Record<string, never>,
        config: {
          accountName: name,
          environment,
          ...(typeof info.CompanyInfo?.Country === "string"
            ? { country: info.CompanyInfo.Country }
            : {}),
        },
      };
    },

    tokens: refresher,

    async revoke(ctx) {
      const creds = QboCredentials.safeParse(await ctx.credentials.get());
      if (!creds.success) return;
      const token = creds.data.refreshToken ?? creds.data.accessToken;
      // Revoking the refresh token ends the whole grant (the access token with it).
      const res = await doFetch()(QBO_REVOKE_URL, {
        method: "POST",
        headers: {
          authorization: basicAuth(keys()),
          "content-type": "application/json",
          accept: "application/json",
        },
        body: JSON.stringify({ token }),
        redirect: "manual",
        signal: timeoutSignal(15_000),
      });
      if (!res.ok) throw new Error(`Intuit answered ${res.status} to the revoke`);
    },

    // The Connector interface's sync: every page from a fresh start. The platform's sync job
    // (apps/api) pages with qboSyncPage itself, storing the cursor with each page.
    async *sync(ctx) {
      const c = await client(ctx);
      let cursor: QboSyncCursor | null = null;
      for (let i = 0; i < 1000; i++) {
        const page = await qboSyncPage(c, cursor, { now: ctx.now() });
        yield* page.records;
        cursor = page.next;
        if (page.done) return;
      }
    },

    async fetchAttachments(ctx, entityType, externalId) {
      const c = await client(ctx);
      const { rows } = await c.query(
        `select * from Attachable where AttachableRef.EntityRef.Type = ${qboLiteral(entityType)} and AttachableRef.EntityRef.value = ${qboLiteral(externalId)}`,
        "Attachable",
      );
      return rows
        .map((r) => qboRawRecord("Attachable", r))
        .filter((r): r is RawRecordInput => r !== null)
        .flatMap((r): AttachmentRef[] => {
          const p = r.payload as { FileName?: string; ContentType?: string; Size?: number };
          return p.FileName
            ? [
                {
                  externalId: r.externalId,
                  filename: p.FileName,
                  mime: p.ContentType ?? "application/octet-stream",
                  ...(typeof p.Size === "number" ? { size: p.Size } : {}),
                },
              ]
            : [];
        });
    },

    async downloadAttachment(ctx, ref) {
      const { bytes, contentType } = await (await client(ctx)).download(ref.externalId);
      return {
        bytes,
        mime: contentType?.split(";")[0]?.trim() || ref.mime,
        filename: ref.filename,
      };
    },

    async verifyWebhook(headers, body) {
      return verifyQboWebhook(options.webhookVerifier, headers[QBO_SIGNATURE_HEADER], body);
    },

    tools: qboTools(client),
  });
  return { ...connector, environment, client };
}
