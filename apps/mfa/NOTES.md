# The code service: notes to verify

Written 2026-11-05. Neither Cloudflare's nor Twilio's documentation could be reached from the build
environment, and there were no Cloudflare or Twilio credentials. The tests run the real Worker,
Durable Objects and email parsing inside workerd, but the email headers and Twilio's REST answers in
them are written by us. **A wrong assumption below is a wrong assumption in the tests too.** Check
each item before the first real identity is set up.

## To verify

### Cloudflare Email Routing → `email()`

| Assumption | Where it matters |
|---|---|
| Email Routing can route a whole subdomain (`agents.mezonas.com`, `agents.staging.mezonas.com`) to a Worker with a catch-all rule, and the Worker sees the original recipient in `message.to`. | `handleEmail` reads the identity from `message.to` (`agent-<id>@<domain>`). |
| Cloudflare adds its authentication verdicts as a header **above** every header the sender wrote, before the Worker sees `message.raw`. The topmost `Authentication-Results` or `ARC-Authentication-Results` header is Cloudflare's. | `readAuthentication` reads only the topmost of those two headers. If Cloudflare adds neither, the topmost one could be the sender's own (forged): every message would then need to fail, which is what happens unless the forged header also uses Cloudflare's authserv-id. Confirm with a real message. |
| That header's authserv-id is `mx.cloudflare.net` (the same assumption as apps/api's forwarding, `packages/connectors/src/upload/forwarding.ts`). | `TRUSTED_AUTHSERV_ID` in `src/email.ts`. Any other id means "not authenticated". |
| The header carries `spf=pass`, `dkim=pass` and `dmarc=pass … header.from=<domain>` in RFC 8601 form; `ARC-Authentication-Results` starts with `i=<n>;`. | All three must pass, and DMARC's `header.from` must be the From address's domain. |
| Email Routing hands messages up to 25 MiB to a Worker (`rawSize`). | Larger messages are dropped unread. |
| Dropping a message (not calling `setReject` or `forward`) is silent for the sender. | We never bounce: a bounce would tell a guesser which addresses exist. |

### Twilio (the codes subaccount)

The REST facts are the ones in `packages/connectors/src/twilio/NOTES.md` (search, buy, release a
number; Basic auth; form bodies), all UNCHECKED there too. In addition:

| Assumption | Where it matters |
|---|---|
| Inbound texts are POSTed to the number's `SmsUrl` with `AccountSid`, `From`, `To` and `Body`, signed with `X-Twilio-Signature` over the exact `SmsUrl` and the sorted parameters, using the **subaccount's** auth token. | `POST /twilio/sms/:identityId` checks the signature over `MFA_ORIGIN` + path with `MFA_TWILIO_AUTH_TOKEN`, and that `AccountSid` is `MFA_TWILIO_ACCOUNT_SID`. The algorithm itself reproduces Twilio's documented example (`twilio.test.ts`). |
| `From` for a short code is its digits (`22395`), and for a long code is E.164. | A wait's `sender` is compared with `From` after removing spaces and punctuation, so the site's sender must be written the way Twilio reports it. |
| A US local number can receive texts from short codes without A2P 10DLC registration (registration is for sending). | Identities only receive. |
| Releasing a number is `DELETE /IncomingPhoneNumbers/{PN}.json`; a 404 means it is already gone. | `deleteIdentity` releases the number and reports `phoneReleased`. |

### Durable Objects

| Assumption | Where it matters |
|---|---|
| `new_sqlite_classes` in the first migration gives both classes SQLite storage on the paid Workers plan. | `wrangler.jsonc`, `migrations` (tag `v1`). |
| `storage.deleteAll()` removes SQLite tables too. We also drop every table first, so this holds either way. | `Identity.destroy`. |
| Alarms fire within a few seconds of their time. | Held codes are deleted 10 minutes after they arrive, by the alarm; a claim never hands out a code after its wait's time in any case. |

## Not built

- Rotating `MFA_ENCRYPTION_KEY`. Envelopes are `v1.<iv>.<ct>` with no key id; a rotation would need a
  `MFA_ENCRYPTION_KEY_PREVIOUS` and a pass over every identity. Until then, replacing the key makes
  stored authenticator secrets unreadable (they would have to be set again).
- Numbers outside the US.
- Removing an authenticator on its own (setting it again replaces it; deleting the identity removes
  all).
