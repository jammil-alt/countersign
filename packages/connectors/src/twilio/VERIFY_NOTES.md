# Twilio Verify for sign-in codes: what is not checked

`verify.ts` (docs/plan.md §1.83) was written from memory of Twilio's Verify API; Twilio's docs were
not reachable from the build session. Check each against the docs, then with one real sign-in on
staging, before turning the step on in production.

## To verify

- [ ] **Endpoints and fields.** `POST /v2/Services/{VA…}/Verifications` with `To` and `Channel`
      (`sms` or `whatsapp`); `POST …/VerificationCheck` with `To` and `Code`, answering
      `status: "approved"` for a right code and `"pending"` for a wrong one (200 either way), and
      404 when no verification is waiting (expired or already approved).
- [ ] **TOTP factors.** `POST …/Entities/{identity}/Factors` with `FactorType=totp` and
      `FriendlyName` answers the factor's `sid` and `binding.uri` (the `otpauth://` link) and
      `binding.secret`, status `unverified`. `POST …/Factors/{YF…}` with `AuthPayload` (the first
      code) answers `status: "verified"`. `POST …/Entities/{identity}/Challenges` with `FactorSid`
      and `AuthPayload` answers `status: "approved"` for a right code. `DELETE …/Factors/{YF…}`
      answers 204.
- [ ] **What a wrong TOTP code answers**: we read anything but `verified` / `approved` as wrong, and
      a 404 as wrong. If Twilio answers a 4xx instead (e.g. 60xxx), add its code to the wrong-code
      cases in `verify.ts` rather than letting it surface as an error.
- [ ] **The issuer** shown in the authenticator app: we assume it is the Verify service's TOTP
      issuer setting (Console → Verify → the service → TOTP → Issuer). Set it to `Mezonas`
      (staging: `Mezonas staging`).
- [ ] **Identity**: we pass our `app_user.id` (a UUID, no personal data). Twilio's rules for an
      identity (length, characters) are assumed to accept it.
- [ ] **WhatsApp** needs a WhatsApp sender attached to the Verify service; without one, sends on
      that channel fail and the page says so.
- [ ] **Rate limits and fraud guard**: Twilio's own limits apply on top of ours (5 sends and 5 wrong
      codes per person per 15 minutes). Turn on Verify Fraud Guard for SMS.
