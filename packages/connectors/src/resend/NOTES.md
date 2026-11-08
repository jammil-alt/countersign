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
- Rate limits (2 requests a second by default?) and the errors for a bad `from`, an unverified
  domain, or a key restricted to another domain (we assume 403).

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
- Bounces and complaints (Resend's webhooks) are not read. A bounce doesn't opt a contact out yet.
- HTML email and open or click tracking. Agents send plain text, with PDFs and images
  attached (P-3).
