// The welcome link (docs/cases-plan.md §4.4; docs/plan.md §1.125): `app.mezonas.com/start/<token>`,
// a signed link over the client, the intake, the person and the expiry (core `WelcomeLinkToken`),
// seen without sign-in. Signed like the form link (../forms/link.ts) under its own label
// (`mezonas-welcome-link`), so no other link opens it and it opens nothing else. Never a way in on
// its own: after sign-in the address must be the invited one.
//
// Stream EMAIL builds these (cases-plan O1); until then they throw.

import type { WelcomeLinkToken } from "@countersign/core";
import type { Bindings } from "../env";
import { notBuilt } from "./not-built";

export type WelcomeLinkEnv = Pick<Bindings, "ENCRYPTION_KEY" | "ENVIRONMENT">;

/** The token for a person's welcome page (`welcomePagePath(token)` in core). */
// Stream EMAIL builds this.
export async function signWelcomeLink(
  _env: WelcomeLinkEnv,
  _payload: WelcomeLinkToken,
): Promise<string> {
  throw notBuilt("EMAIL", "signWelcomeLink");
}

/**
 * The link's payload, or null when forged or malformed. An expired link still reads (the page
 * offers "Ask <lead> for a new one"); `expired` says so.
 */
// Stream EMAIL builds this.
export async function verifyWelcomeLink(
  _env: WelcomeLinkEnv,
  _token: string,
  _now?: number,
): Promise<{ payload: WelcomeLinkToken; expired: boolean } | null> {
  throw notBuilt("EMAIL", "verifyWelcomeLink");
}
