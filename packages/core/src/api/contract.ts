import { z } from "zod";
import { isPlainObject } from "../json";
import type { Role } from "../roles";

/**
 * The API route contract (docs/plan.md §1.2 "Role checks"): each route's method, path, roles and
 * request/response schemas, shared by the Hono middleware (which enforces roles and validates
 * bodies) and the web app's typed client. Paths are under /api; `:name` marks a path parameter.
 */

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export interface RouteSpec<
  P extends z.ZodType = z.ZodType,
  Q extends z.ZodType = z.ZodType,
  B extends z.ZodType = z.ZodType,
  R extends z.ZodType = z.ZodType,
> {
  method: HttpMethod;
  path: `/api/${string}`;
  /** Who may call it; `public` routes need no session. */
  auth: "public" | "session";
  /** Roles allowed (empty for public routes). */
  roles: readonly Role[];
  summary: string;
  params?: P;
  query?: Q;
  body?: B;
  response: R;
}

export function defineRoute<
  P extends z.ZodType = z.ZodType,
  Q extends z.ZodType = z.ZodType,
  B extends z.ZodType = z.ZodType,
  R extends z.ZodType = z.ZodType,
>(spec: RouteSpec<P, Q, B, R>): RouteSpec<P, Q, B, R> {
  return spec;
}

export type RouteResponse<T extends RouteSpec> = z.infer<T["response"]>;
export type RouteBody<T extends RouteSpec> = T["body"] extends z.ZodType
  ? z.input<T["body"]>
  : never;
export type RouteQuery<T extends RouteSpec> = T["query"] extends z.ZodType
  ? z.input<T["query"]>
  : never;
export type RouteParams<T extends RouteSpec> = T["params"] extends z.ZodType
  ? z.input<T["params"]>
  : never;

/** `/api/ops/*` is the back office; everything else under /api is the portal or shared. */
export function routeFamily(route: Pick<RouteSpec, "path">): "ops" | "portal" {
  return route.path.startsWith("/api/ops/") || route.path === "/api/ops" ? "ops" : "portal";
}

/** Fills `:name` segments. */
export function buildPath(path: string, params: Record<string, string | number> = {}): string {
  return path.replace(/:([A-Za-z_][A-Za-z0-9_]*)/g, (_, name: string) => {
    const v = params[name];
    if (v === undefined) throw new Error(`missing path parameter :${name}`);
    return encodeURIComponent(String(v));
  });
}

/**
 * Field names a portal response may never carry (CLAUDE.md invariant 11): agent bundles,
 * instructions, prompts and cost.
 */
// v0.12 W1-E: model calls (their list, bodies and stop reasons) are the operator's too (§10.10).
export const FORBIDDEN_PORTAL_FIELD =
  /^(bundle|definition|instructions|prompts?|systemPrompt|cost|costUsd|cost_usd|modelCost|tokensIn|tokensOut|tokens_in|tokens_out|modelCalls?|model_calls?|bodyKey|body_key|stopReason|stop_reason|costOver)$/i;

/**
 * Field names no response may carry, on any surface (CLAUDE.md invariant 13: secrets are
 * write-only): stored credentials, wrapped keys, passwords, API keys and tokens. Read models say
 * only whether a secret is set.
 */
// DECISION: the rule is by field name, like FORBIDDEN_PORTAL_FIELD, and the API tests also look for
// a stored secret's value in every response; the webhook setup's `signingSecret` (Mezonas' own
// signing key, shown to the client who pastes it into Zapier) predates it and is left as it is.
export const FORBIDDEN_SECRET_FIELD =
  /^(credentials|credentialsEncrypted|credentials_encrypted|wrappedKey|wrapped_key|password|apiKey|api_key|accessToken|access_token|refreshToken|refresh_token|clientSecret|client_secret|privateKey|private_key|otpauthUri|cookies|sessionCookies|codeHash|code_hash|releaseCode|ein|taxId|tax_id|businessRegistrationNumber|business_registration_number)$/i;

/** Property names anywhere in a schema that match `pattern`. */
function fieldsMatching(schema: z.ZodType, pattern: RegExp): string[] {
  const json = z.toJSONSchema(schema, { io: "output", unrepresentable: "any" });
  const found = new Set<string>();
  const visit = (node: unknown) => {
    if (Array.isArray(node)) {
      for (const n of node) visit(n);
      return;
    }
    if (!isPlainObject(node)) return;
    if (isPlainObject(node.properties)) {
      for (const [k, v] of Object.entries(node.properties)) {
        if (pattern.test(k)) found.add(k);
        visit(v);
      }
    }
    for (const [k, v] of Object.entries(node)) if (k !== "properties") visit(v);
  };
  visit(json);
  return [...found];
}

/** Property names anywhere in a response schema that match FORBIDDEN_SECRET_FIELD. */
export function secretResponseFields(schema: z.ZodType): string[] {
  return fieldsMatching(schema, FORBIDDEN_SECRET_FIELD);
}

/** Property names anywhere in a response schema that match FORBIDDEN_PORTAL_FIELD. */
export function forbiddenPortalFields(schema: z.ZodType): string[] {
  return fieldsMatching(schema, FORBIDDEN_PORTAL_FIELD);
}

/**
 * The contract rules (docs/plan.md §1.2, §1.26): every `/api/ops` route is operator-only, no
 * portal route's response carries bundles, instructions, prompts or cost, and no route's response
 * carries a secret. Returns problems found.
 */
export function checkRouteContract(routes: Record<string, RouteSpec>): string[] {
  const problems: string[] = [];
  for (const [name, r] of Object.entries(routes)) {
    if (routeFamily(r) === "ops") {
      if (r.auth !== "session" || r.roles.length !== 1 || r.roles[0] !== "operator") {
        problems.push(`${name} (${r.method} ${r.path}): /api/ops routes are operator-only`);
      }
    } else {
      const bad = forbiddenPortalFields(r.response);
      if (bad.length > 0) {
        problems.push(`${name} (${r.method} ${r.path}): portal response has ${bad.join(", ")}`);
      }
    }
    const secrets = secretResponseFields(r.response);
    if (secrets.length > 0) {
      problems.push(`${name} (${r.method} ${r.path}): response has ${secrets.join(", ")}`);
    }
    if (r.auth === "public" && r.roles.length > 0) {
      problems.push(`${name}: a public route lists roles`);
    }
    if (r.auth === "session" && r.roles.length === 0) {
      problems.push(`${name}: a session route must list its roles`);
    }
  }
  return problems;
}
