// The Worker's environment: the bindings and vars wrangler.jsonc declares (the generated `Env`),
// plus the secrets, which never appear in wrangler.jsonc and so are not in the generated type.

import type { BrowserWorker } from "@cloudflare/playwright";
import type { CodesService } from "@countersign/core";

export interface Secrets {
  WORKOS_API_KEY?: string;
  WORKOS_COOKIE_PASSWORD?: string;
  ANTHROPIC_API_KEY?: string;
  /** Loaded by deploy.yml; OpenAI models (`openai:` ids) in packages/llm. */
  OPENAI_API_KEY?: string;
  /** 32 bytes, base64: connection credentials at rest (ARCHITECTURE §17). */
  ENCRYPTION_KEY?: string;
  ENCRYPTION_KEY_PREVIOUS?: string;
  /** At least 32 bytes: signs the OAuth `state` of a client's sign-in to a tool. */
  OAUTH_STATE_SECRET?: string;
  /** Zoho API console: a Server-based application with multi-DC on (ARCHITECTURE §6.7). */
  ZOHO_CLIENT_ID?: string;
  ZOHO_CLIENT_SECRET?: string;
  /** The Intuit app "Mezonas" (QuickBooks Online, ARCHITECTURE §6.2): OAuth client and secret. */
  QBO_CLIENT_ID?: string;
  QBO_CLIENT_SECRET?: string;
  /** The Intuit app's webhook verifier token: signs `intuit-signature` (HMAC-SHA256). */
  QBO_WEBHOOK_VERIFIER?: string;
  /** Mezonas' own Twilio account: it makes each client's subaccount (docs/plan.md §1.22). */
  TWILIO_ACCOUNT_SID?: string;
  TWILIO_AUTH_TOKEN?: string;
  /** Mezonas' own ElevenLabs account: the voice agents on calls (docs/plan.md §1.23). */
  ELEVENLABS_API_KEY?: string;
  /** Signs ElevenLabs' post-call webhook; also keys each call's tool token. */
  ELEVENLABS_WEBHOOK_SECRET?: string;
  /** Mezonas' own Resend account: makes each client's sending domain and key (docs/plan.md §1.25). */
  RESEND_API_KEY?: string;
  /** Our own sending domain, used until a client's domain is verified (e.g. mail.mezonas.com). */
  RESEND_FALLBACK_DOMAIN?: string;
  /** Resend's id for that domain, so fallback keys can send only from it. */
  RESEND_FALLBACK_DOMAIN_ID?: string;
  /** Google Cloud's OAuth client "Mezonas web": Gmail, send only (ARCHITECTURE §6.4). */
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  // v0.12 W3-B: Google Drive signs in with GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET above.
  /** The Entra app registration "Mezonas": Outlook, send only (ARCHITECTURE §6.11). */
  OUTLOOK_CLIENT_ID?: string;
  OUTLOOK_CLIENT_SECRET?: string;
  /** Podio API key (ARCHITECTURE §6.8). */
  PODIO_CLIENT_ID?: string;
  PODIO_CLIENT_SECRET?: string;
  /** Mezonas' own Stripe account (billing, docs/plan.md §1.24); unset: billing is off. */
  STRIPE_SECRET_KEY?: string;
  /** The Stripe webhook endpoint's signing secret (`whsec_…`) for /api/billing/stripe/webhook. */
  STRIPE_WEBHOOK_SECRET?: string;
  /** R2's S3 API, for presigned links to documents (ARCHITECTURE §17). Optional: see storage.ts. */
  STORAGE_ENDPOINT?: string;
  STORAGE_BUCKET?: string;
  STORAGE_ACCESS_KEY?: string;
  STORAGE_SECRET_KEY?: string;
}

/** Vars are read as plain strings: deployments set values the generated literals don't know. */
export interface Vars {
  ENVIRONMENT?: string;
  AUTH_PROVIDER?: string;
  WORKOS_CLIENT_ID?: string;
  /**
   * This environment's AuthKit domain (`https://<name>.authkit.app`): the authorization server of
   * the back office's MCP server at `<APP_ORIGIN>/mcp` (docs/plan.md §1.34). Empty: /mcp is off.
   */
  WORKOS_AUTHKIT_DOMAIN?: string;
  /** What an MCP access token's `aud` must contain; unset, `<APP_ORIGIN>/mcp`. */
  MCP_AUDIENCE?: string;
  APP_ORIGIN?: string;
  LLM_MODE?: string;
  /** e.g. `in.mezonas.com`: Cloudflare Email Routing sends it to `email()`. Unset: forwarding is off. */
  EMAIL_FORWARDING_DOMAIN?: string;
  /** `sandbox` (default) or `production`: which QuickBooks the qbo connector talks to. */
  QBO_ENV?: string;
  /**
   * Where Google sends the person back after Gmail's consent screen; it must match a redirect URI
   * registered on the OAuth client exactly. Unset: `<APP_ORIGIN>/api/connections/gmail/callback`.
   */
  GOOGLE_REDIRECT_URI?: string;
  /**
   * The vendors with a signed BAA (docs/plan.md §1.35), e.g. `cloudflare,neon,workos,anthropic`:
   * what a client in HIPAA mode may send data to. Unset: none, so no client can be in HIPAA mode.
   */
  BAA_PROCESSORS?: string;
  /** Error tracking (src/observability/sentry.ts); set by deploy.yml with `--var`. Not a secret. */
  SENTRY_DSN?: string;
  /** The deployed commit, Sentry's release; set by deploy.yml with `--var`. */
  DEPLOYED_SHA?: string;
}

/**
 * Bindings not (yet) in wrangler.jsonc everywhere. `CODES` is the code service (apps/mfa,
 * Worker `mezonas-codes`), reached only by this service binding; unset, it is off. `BROWSER` is
 * Cloudflare Browser Run, for browser logins (docs/plan.md §1.26); unset, they are not available.
 */
export interface OptionalBindings {
  CODES?: CodesService;
  /** QboSyncWorkflow: one instance per QuickBooks sync (cron, webhook, "sync now"). */
  QBO_SYNC?: Workflow;
  /** ExportWorkflow: one instance per client data export (docs/plan.md §1.36). */
  EXPORT_WORKFLOW?: Workflow;
  // v0.12 W2-C
  /** TestSuiteWorkflow: one instance per test suite run (docs/plan.md §1.46). */
  TEST_SUITE_WORKFLOW?: Workflow;
  BROWSER?: BrowserWorker;
  /** Cloudflare's rate limiting: MCP calls per operator (src/mcp/limits.ts); unset, per isolate. */
  MCP_RATE_LIMIT?: RateLimiterBinding;
}

/** Cloudflare's Rate Limiting binding, as much of it as is used. */
export interface RateLimiterBinding {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}

export type Bindings = Omit<Env, keyof Vars | keyof OptionalBindings> &
  Vars &
  Secrets &
  OptionalBindings;
