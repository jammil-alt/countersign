# The code service: notes to verify

Written 2026-11-05. Neither Cloudflare's nor Twilio's documentation could be reached from the build
environment, and there were no Cloudflare or Twilio credentials. The tests run the real Worker,
Durable Objects and email parsing inside workerd, but the email headers and Twilio's REST answers in
them are written by us. **A wrong assumption below is a wrong assumption in the tests too.** Check
each item before the first real identity is set up.

## Email codes are off until verified

`EMAIL_CODES` is `off` in `wrangler.jsonc` for local development, staging and production. While it is
off, `openWait({channel: 'email'})` answers `not_configured` ("email codes are off until verified"),
and the `email()` handler still reads every message but never fills a wait from it: a message that
passes the checks below raises an alert, as any unmatched message does. Texts and authenticator codes
are not affected.

Why: if Cloudflare does not put its own `Authentication-Results` or `ARC-Authentication-Results`
header above the sender's headers, a sender could write `mx.cloudflare.net; spf=pass; dkim=pass;
dmarc=pass header.from=<site>` into their own message and it would be read as authentic. Only a real
message through Email Routing can tell.

### Turning email codes on (per environment)

1. Set up Email Routing for the environment's agent domain (docs/operations.md, "The code service")
   and create an identity (any client) to get an address `agent-<id>@<domain>`.
2. **Genuine message.** From a mailbox on a domain with DMARC at `p=reject` or `p=quarantine` that
   passes SPF and DKIM (for example a Google Workspace domain), send any message to that address. In
   the code service's Workers logs, `email.received` must show `spf`, `dkim` and `dmarc` all `true`.
   If not, Cloudflare's header differs from what `src/email.ts` reads: stop and fix the parser first.
3. **Forged message.** Send a message whose From is on a domain that fails DMARC for this sender
   (for example From `someone@<a domain with p=reject that you don't send for>`, sent through any
   other mail server), and put this header at the very top of the message yourself:
   `Authentication-Results: mx.cloudflare.net; spf=pass smtp.mailfrom=<that domain>; dkim=pass
   header.d=<that domain>; dmarc=pass header.from=<that domain>`. (Swaks or any client that lets
   you add raw headers will do.) In the logs, `email.received` must show `dmarc` `false` (and the
   message must not fill a wait). Also look at the message as the Worker received it, by logging
   its header names once in a test deploy if needed, and check that Cloudflare's own header sits
   above the forged one.
4. Only if both hold: set `"EMAIL_CODES": "on"` in that environment's `vars` in
   `apps/mfa/wrangler.jsonc`, in a reviewed PR, and deploy. Note the date and who checked in
   docs/plan.md §1.26.
5. If step 3 is accepted as authentic, leave email codes off: sites that send codes by email then
   have to use texts or an authenticator until the parser reads a header Cloudflare is known to add.

## To verify

### Cloudflare Email Routing → `email()`

| Assumption | Where it matters |
|---|---|
| Email Routing can route a whole subdomain (`agents.mezonas.com`, `agents.staging.mezonas.com`) to a Worker with a catch-all rule, and the Worker sees the original recipient in `message.to`. | `handleEmail` reads the identity from `message.to` (`agent-<id>@<domain>`). |
| Cloudflare adds its authentication verdicts as a header **above** every header the sender wrote, before the Worker sees `message.raw`. The topmost `Authentication-Results` or `ARC-Authentication-Results` header is Cloudflare's. **Until this is checked (above), `EMAIL_CODES` stays `off`.** | `readAuthentication` reads only the topmost of those two headers. If Cloudflare adds neither, the topmost one could be the sender's own (forged): every message would then need to fail, which is what happens unless the forged header also uses Cloudflare's authserv-id. Confirm with a real message. |
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
