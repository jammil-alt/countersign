// Two-step writes (docs/plan.md §1.34): the first call to a write tool only shows what it would do
// and hands back a confirm token; the second call, with the same arguments and that token, does it.
//
// The token is sealed (AES-GCM, packages/auth's seal under its own purpose `mcp-confirm`, keyed
// from the environment's WORKOS_COOKIE_PASSWORD), so it cannot be read, forged or carried to
// another environment. It is bound to the operator, the tool and a hash of the arguments, lasts
// five minutes, and works once: its nonce is claimed in object storage before the write, and the
// write itself only changes a row still in the state the preview showed.

import { seal, unseal } from "@countersign/auth";
import type { ObjectStore } from "@countersign/connectors";
import { canonicalJson, sha256Hex } from "@countersign/core";
import { z } from "zod";

export const CONFIRM_TTL_SEC = 5 * 60;
export const CONFIRM_ARG = "confirm_token";

const Claims = z.object({
  v: z.literal(1),
  /** app_user.id */
  u: z.string(),
  /** The tool. */
  t: z.string(),
  /** sha256 of the arguments' canonical JSON, without the token. */
  h: z.string(),
  n: z.string().min(16),
  exp: z.int(),
});

export type ConfirmCheck =
  | { ok: true; nonce: string }
  | { ok: false; reason: "invalid" | "expired" | "mismatch" | "used" };

/** The arguments a token is bound to: everything but the token itself. */
async function argsHash(args: Record<string, unknown>): Promise<string> {
  const { [CONFIRM_ARG]: _token, ...rest } = args;
  return sha256Hex(canonicalJson(rest));
}

export async function issueConfirmToken(input: {
  password: string;
  userId: string;
  tool: string;
  args: Record<string, unknown>;
  now: Date;
}): Promise<{ token: string; expiresAt: Date }> {
  const exp = Math.floor(input.now.getTime() / 1000) + CONFIRM_TTL_SEC;
  const nonce = crypto.randomUUID().replace(/-/g, "");
  const token = await seal(
    { v: 1, u: input.userId, t: input.tool, h: await argsHash(input.args), n: nonce, exp },
    input.password,
    "mcp-confirm",
  );
  return { token, expiresAt: new Date(exp * 1000) };
}

export async function checkConfirmToken(input: {
  token: string;
  password: string;
  userId: string;
  tool: string;
  args: Record<string, unknown>;
  now: Date;
}): Promise<ConfirmCheck> {
  const claims = Claims.safeParse(await unseal(input.token, input.password, "mcp-confirm"));
  if (!claims.success) return { ok: false, reason: "invalid" };
  const c = claims.data;
  if (Math.floor(input.now.getTime() / 1000) >= c.exp) return { ok: false, reason: "expired" };
  if (c.u !== input.userId || c.t !== input.tool || c.h !== (await argsHash(input.args))) {
    return { ok: false, reason: "mismatch" };
  }
  return { ok: true, nonce: c.n };
}

/** Where a used token's nonce is recorded: the operator's own prefix, never a client's. */
export const usedTokenKey = (nonce: string) => `operator/mcp/confirm/${nonce}`;

/**
 * Claims a token's nonce: true the first time, false when it was used before.
 */
// DECISION: used nonces are marked in the Worker's object storage (a few bytes per write, under
// `operator/mcp/confirm/`) rather than in a new table: no migration, and every isolate sees them.
// R2's "only if absent" is a head then a put, so two simultaneous confirms could both pass this;
// the write behind it changes only a row still open, so the second still fails.
export async function claimNonce(objects: ObjectStore, nonce: string, at: Date): Promise<boolean> {
  const written = await objects.put(
    usedTokenKey(nonce),
    new TextEncoder().encode(at.toISOString()),
    {
      contentType: "text/plain",
      onlyIfAbsent: true,
    },
  );
  return written !== null;
}
