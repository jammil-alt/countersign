// A Twilio Verify for tests (docs/plan.md §1.83), from @countersign/connectors/testing.

import { TwilioError } from "./api";
import type { VerifyChannel, VerifyClient } from "./verify";

/**
 * A Twilio Verify for tests: codes are `123456` unless set with `nextCode`; every send and check is
 * recorded. TOTP codes are accepted when they equal `totpCode`.
 */
export function fakeVerify(opts: { totpCode?: string } = {}) {
  const sent: { to: string; channel: VerifyChannel; locale: string | null }[] = [];
  const pending = new Map<string, string>();
  const factors = new Map<string, { identity: string; verified: boolean }>();
  let nextCode = "123456";
  let n = 0;
  let failSends = false;
  const totp = () => opts.totpCode ?? "654321";
  const client: VerifyClient = {
    async send(to, channel, locale) {
      if (failSends) throw new TwilioError(429, 60203, "Max send attempts reached");
      sent.push({ to, channel, locale });
      pending.set(to, nextCode);
    },
    async check(to, code) {
      const ok = pending.get(to) === code;
      if (ok) pending.delete(to);
      return ok;
    },
    async startTotp(identity, label) {
      n += 1;
      const factorSid = `YF${String(n).padStart(32, "0")}`;
      factors.set(factorSid, { identity, verified: false });
      return {
        factorSid,
        uri: `otpauth://totp/Mezonas:${encodeURIComponent(label)}?secret=JBSWY3DPEHPK3PXP&issuer=Mezonas`,
        secret: "JBSWY3DPEHPK3PXP",
      };
    },
    async confirmTotp(identity, factorSid, code) {
      const f = factors.get(factorSid);
      if (!f || f.identity !== identity || code !== totp()) return false;
      f.verified = true;
      return true;
    },
    async checkTotp(identity, factorSid, code) {
      const f = factors.get(factorSid);
      return !!f && f.identity === identity && f.verified && code === totp();
    },
    async deleteTotp(_identity, factorSid) {
      factors.delete(factorSid);
    },
  };
  return {
    client,
    sent,
    factors,
    setNextCode(code: string) {
      nextCode = code;
    },
    failSends(on: boolean) {
      failSends = on;
    },
  };
}
