// `Codes`: the code service's RPC, a WorkerEntrypoint reached only through apps/api's `CODES`
// service binding (core's `CodesService`). Every call is parsed with core's schemas, names the
// client, and is refused (`not_found`) for an identity of another client.

import { WorkerEntrypoint } from "cloudflare:workers";
import {
  type AddPhoneInput,
  type AlertsInput,
  type AlertsResult,
  type AuthenticatorView,
  type ClaimInput,
  type ClaimResult,
  type CodeAlert,
  CodesInputs,
  type CodesMailbox,
  type CodesResponse,
  type CodesService,
  type CreateIdentityInput,
  type DeleteIdentityInput,
  type DeleteIdentityResult,
  type IdentityInput,
  type IdentityView,
  type OpenWaitInput,
  type OpenWaitResult,
  type SetAuthenticatorInput,
} from "@countersign/core";
import type { z } from "zod";
import { newIdentityId } from "./crypto";
import { agentAddress, MAX_EMAIL_BYTES } from "./email";
import type { CodesEnv } from "./env";
import { handleEmail } from "./inbox";
import { logEvent } from "./log";
import { buyNumber, releaseNumber, type TwilioAccount, TwilioError } from "./twilio";

type Failure = Extract<CodesResponse<never>, { ok: false }>;
const fail = (code: Failure["error"]["code"], message: string): Failure => ({
  ok: false,
  error: { code, message },
});

function parse<S extends z.ZodType>(
  schema: S,
  input: unknown,
): { ok: true; value: z.output<S> } | Failure {
  const r = schema.safeParse(input);
  if (r.success) return { ok: true, value: r.data };
  const first = r.error.issues[0];
  return fail(
    "invalid",
    first ? `${first.path.join(".") || "input"}: ${first.message}` : "invalid",
  );
}

export class Codes extends WorkerEntrypoint<CodesEnv> implements CodesService, CodesMailbox {
  private identityStub(identityId: string) {
    return this.env.IDENTITY.get(this.env.IDENTITY.idFromName(identityId));
  }

  private directory(tenantId: string) {
    return this.env.DIRECTORY.get(this.env.DIRECTORY.idFromName(tenantId));
  }

  private twilio(): TwilioAccount | null {
    const accountSid = this.env.MFA_TWILIO_ACCOUNT_SID;
    const authToken = this.env.MFA_TWILIO_AUTH_TOKEN;
    return accountSid && authToken ? { accountSid, authToken } : null;
  }

  /** Twilio's REST API, called through the global fetch at call time (tests replace it). */
  private readonly fetcher: typeof fetch = (input, init) => fetch(input, init);

  /** Mail for the agent domain, passed on by apps/api's `email()` (core's `CodesMailbox`). */
  async receiveEmail(input: { to: string; raw: Uint8Array }): Promise<{ outcome: string }> {
    const to = typeof input?.to === "string" ? input.to : "";
    const raw = input?.raw instanceof Uint8Array ? input.raw : new Uint8Array(0);
    if (raw.length > MAX_EMAIL_BYTES) return { outcome: "too_large" };
    const outcome = await handleEmail(
      { to, rawSize: raw.length, raw: new Response(raw).body as ReadableStream<Uint8Array> },
      this.env,
    );
    return { outcome };
  }

  async createIdentity(input: CreateIdentityInput): Promise<CodesResponse<IdentityView>> {
    const p = parse(CodesInputs.createIdentity, input);
    if (!p.ok) return p;
    const domain = this.env.AGENT_EMAIL_DOMAIN?.trim();
    if (!domain) return fail("not_configured", "AGENT_EMAIL_DOMAIN is not set");
    // A new id that is somehow taken answers `conflict`: try another.
    for (let attempt = 0; attempt < 3; attempt++) {
      const id = newIdentityId();
      const made = await this.identityStub(id).init({
        id,
        tenantId: p.value.tenantId,
        label: p.value.label,
        email: agentAddress(id, domain),
      });
      if (!made.ok && made.error.code === "conflict") continue;
      if (made.ok) await this.directory(p.value.tenantId).add(id);
      return made;
    }
    return fail("conflict", "could not choose a new identity id");
  }

  async identity(input: IdentityInput): Promise<CodesResponse<IdentityView>> {
    const p = parse(CodesInputs.identity, input);
    if (!p.ok) return p;
    return this.identityStub(p.value.identityId).get({ tenantId: p.value.tenantId });
  }

  async addPhone(input: AddPhoneInput): Promise<CodesResponse<IdentityView>> {
    const p = parse(CodesInputs.addPhone, input);
    if (!p.ok) return p;
    const { tenantId, identityId, areaCode } = p.value;
    const account = this.twilio();
    const origin = this.env.MFA_ORIGIN?.replace(/\/+$/, "");
    if (!account || !origin) {
      return fail("not_configured", "the codes Twilio subaccount is not set up");
    }
    const stub = this.identityStub(identityId);
    const may = await stub.canAddPhone({ tenantId });
    if (!may.ok) return may;
    let bought: Awaited<ReturnType<typeof buyNumber>>;
    try {
      bought = await buyNumber(this.fetcher, account, {
        areaCode,
        smsUrl: `${origin}/twilio/sms/${identityId}`,
        friendlyName: `mezonas-codes ${identityId}`,
      });
    } catch (error) {
      if (error instanceof TwilioError) {
        logEvent("phone.failed", { identityId, tenantId, status: error.status });
        return fail("unavailable", error.message);
      }
      throw error;
    }
    const set = await stub.setPhone({ tenantId, phone: bought.phoneNumber, sid: bought.sid });
    if (!set.ok) {
      // Lost a race with another addPhone: give the second number back.
      await releaseNumber(this.fetcher, account, bought.sid).catch(() => undefined);
    }
    return set;
  }

  async setAuthenticator(input: SetAuthenticatorInput): Promise<CodesResponse<AuthenticatorView>> {
    const p = parse(CodesInputs.setAuthenticator, input);
    if (!p.ok) return p;
    const { identityId, ...rest } = p.value;
    return this.identityStub(identityId).setAuthenticator(rest);
  }

  async openWait(input: OpenWaitInput): Promise<CodesResponse<OpenWaitResult>> {
    const p = parse(CodesInputs.openWait, input);
    if (!p.ok) return p;
    const { identityId, ...rest } = p.value;
    return this.identityStub(identityId).openWait(rest);
  }

  async claim(input: ClaimInput): Promise<CodesResponse<ClaimResult>> {
    const p = parse(CodesInputs.claim, input);
    if (!p.ok) return p;
    return this.identityStub(p.value.identityId).claim({
      tenantId: p.value.tenantId,
      waitId: p.value.waitId,
    });
  }

  async alerts(input: AlertsInput): Promise<CodesResponse<AlertsResult>> {
    const p = parse(CodesInputs.alerts, input);
    if (!p.ok) return p;
    const { tenantId, since, limit } = p.value;
    const ids = await this.directory(tenantId).list();
    const all: CodeAlert[] = [];
    for (const id of ids) {
      const got = await this.identityStub(id).alerts({ tenantId, since, limit });
      if (got.ok) all.push(...got.value.alerts);
    }
    all.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
    return { ok: true, value: { alerts: all.slice(0, limit) } };
  }

  async deleteIdentity(input: DeleteIdentityInput): Promise<CodesResponse<DeleteIdentityResult>> {
    const p = parse(CodesInputs.deleteIdentity, input);
    if (!p.ok) return p;
    const { tenantId, identityId } = p.value;
    const gone = await this.identityStub(identityId).destroy({ tenantId });
    if (!gone.ok) return gone;
    await this.directory(tenantId).remove(identityId);
    let phoneReleased = false;
    const account = this.twilio();
    if (gone.value.phoneSid && account) {
      try {
        await releaseNumber(this.fetcher, account, gone.value.phoneSid);
        phoneReleased = true;
      } catch (error) {
        // The identity is gone either way; the number is left for the operator to release.
        logEvent("phone.release_failed", {
          identityId,
          tenantId,
          status: error instanceof TwilioError ? error.status : null,
        });
      }
    }
    return { ok: true, value: { deleted: true, phoneReleased } };
  }
}
