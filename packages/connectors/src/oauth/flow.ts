import type {
  ConnectionContext,
  ConnectionGrant,
  Connector,
  LinkRequest,
  LinkStart,
} from "../connector";
import type { CredentialBinding, CredentialEnvelope, CredentialSealer } from "../credentials";
import {
  createOAuthState,
  type OAuthOrigin,
  type OAuthStateFailure,
  verifyOAuthState,
} from "./state";

/**
 * The platform half of "the client admin signs in to their tool" (plan §1.2 "Connectors in the
 * portal"). apps/api calls `beginAuthorization` from `POST /api/connections/:connector/authorize`
 * and `completeAuthorization` from the provider's callback, both in the client user's session.
 * The operator reaches them only for the Sandbox client, their own test client (origin `ops`,
 * `POST /api/ops/clients/:id/connections/:connector/authorize`); never for a real client.
 */
export async function beginAuthorization(input: {
  connector: Connector;
  tenantId: string;
  userId: string;
  redirectUri: string;
  stateSecret: string | Uint8Array;
  /** Where the sign-in started (default the portal); bound into the state. */
  origin?: OAuthOrigin;
  now?: Date;
}): Promise<{ redirectUrl: string; state: string }> {
  const { connector } = input;
  if (connector.manifest.auth !== "oauth2" || !connector.authorize) {
    throw new Error(`connector ${connector.manifest.id} does not sign in with OAuth`);
  }
  const { state } = await createOAuthState(
    {
      tenantId: input.tenantId,
      connector: connector.manifest.id,
      userId: input.userId,
      ...(input.origin ? { origin: input.origin } : {}),
    },
    { secret: input.stateSecret, ...(input.now ? { now: input.now } : {}) },
  );
  const { redirectUrl } = await connector.authorize({
    tenantId: input.tenantId,
    userId: input.userId,
    state,
    redirectUri: input.redirectUri,
  });
  return { redirectUrl, state };
}

/**
 * v0.12 bankfeed: the start of a hosted link widget's sign-in (Plaid Link, docs/plan.md §1.52). As
 * `beginAuthorization`, with a state bound to the client, connector, user and origin; the connector
 * answers a token the portal opens the widget with instead of a URL to go to. The state comes
 * back with the widget's result through `completeAuthorization`, unchanged.
 */
export async function beginLinkAuthorization(input: {
  connector: Connector;
  tenantId: string;
  userId: string;
  redirectUri: string;
  webhookUrl: string;
  stateSecret: string | Uint8Array;
  language?: string;
  /** The connection being signed in again, when it still holds credentials (update mode). */
  reconnect?: LinkRequest["reconnect"];
  origin?: OAuthOrigin;
  now?: Date;
}): Promise<{ link: LinkStart; state: string }> {
  const { connector } = input;
  if (connector.manifest.auth !== "oauth2" || !connector.beginLink) {
    throw new Error(`connector ${connector.manifest.id} does not sign in with a link widget`);
  }
  const { state } = await createOAuthState(
    {
      tenantId: input.tenantId,
      connector: connector.manifest.id,
      userId: input.userId,
      ...(input.origin ? { origin: input.origin } : {}),
    },
    { secret: input.stateSecret, ...(input.now ? { now: input.now } : {}) },
  );
  const link = await connector.beginLink({
    tenantId: input.tenantId,
    userId: input.userId,
    redirectUri: input.redirectUri,
    webhookUrl: input.webhookUrl,
    ...(input.language ? { language: input.language } : {}),
    ...(input.reconnect ? { reconnect: input.reconnect } : {}),
  });
  return { link, state };
}

export class OAuthCallbackError extends Error {
  constructor(
    readonly reason: OAuthStateFailure | "missing_state" | "provider_error",
    message: string,
  ) {
    super(message);
    this.name = "OAuthCallbackError";
  }
}

/**
 * Verifies the callback's state against the session (client, connector, user, origin), lets the connector
 * exchange the code, and encrypts the credentials for the connection they will be stored on. The
 * caller writes the row (status `connected`, `connected_by` = the user) and a `connection_change`.
 */
export async function completeAuthorization(input: {
  connector: Connector;
  params: Record<string, string>;
  session: { tenantId: string; userId: string };
  /** The connection the credentials will be stored on (new: a fresh uuid v7). */
  connectionId: string;
  redirectUri: string;
  stateSecret: string | Uint8Array;
  /** Encrypts under the client's own key (envelope v2). */
  cipher: CredentialSealer;
  /** Where the sign-in must have started (default the portal). */
  origin?: OAuthOrigin;
  now?: Date;
  /** v0.12 bankfeed: the connection signed in again, when it still holds credentials. */
  existing?: ConnectionContext;
  /** v0.14 W4-A: whether another client has this account connected (CallbackRequest). */
  accountTaken?: (externalAccountId: string) => Promise<boolean>;
}): Promise<{ grant: Omit<ConnectionGrant, "credentials">; credentials: CredentialEnvelope }> {
  const { connector, params } = input;
  if (!connector.handleCallback) {
    throw new Error(`connector ${connector.manifest.id} does not sign in with OAuth`);
  }
  if (params.error) {
    throw new OAuthCallbackError("provider_error", `the provider refused: ${params.error}`);
  }
  if (!params.state) throw new OAuthCallbackError("missing_state", "the callback has no state");
  const verified = await verifyOAuthState(
    params.state,
    {
      ...input.session,
      connector: connector.manifest.id,
      ...(input.origin ? { origin: input.origin } : {}),
    },
    { secret: input.stateSecret, ...(input.now ? { now: input.now } : {}) },
  );
  if (!verified.ok) {
    throw new OAuthCallbackError(verified.reason, `invalid OAuth state: ${verified.reason}`);
  }
  const grant = await connector.handleCallback(params, {
    ...input.session,
    redirectUri: input.redirectUri,
    ...(input.existing ? { existing: input.existing } : {}),
    ...(input.accountTaken ? { accountTaken: input.accountTaken } : {}),
  });
  const binding: CredentialBinding = {
    tenantId: input.session.tenantId,
    connectionId: input.connectionId,
  };
  const { credentials, ...rest } = grant;
  return { grant: rest, credentials: await input.cipher.encrypt(credentials, binding) };
}
