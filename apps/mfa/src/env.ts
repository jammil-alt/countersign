// The code service's environment: the bindings and vars in wrangler.jsonc (the generated `Env`) plus
// its own secrets, which never appear in wrangler.jsonc. None of apps/api's secrets are here.

export interface Secrets {
  /** 32 bytes, base64: seals authenticator secrets and held codes. Generated once by deploy.yml. */
  MFA_ENCRYPTION_KEY?: string;
  /** The codes Twilio subaccount: buys identities' numbers; its token signs inbound texts. */
  MFA_TWILIO_ACCOUNT_SID?: string;
  MFA_TWILIO_AUTH_TOKEN?: string;
}

/** Vars are read as plain strings: deployments set values the generated literals don't know. */
export interface Vars {
  ENVIRONMENT?: string;
  /** Agent addresses are `agent-<identity id>@AGENT_EMAIL_DOMAIN`. */
  AGENT_EMAIL_DOMAIN?: string;
  /** The public origin Twilio calls (e.g. https://codes.mezonas.com). */
  MFA_ORIGIN?: string;
  /** Code requests per identity per UTC day (default 20). */
  MFA_DAILY_CAP?: string;
  /**
   * `on` lets emailed codes fill waits. Anything else (the default, `off`) keeps email to alerts
   * only, until Cloudflare's authentication headers are verified (NOTES.md, "Turning email codes
   * on").
   */
  EMAIL_CODES?: string;
}

export type CodesEnv = Omit<Env, keyof Vars> & Vars & Secrets;

/** Whether emailed codes may fill waits: only when EMAIL_CODES is exactly `on`. */
export function emailCodesOn(env: Pick<Vars, "EMAIL_CODES">): boolean {
  return env.EMAIL_CODES?.trim().toLowerCase() === "on";
}
