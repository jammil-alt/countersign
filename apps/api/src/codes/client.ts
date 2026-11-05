// The code service (apps/mfa, Worker `mezonas-codes`) as apps/api calls it: through the optional
// `CODES` service binding only (ARCHITECTURE §6.9; docs/plan.md §1.26). Answers are checked with
// core's schemas (invariant 5) and failures become a `CodesServiceError` with the service's code.
// Without the binding (local development, or before the deploy wires it) the code service is off.

import {
  type AddPhoneInput,
  type AlertsInput,
  type ClaimInput,
  type CodesErrorCode,
  CodesResponses,
  type CodesService,
  type CreateIdentityInput,
  type DeleteIdentityInput,
  type IdentityInput,
  type OpenWaitInput,
  type SetAuthenticatorInput,
} from "@countersign/core";
import type { z } from "zod";
import type { Bindings } from "../env";

export class CodesServiceError extends Error {
  constructor(
    readonly code: CodesErrorCode | "bad_response",
    message: string,
  ) {
    super(message);
    this.name = "CodesServiceError";
  }
}

type Method = keyof CodesService;
type Value<M extends Method> = Extract<z.output<(typeof CodesResponses)[M]>, { ok: true }>["value"];

async function unwrap<M extends Method>(method: M, answer: Promise<unknown>): Promise<Value<M>> {
  const parsed = CodesResponses[method].safeParse(await answer);
  if (!parsed.success) {
    throw new CodesServiceError("bad_response", `code service: unexpected answer to ${method}`);
  }
  const r = parsed.data;
  if (!r.ok) throw new CodesServiceError(r.error.code, r.error.message);
  return r.value as Value<M>;
}

/** Typed calls to the code service; each answers its value or throws `CodesServiceError`. */
export function codesClient(binding: CodesService) {
  return {
    createIdentity: (input: CreateIdentityInput) =>
      unwrap("createIdentity", binding.createIdentity(input)),
    identity: (input: IdentityInput) => unwrap("identity", binding.identity(input)),
    addPhone: (input: AddPhoneInput) => unwrap("addPhone", binding.addPhone(input)),
    setAuthenticator: (input: SetAuthenticatorInput) =>
      unwrap("setAuthenticator", binding.setAuthenticator(input)),
    openWait: (input: OpenWaitInput) => unwrap("openWait", binding.openWait(input)),
    claim: (input: ClaimInput) => unwrap("claim", binding.claim(input)),
    alerts: (input: AlertsInput) => unwrap("alerts", binding.alerts(input)),
    deleteIdentity: (input: DeleteIdentityInput) =>
      unwrap("deleteIdentity", binding.deleteIdentity(input)),
  };
}

export type CodesClient = ReturnType<typeof codesClient>;

/** The code service, or null where the `CODES` binding is not configured. */
export function codesFor(env: Pick<Bindings, "CODES">): CodesClient | null {
  return env.CODES ? codesClient(env.CODES) : null;
}
