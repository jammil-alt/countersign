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
}

/** Vars are read as plain strings: deployments set values the generated literals don't know. */
export interface Vars {
  ENVIRONMENT?: string;
  AUTH_PROVIDER?: string;
  WORKOS_CLIENT_ID?: string;
  APP_ORIGIN?: string;
  LLM_MODE?: string;
  /** Error tracking (src/observability/sentry.ts); set by deploy.yml with `--var`. Not a secret. */
  SENTRY_DSN?: string;
  /** The deployed commit, Sentry's release; set by deploy.yml with `--var`. */
  DEPLOYED_SHA?: string;
}

export type Bindings = Omit<Env, keyof Vars> & Vars & Secrets;
