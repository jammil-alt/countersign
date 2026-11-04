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
  /** At least 32 bytes: signs the OAuth `state` of a client's sign-in to a tool. */
  OAUTH_STATE_SECRET?: string;
  /** Zoho API console: a Server-based application with multi-DC on (ARCHITECTURE §6.7). */
  ZOHO_CLIENT_ID?: string;
  ZOHO_CLIENT_SECRET?: string;
}

/** Vars are read as plain strings: deployments set values the generated literals don't know. */
export interface Vars {
  ENVIRONMENT?: string;
  AUTH_PROVIDER?: string;
  WORKOS_CLIENT_ID?: string;
  APP_ORIGIN?: string;
  LLM_MODE?: string;
}

export type Bindings = Omit<Env, keyof Vars> & Vars & Secrets;
