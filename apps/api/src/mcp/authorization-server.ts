// The MCP server's authorization server: this environment's WorkOS AuthKit, found by OAuth
// discovery (RFC 8414) from WORKOS_AUTHKIT_DOMAIN. Its metadata names the issuer and the JWKS that
// sign access tokens; jose fetches and caches the keys (and refetches on an unknown key id).
//
// Discovery, rather than hard-coded AuthKit paths, so the only thing configured is the domain and
// whatever AuthKit publishes is what is checked. Cached per isolate for an hour; a failure is not
// cached, so the next request tries again.

import { trimTrailingSlashes } from "@countersign/core";
import { createRemoteJWKSet, type JWTVerifyGetKey } from "jose";

export interface DiscoveredServer {
  /** RFC 8414 metadata as AuthKit publishes it (served again at our origin for older clients). */
  readonly metadata: Readonly<Record<string, unknown>> & { readonly issuer: string };
  readonly keys: JWTVerifyGetKey;
}

export interface AuthorizationServer {
  discover(): Promise<DiscoveredServer>;
}

export class DiscoveryError extends Error {
  override name = "DiscoveryError";
}

const CACHE_MS = 60 * 60 * 1000;
const cache = new Map<string, { at: number; server: Promise<DiscoveredServer> }>();

const httpsUrl = (value: unknown): URL | null => {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.hostname === "localhost" ? url : null;
  } catch {
    return null;
  }
};

async function fetchMetadata(origin: string, doFetch: typeof fetch): Promise<DiscoveredServer> {
  const url = `${origin}/.well-known/oauth-authorization-server`;
  let response: Response;
  try {
    response = await doFetch(url, { headers: { accept: "application/json" } });
  } catch {
    throw new DiscoveryError("the authorization server could not be reached");
  }
  if (!response.ok) {
    throw new DiscoveryError(`the authorization server answered ${response.status}`);
  }
  let body: Record<string, unknown>;
  try {
    body = (await response.json()) as Record<string, unknown>;
  } catch {
    throw new DiscoveryError("the authorization server's metadata is not JSON");
  }
  // RFC 8414 §3.3: the issuer must be the URL the metadata was found under.
  const issuer = typeof body.issuer === "string" ? trimTrailingSlashes(body.issuer) : "";
  if (issuer !== origin) throw new DiscoveryError("the metadata names another issuer");
  const jwks = httpsUrl(body.jwks_uri);
  if (!jwks) throw new DiscoveryError("the metadata has no jwks_uri");
  return {
    metadata: { ...body, issuer: body.issuer as string },
    keys: createRemoteJWKSet(jwks),
  };
}

/** AuthKit at `origin` (an https origin, e.g. `https://mezonas-staging.authkit.app`). */
export function authKitServer(
  origin: string,
  doFetch: typeof fetch = (input, init) => fetch(input, init),
): AuthorizationServer {
  return {
    discover() {
      const now = Date.now();
      const hit = cache.get(origin);
      if (hit && now - hit.at < CACHE_MS) return hit.server;
      const server = fetchMetadata(origin, doFetch);
      cache.set(origin, { at: now, server });
      server.catch(() => {
        if (cache.get(origin)?.server === server) cache.delete(origin);
      });
      return server;
    },
  };
}
