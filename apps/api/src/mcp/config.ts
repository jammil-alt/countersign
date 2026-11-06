// Whether the back office's MCP server is on here, and with what (docs/plan.md §1.34). Three
// states, as for WorkOS sign-in (packages/auth's workosStateOf):
//   - off: WORKOS_AUTHKIT_DOMAIN is empty. /mcp and its metadata answer 404.
//   - misconfigured: the domain is set but WorkOS sign-in is not fully on, or a URL is not one.
//     Nothing is accepted; /mcp answers 503.
//   - on: the resource URL, where its metadata lives, the authorization server and the audience.

import { originOf, PROTECTED_RESOURCE_METADATA_PATH, workosStateOf } from "@countersign/auth";
import type { Bindings } from "../env";

export const MCP_PATH = "/mcp";

export interface McpConfig {
  /** The protected resource: `<APP_ORIGIN>/mcp`, what MCP clients connect to. */
  readonly resource: string;
  /** Where the resource's metadata is (RFC 9728), named in every 401. */
  readonly resourceMetadataUrl: string;
  /** The authorization server: this environment's AuthKit domain (its issuer). */
  readonly authorizationServer: string;
  /** What an access token's `aud` must contain. Default the resource URL (RFC 8707). */
  readonly audience: string;
  /** development | staging | production: shown by `whoami` and in the server's instructions. */
  readonly environment: string;
  /** Seals the two-step write tokens (under their own purpose, never as a session). */
  readonly sealPassword: string;
}

export type McpState =
  | { readonly state: "off" }
  | { readonly state: "misconfigured"; readonly problems: readonly string[] }
  | { readonly state: "on"; readonly config: McpConfig };

const read = (v: string | undefined) => (typeof v === "string" ? v.trim() : "");

/** An https origin (http only for localhost), without a path, or null. */
function authServerOrigin(raw: string): string | null {
  const origin = originOf(raw);
  if (!origin) return null;
  const url = new URL(origin);
  if (url.protocol === "https:") return origin;
  return url.hostname === "localhost" || url.hostname === "127.0.0.1" ? origin : null;
}

// DECISION: the MCP server is on where WORKOS_AUTHKIT_DOMAIN is set (a var per environment in
// wrangler.jsonc, e.g. https://<name>.authkit.app), and needs the WorkOS sign-in fully on there:
// its cookie password seals the confirm tokens, and its users are the ones AuthKit signs in.
export function mcpStateOf(env: Bindings): McpState {
  const domain = read(env.WORKOS_AUTHKIT_DOMAIN);
  if (!domain) return { state: "off" };
  const problems: string[] = [];
  const authorizationServer = authServerOrigin(domain);
  if (!authorizationServer) problems.push("WORKOS_AUTHKIT_DOMAIN is not an https origin");
  const workos = workosStateOf(env);
  if (workos.state !== "on") {
    problems.push("the MCP server needs WorkOS sign-in on (WORKOS_CLIENT_ID and its secrets)");
  }
  if (problems.length > 0 || !authorizationServer || workos.state !== "on") {
    return { state: "misconfigured", problems };
  }
  const { appOrigin, cookiePassword } = workos.config;
  const resource = `${appOrigin}${MCP_PATH}`;
  const audience = read(env.MCP_AUDIENCE) || resource;
  return {
    state: "on",
    config: {
      resource,
      resourceMetadataUrl: `${appOrigin}${PROTECTED_RESOURCE_METADATA_PATH}`,
      authorizationServer,
      audience,
      environment: read(env.ENVIRONMENT) || "development",
      sealPassword: cookiePassword,
    },
  };
}
