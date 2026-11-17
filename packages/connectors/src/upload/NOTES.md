# Inbound email: what we couldn't verify

Written 2026-11-17. Mail to the forwarding domain (`in.mezonas.com`, `in.staging.mezonas.com`)
reaches apps/api's `email()` handler through Cloudflare Email Routing: a client's forwarding address
(`<label>-<client id>-<secret>@`, its invoice inbox), its reply addresses (`r-<client id>+<tag>@`,
where replies to agents' emails come back), the release and voice tags on the forwarding address,
and agents' own addresses. Whether a sender is who they say is read from Cloudflare's own
authentication header by `readAuthentication` (`packages/core/src/email/authentication.ts`), the same
reader the code service uses (`apps/mfa/NOTES.md`). The tests write those headers themselves.
**A wrong assumption below is a wrong assumption in the tests too.** Check each item with real mail
on `in.staging.mezonas.com` before relying on it for a real client.

## To verify

| Assumption | Where it matters |
|---|---|
| Cloudflare adds its own `Authentication-Results` (or `ARC-Authentication-Results`) header **above** every header the sender wrote, before the Worker sees `message.raw`, with the authserv-id `mx.cloudflare.net`. | `readAuthentication` reads only the topmost of those two headers and only with that authserv-id. If Cloudflare adds neither, a sender's own forged header on top would be read: every forwarded message from an allowed sender would then pass. |
| The header carries `spf=pass … smtp.mailfrom=<envelope sender or its domain>` and `dmarc=pass … header.from=<From domain>` in RFC 8601 form; `ARC-Authentication-Results` starts with `i=<n>;`. | The envelope sender counts only when SPF passed and `smtp.mailfrom`'s domain is the envelope sender's domain; the From header only when DMARC passed for its domain (`authenticatedSenders`). |
| `message.from` is the SMTP envelope sender (MAIL FROM), empty or `<>` for a bounce. | An empty return path marks mail as automatic (`isAutomaticEmail`): it answers no reach-out and starts no message trigger. |
| Email Routing's catch-all for the forwarding domain also delivers `r-<client id>+<tag>@` addresses to the Worker, with the whole recipient (tag included) in `message.to`. | Replies to agents' emails come back only this way. Earlier reach-outs' `<forwarding address>+<tag>` replies are still read. |
| A local part of 63 characters (`r-` + 26 + `+` + 34) is delivered whole by the providers vendors reply from. | The reply address's tag names the reach-out and carries its secret. |

### Checking with real mail (staging)

1. **Genuine.** From a mailbox on a domain with DMARC at `p=reject` or `p=quarantine` that passes
   SPF and DKIM (for example a Google Workspace domain), on a test client's allowed-senders list,
   forward a PDF to the client's forwarding address. It must become a document whose
   `meta.email.authenticated` is `true` and `authenticatedAs` is the sender.
2. **Forged header.** From a server that is not allowed to send for that domain, send the same with
   `From:` on the allowed domain and this header at the very top of the message yourself:
   `Authentication-Results: mx.cloudflare.net; spf=pass smtp.mailfrom=<allowed domain>; dmarc=pass
   header.from=<allowed domain>`. It must be dropped (`sender_not_allowed` in the connection's
   forwarding stats). Log the message's header names once in a test deploy if needed, and check
   that Cloudflare's own header sits above the forged one.
3. **Spoofed envelope.** From a server outside the allowed domain's SPF record, send with the
   envelope sender (MAIL FROM) set to an allowed address and no From on the list. It must be dropped.
4. **Replies.** Answer an agent's email from the contact's mailbox: the reach-out ends as replied.
   An out-of-office from the same mailbox must leave it open; a second answer after it ended shows
   in the contact's thread as received.

If step 2 or 3 is accepted, stop: the reader does not read the header Cloudflare adds, and no
sender check on the forwarding domain can be relied on until it does.
