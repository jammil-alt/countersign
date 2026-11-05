# apps/mfa

The code service (ARCHITECTURE §6.9, docs/plan.md §1.26): a Worker of its own, `mezonas-codes`, that
receives second-factor codes for agent identities and hands each one, once, to the login that asked
for it. It has its own key (`MFA_ENCRYPTION_KEY`), its own Durable Object storage and its own Twilio
subaccount, and no access to Neon, R2 or apps/api's secrets. It imports `@countersign/core` only
(`scripts/check-deps.mjs` enforces it).

| File | What |
|---|---|
| `src/index.ts` | Worker entry: the public `fetch` (Twilio's signed inbound texts, `/health`) and `email()` for `AGENT_EMAIL_DOMAIN`; exports the classes below. |
| `src/service.ts` | `Codes`, the WorkerEntrypoint apps/api calls through its `CODES` service binding (core's `CodesService`). |
| `src/identity.ts` | `Identity` Durable Object, one per identity: the identity, sealed authenticator secrets, waits, held codes, the daily count, alerts. |
| `src/directory.ts` | `Directory` Durable Object, one per client: its identity ids, for `alerts`. |
| `src/match.ts` | Sender matching, reading a code with the wait's pattern, naming unmatched messages. |
| `src/email.ts` | Parsing with postal-mime; SPF, DKIM and DMARC from Cloudflare's topmost authentication header. |
| `src/totp.ts`, `src/crypto.ts`, `src/twilio.ts` | RFC 4226/6238 codes, AES-256-GCM sealing, Twilio signatures and numbers. |
| `NOTES.md` | What we assumed about Cloudflare and Twilio, to verify. |

## How a code is handed out

1. A login in progress (apps/api, phase 3) calls `openWait({tenantId, identityId, siteKey, channel,
   sender, pattern, ttlSeconds ≤ 300})`. Each identity may open 20 waits a day (`MFA_DAILY_CAP`).
2. A text (Twilio → `POST /twilio/sms/<identity id>`) or an email (`agent-<identity id>@<domain>`)
   arrives. Email counts only when SPF, DKIM and DMARC passed, and only where `EMAIL_CODES` is `on`
   (off everywhere until verified: `NOTES.md`). The first open wait whose sender
   matches and whose pattern finds a code takes it; the code is sealed and held.
3. `claim({tenantId, identityId, waitId})` answers `pending`, then `{status: 'code', code}` once,
   then `expired`. The held code is deleted when claimed, or by the alarm after ten minutes.
4. A message no wait takes is never handed out: it becomes an alert (`unsolicited_code`,
   `reset_attempt` or `unexpected_message`) with metadata only. apps/api's cron reads `alerts` and
   raises inbox items for the operator and the client admin.

Authenticator (TOTP) waits need no message: `setAuthenticator` stores the site's `otpauth://` secret,
and `claim` computes the current code.

## Running it

```sh
cp apps/mfa/.dev.vars.example apps/mfa/.dev.vars   # then set MFA_ENCRYPTION_KEY
pnpm --filter @countersign/mfa dev                  # wrangler dev on :8788
pnpm --filter @countersign/mfa test                 # Node tests, then the workerd tests
```

Locally apps/api runs without the `CODES` binding, so the code service is off there.
