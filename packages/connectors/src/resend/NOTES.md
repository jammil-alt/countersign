# Resend: what we couldn't verify

The `resend` connector and its fake follow Resend's API as we remember it. Nothing has been checked
against the live API. Before a client sends real email, check each item below and fix the connector
and fake where they differ.

## Sending (`POST /emails`)

- The JSON field names: `from`, `to` (an array), `subject`, `text`, `reply_to` and `headers`. Resend's
  SDKs say `replyTo`, and the REST API may want `reply_to` (we send `reply_to`).
- `Idempotency-Key` as the header name, how long Resend keeps a key (we assume 24 hours) and what it
  answers to a repeat (we assume the first email's `id` with 200). After that window a retried
  action could send twice. `sentFor` (our own record by the action's key) covers a re-run after a
  crash only once the send has been recorded.
- Whether a custom `Message-ID` header is kept as sent, so a reply's `In-Reply-To` names it. We
  match replies by the `+tag` in the reply-to address first, and the sender's address second, so
  matching doesn't depend on this.
- The answer's shape: `{ "id": "..." }`.
- Rate limits (2 requests a second by default?, for the whole team, so every client shares it) and
  the errors for a bad `from`, an unverified domain, or a key restricted to another domain (we
  assume 403). A 429 is retried up to three times after `Retry-After` (at most 5 s) or 1, 2, 4 s;
  still refused, the send fails as not sent (any 4xx but 408 and 409 is "nothing sent").

## Attachments (P-3, docs/plan.md §1.65)

- `attachments: [{filename, content, content_type}]` in the `POST /emails` body, `content` as
  base64. UNCHECKED: the field name `content_type` (some SDK pages show `contentType`), and whether
  Resend takes the type from the file name when it is missing.
- The limit: 40 MB per email after base64 encoding (from memory of Resend's docs, UNCHECKED). We
  send at most 29 MB of files (`RESEND_ATTACHMENT_LIMITS`), at most five, PDFs and images only.
- Whether `Idempotency-Key` still holds for a request this large (we assume so).

## Domains

- `POST /domains {name}` answers `{id, name, status, records: [{record, name, type, ttl, status,
  value, priority}]}`. We assume the record names are those to show the client, with `status` per
  record.
- The status values: `not_started`, `pending`, `verified`, `failed`, `temporary_failure`. We send
  from the client's domain only on `verified`.
- `POST /domains/:id/verify` starts a check and answers at once, and `GET /domains/:id` later shows
  the result. We read the domain again after verifying, so a slow check shows `pending` until the
  operator presses "Check" again.
- Regions: domains default to `us-east-1`, and we don't set one.

## Keys

- `POST /api-keys {name, permission: "sending_access", domain_id}` answers `{id, token}`, and the
  token can send only from that domain. Each client's connection holds such a key, never Mezonas'
  full key (`RESEND_API_KEY`).
- Keys made for our own fallback domain carry `domain_id` for that domain. We need its id (the
  `RESEND_FALLBACK_DOMAIN_ID` setting). Without it the key is made with no domain, which is full
  sending access on our account.
- Revoking a key when a client is disconnected isn't built.

## Not built

- Inbound email through Resend: replies come back through Cloudflare Email Routing to the
  client's forwarding address.
- Complaints are not read, and a bounce of an agent's email doesn't opt a contact out yet: only
  the onboarding emails' delivered and bounced are read (below).
- HTML email and open or click tracking. Agents send plain text, with PDFs and images
  attached (P-3).

## Webhooks (§1.220, C7)

- `POST /api/hooks/resend` takes Resend's events for the whole account, signed as Svix signs:
  `svix-id`, `svix-timestamp`, `svix-signature` (`v1,<base64>` list), HMAC-SHA256 of
  `<id>.<timestamp>.<body>` under the base64 key after `whsec_` (`webhook.ts`). The scheme is
  checked against Svix's published example; that Resend sends these header names (and not the
  `webhook-*` names of Standard Webhooks) is UNCHECKED.
- The event shape: `{type, created_at, data: {email_id, to, tags, bounce?: {type, subType,
  message}}}`. UNCHECKED: whether `data.tags` comes back as an object (`{name: value}`) or as the
  send's list (`[{name, value}]`); both are read. That `email_id` is the `id` the send answered.
- `tags: [{name, value}]` on `POST /emails` (letters, digits, `_`, `-`, at most 256 each). The
  onboarding emails carry `mz_tenant` and `mz_notification` (ids only).
- Whether Resend says `email.bounced` only after its own retries of a soft bounce (we assume so,
  and leave the lead a to-do for any bounce).
- How long Resend retries an unanswered delivery; each is applied once per email and kind.
