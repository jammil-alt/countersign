// The Worker's environment: the bindings and vars wrangler.jsonc declares (the generated `Env`),
// plus the secrets, which never appear in wrangler.jsonc and so are not in the generated type.

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
  /** Mezonas' own Twilio account: it makes each client's subaccount (docs/plan.md §1.22). */
  TWILIO_ACCOUNT_SID?: string;
  TWILIO_AUTH_TOKEN?: string;
  /** Mezonas' own ElevenLabs account: the voice agents on calls (docs/plan.md §1.23). */
  ELEVENLABS_API_KEY?: string;
  /** Signs ElevenLabs' post-call webhook; also keys each call's tool token. */
  ELEVENLABS_WEBHOOK_SECRET?: string;
  /** Podio API key (ARCHITECTURE §6.8). */
  PODIO_CLIENT_ID?: string;
  PODIO_CLIENT_SECRET?: string;
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
  APP_ORIGIN?: string;
  LLM_MODE?: string;
  /** e.g. `in.mezonas.com`: Cloudflare Email Routing sends it to `email()`. Unset: forwarding is off. */
  EMAIL_FORWARDING_DOMAIN?: string;
  /** Error tracking (src/observability/sentry.ts); set by deploy.yml with `--var`. Not a secret. */
  SENTRY_DSN?: string;
  /** The deployed commit, Sentry's release; set by deploy.yml with `--var`. */
  DEPLOYED_SHA?: string;
}

export type Bindings = Omit<Env, keyof Vars> & Vars & Secrets;
