// Connects a tool: the provider's own sign-in, Meta's signup page or Plaid Link. The connector's
// page (and through it Getting started and the agent's page) is the one place that starts it.
import type { ApiClient } from "../../api/client";
import { apiRoutes } from "../../api/routes";
import { openPlaidLink } from "../../connections/plaidLink";
import { PORTAL_PATHS } from "../paths";
import { WHATSAPP_META_SIGNUP_PATH } from "../screens/WhatsappMetaSignup";

const FOR_KEY = "mezonas.connect-for";

/**
 * Keeps which agent a sign-in was started for, so the provider's way back lands on the connector's
 * page with that agent picked (`?for=`). Kept in this tab only; nothing breaks without it.
 */
// DECISION (C5): the agent rides in sessionStorage, not in the provider's `state` (the API owns
// that); a sign-in that comes back to another tab lands on the page without an agent picked.
function rememberFor(connector: string, agentId: string | null | undefined) {
  try {
    if (agentId) sessionStorage.setItem(FOR_KEY, JSON.stringify({ connector, agentId }));
    else sessionStorage.removeItem(FOR_KEY);
  } catch {
    // No storage: the page opens without an agent picked.
  }
}

/** Where a finished sign-in for `connector` goes: its page, with the agent it was for. */
export function afterConnectPath(connector: string): string {
  let agentId: string | null = null;
  try {
    const raw = sessionStorage.getItem(FOR_KEY);
    const kept = raw ? (JSON.parse(raw) as { connector?: unknown; agentId?: unknown }) : null;
    if (kept?.connector === connector && typeof kept.agentId === "string") agentId = kept.agentId;
    sessionStorage.removeItem(FOR_KEY);
  } catch {
    // As if nothing was kept.
  }
  return connector ? PORTAL_PATHS.connector(connector, agentId) : PORTAL_PATHS.connectors;
}

export async function startConnect(
  api: ApiClient,
  connector: string,
  forAgent?: string | null,
): Promise<void> {
  rememberFor(connector, forAgent);
  // v0.14 W4-A: Meta's Embedded Signup runs on a page of its own (Meta's SDK is allowed only
  // there), loaded as a document.
  if (connector === "whatsapp_meta") {
    window.location.assign(WHATSAPP_META_SIGNUP_PATH);
    return;
  }
  const res = await api.call(apiRoutes.portalAuthorize, { params: { connector } });
  // An OAuth connector answers where the provider's sign-in starts.
  if (res.redirectUrl) window.location.assign(res.redirectUrl);
  // v0.12 bankfeed: Plaid Link opens here; its result goes to the callback.
  if (res.link?.provider === "plaid") {
    const done = await openPlaidLink(res.link);
    if (done) {
      await api.call(apiRoutes.portalAuthorizeCallback, {
        params: { connector },
        body: { params: { public_token: done.publicToken, state: done.state } },
      });
    }
  }
}
