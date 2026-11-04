// The Worker's environment: the bindings and vars wrangler.jsonc declares (the generated `Env`),
// plus the secrets, which never appear in wrangler.jsonc and so are not in the generated type.

export interface Secrets {
  WORKOS_API_KEY?: string;
  WORKOS_COOKIE_PASSWORD?: string;
  ANTHROPIC_API_KEY?: string;
  /** Loaded by deploy.yml; used once packages/llm has its OpenAI adapter. */
  OPENAI_API_KEY?: string;
  /** 32 bytes, base64: connection credentials at rest (ARCHITECTURE §17). */
  ENCRYPTION_KEY?: string;
  ENCRYPTION_KEY_PREVIOUS?: string;
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
}

export type Bindings = Omit<Env, keyof Vars> & Vars & Secrets;
