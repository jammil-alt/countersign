# Twilio Verify: what we rely on, and what's checked

The second step of signing in (`docs/plan.md` §1.83) uses Twilio Verify on Mezonas' own Twilio
account (`TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_VERIFY_SERVICE_SID`). Twilio's docs
site wasn't reachable from the build environment; the rows marked UNCHECKED come from Twilio's
search results and should be confirmed against the live API (or the docs) before the first sign-in
in production. `verify.test.ts` pins what we send.

| What | Status |
|---|---|
| `POST https://verify.twilio.com/v2/Services/{VA…}/Verifications` with `To` (E.164), `Channel` (`sms` or `whatsapp`) and optional `Locale` sends a code; a new verification's `status` is `pending` | Checked in search results (Twilio Verify API, Verifications) |
| `POST …/Services/{VA…}/VerificationCheck` with `To` and `Code`; the answer's `status` is `approved` for the right code, otherwise `pending`, `canceled`, `max_attempts_reached`, `expired` and so on | Checked in search results (Verification Check) |
| A check with no pending verification (expired, already approved, too many tries) answers HTTP 404 | UNCHECKED. We treat 404 as a wrong code |
| WhatsApp codes need our own WhatsApp sender on the Verify service (Meta-approved brand and number) since 1 March 2024 | Checked in search results (Verify WhatsApp overview) |
| `POST …/Services/{VA…}/Entities/{identity}/Factors` with `FactorType=totp` and `FriendlyName` creates an unverified factor whose `binding` has `secret` and an `otpauth://` `uri` | Checked in search results (Factor resource, TOTP quickstart); exact field casing UNCHECKED |
| `POST …/Entities/{identity}/Factors/{YF…}` with `AuthPayload` (the first code) answers `status: verified` when right | Checked in search results; UNCHECKED whether a wrong code answers 200 with `unverified` or an error (both are handled as a no) |
| `POST …/Entities/{identity}/Challenges` with `FactorSid` and `AuthPayload` answers `status: approved` when right; since 27 Oct 2021 a wrong code is reported in the status, not as an error | Checked in search results (Challenge resource, TOTP change notice) |
| `identity` may be our app_user id (a UUID) | UNCHECKED. Twilio asks for a non-PII, unique identifier; a UUID is both |
| `DELETE …/Entities/{identity}/Factors/{YF…}` removes a factor | UNCHECKED |
| Verify's own rate limits and fraud guard (Fraud Guard for SMS) | On by default on a Verify service; check the service's settings |
| Prices per verification | UNCHECKED. See Twilio's Verify pricing |
