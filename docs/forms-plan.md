# Forms: collecting data from people by link (draft, 2026-11-16)

Owner, 2026-11-16: "We should build forms for human data collection too, something basically a link
can be sent with a custom questionnaire that they can talk to or type into and upload documents as
needed." Nothing here is built. Like the FP&A team (`docs/fpa-plan.md`), it is outside ARCHITECTURE
v0.18's scope and goes into the v0.19 write-up first. Checked against the code on 2026-11-16.

The FP&A Collector is the first user (owners explaining variances, plan and driver inputs each
quarter). It is a **platform** feature because others need the same thing: a vendor's onboarding
details and documents, a client's set-up answers (Reggie's "ask the client for what only they can
give", `docs/plan.md` §1.101), a purchase request with its quote attached, and a build's intake.

---

## 1. What already exists

| Piece | Where | What forms take from it |
|---|---|---|
| Signed public pages in the client's name | Texting sign-up (`apps/api/src/messaging/signup.ts`, `routes/text-signup.ts`, §1.98): HMAC links with a key derived from `ENCRYPTION_KEY`, `mountPublic`, `no-store`, `noindex`, one reminder at most | The link, the page and the reminder |
| A typed answer from a person, with a model helping | Conversation step `comms.converse` (ARCHITECTURE §10.12): a fixed goal, a `result` JSON Schema, confirm-before-done, limits on messages, time and cost, approval of the plan, everything the person writes kept as data | The "talk to it" mode, and the result typed for later steps |
| One question and one answer, with consent and quiet hours | Reach out (§1.25) | Sending the link by email, text or WhatsApp |
| Voice to text | Voice typing (§1.109): OpenAI transcription, 4 MB or 2 minutes, nothing stored, refused in HIPAA mode | Dictating into any answer |
| Files | The documents capability (`packages/documents`, `storeDocument`): stored in R2, read, linked | Uploads become documents, read like any upload |
| Requests on the Desk | Lead requests (§1.101) and `docs.request_from_person` | A client user gets the form on the Desk; external people get a link |
| Deadlines | `ifNoAnswer` (stop, proceed, skip, escalate) on business hours (§10.14) | The form's due date and what happens after it |
| Translation | P-7 (§10.13) | Questions in the person's language, answers translated beside the original |

**Gaps:** a form definition, a public page that collects several typed answers with files, a
transcription route a link can use without signing in, and saving half-finished answers.

---

## 2. Design

### 2.1 Three things

1. **A form** is a versioned definition kept in the Library, shared or for one client, like skills
   and automations (`form`, `form_version`; immutable versions, draft → publish → rollback). It holds
   sections and questions, and the JSON Schema of its result, worked out from the questions.
2. **A step, "Ask with a form"** (`forms.collect`), is a built-in skill run as a workflow step, like
   `comms.converse`. It names the form (`slug@version`, pinned), who to ask, the channel, prefilled
   values (templates over the run) and a due date. It waits, and its output is the typed answers plus
   the documents' ids. Later steps and `if`s read `{{steps.<id>.output.answers.<field>}}`.
3. **A form request** (`form_request`) is one person's copy of one form for one run step: the
   link, its status, the saved draft, the submitted answers and the files.

```ts
FormDefinition = {
  schemaVersion: 1, slug, title: LocalizedText, intro?: LocalizedText,
  sections: [{ id, title?, show?: Rules, questions: Question[] }],
  assist: 'off' | 'chat',                  // "talk to it" (2.3); voice dictation is per question
  confirm: boolean = true,                 // show the answers back before submitting
}
Question = { id, label, help?, required, show?: Rules /*conditional*/, dictate: boolean = true } & (
  | { type: 'text' | 'long_text' }
  | { type: 'number' | 'money' | 'percent' | 'date' }
  | { type: 'choice' | 'choices', options: { id, label }[], other?: boolean }
  | { type: 'yes_no' }
  | { type: 'files', accept: ('pdf'|'image'|'sheet'|'doc')[], max: 1–10, readAs?: string /*an extraction kind*/ }
  | { type: 'rows', columns: Question[] /*no files or rows inside*/, min?, max? }   // a table: drivers, headcount
)
```

Ids are made once and never reused (invariant 3), so a client's copy of a form merges like a step.
Money answers are decimal strings (invariant 6). There is **no password, card or secret question
type**: credentials go into the portal's vault only (invariants 13 and 14), and the validator
refuses a form whose question words ask for a card number, a password or an SSN (a warning the
operator can't override for card numbers).

### 2.2 The link and the page

- **Who gets what.** A directory contact (vendor, budget owner without an account) gets a link. A
  client user gets the same form as a Desk item in the portal (with the usual notification), and
  fills it in there; no link. // DECISION, proposed: one form, two doors.
- **Sending** is a reach out: consent, opt-out, quiet hours, the person's daily cap, the bound
  channel, and **approval on by default** for the first send, showing who, the form, the channel
  and the due date (invariant 8). One reminder before the due date, as the texting invitations do.
- **The link** is signed like the texting sign-up link (its own derived key), names the request
  only, and expires at the due date plus a grace period (proposed: 7 days; at most 30). The request
  can be revoked from the run view. The page is in the client's name, `no-store`, `noindex`.
- **A code, for sensitive forms** (a form setting): before the page shows anything, a one-time
  code goes to the recipient's own email or phone. Off by default; on by default for any form with
  files, because a forwarded link would otherwise let anyone upload to the client. // DECISION, owner to confirm
- **Saving as you go.** Answers save as the person types (a draft on the request), so a long form
  can be finished later from the same link, or on another device.
- **Passing it on.** "Someone else should answer this" sends a new request to a person the client
  already has in its People or directory, recorded on the request. Not to an address typed in. //
  DECISION, proposed: budget owners often delegate, but the client decides who may be asked
- **Done.** Submitting shows the answers back (with `confirm`), then a thank-you. The step wakes.
  Answers can't be changed after submitting; a new request is a new link.

### 2.3 "Talk to it" or type into it

Three ways in, on the same form:

1. **Type**: plain fields, mobile first.
2. **Dictate** any answer: the microphone button records, transcription fills the box, the person
   reads and edits it. A public route scoped to the link (`POST /api/forms/:token/transcribe`), the
   same limits as §1.109, and a cap per request (proposed: 30 recordings) so a link can't be used
   as a free transcription service.
3. **Talk it through** (`assist: 'chat'`): a panel beside the form where the person says or types
   what they know in their own words ("Travel is over because of the Denver trade show; it won't
   happen again"). The agent asks for what's missing and **proposes** values into the fields; the
   person sees each proposed value marked as such and accepts or changes it. Nothing is submitted
   by the model. This is the conversation step's turn engine with a new channel `form` and the
   form's schema as `result`: same limits, same cost cap, same rule that what the person writes is
   data, never instructions (invariant 9).

A live voice call that fills the form (ElevenLabs, already a connector for calls) is **later**: the
same request and schema, a phone channel instead of the page.

### 2.4 Uploads

Each file goes through `storeDocument` as a document of the client, linked to the request and its
question, with the usual limits (32 MB, 500 pages) and type checks. A question with `readAs` runs
extraction, and the reading joins the answers (an invoice's total, a W-9's name). The documents are
the answers' `sources` (invariant 10).

### 2.5 Compliance

- **HIPAA mode:** dictation and "talk to it" send data to a model vendor, so they follow the
  existing gates (`VOICE_FEATURE`, the conversation's); typed answers and uploads stay ours. A form
  for a HIPAA-mode client shows neither button until the vendor is covered.
- **Audit:** the public routes write no session audit row (as the sign-up page), so the request
  keeps its own log: sent, opened, code checked, saved, files added, submitted, with time, address
  and browser.
- **Retention:** answers and files are client data under the client's retention; a draft that is
  never submitted is deleted 30 days after the link expires (proposed).

### 2.6 Building forms

- **The Builder drafts a form** from a sentence ("ask each budget owner why their line is over plan,
  with a reason, whether it repeats and support if they have it"), as it drafts skills; the operator
  edits it in a form editor in the Library (questions as a list, a preview in the client's language).
- A template ships its forms the way it uses automations: by pinned version. A form written for one
  client stays that client's.
- **Test runs** make the request and show the link in the run view, marked as a test, but never send
  it; the operator can open it and fill it in to see the step continue.

---

## 3. Where FP&A uses it

| Use | Form |
|---|---|
| Collector: why is my line over? | One request per owner, one section per flagged line (prefilled with actual, plan, diff and the top transactions): reason (`timing`, `one_off`, `run_rate`, `error`, `other`), explanation, the period it reverses in (if timing), support files. Answers write `variance.explanation` with `explained_by: owner` |
| Quarterly plan and driver inputs | `rows` questions: headcount by month, pipeline by stage, price changes. Answers become `driver` and `plan_amount` rows |
| Budget upload | One `files` question reading a sheet, for owners who keep their budget in Excel |
| Mapping questions to the finance lead | Stays a Desk card (a client user); the card can use the same form renderer |

This also settles one of the brief's open questions better than email replies: owners answer on a
form reached by email or text, which gives typed answers and attachments, and they can talk it
through instead of writing.

---

## 4. Build order (track F)

| Step | What | Done when |
|---|---|---|
| F-1 | Core: `FormDefinition` schema, validator (ids, conditions, result schema, refused question types), result typing for later steps | Core tests |
| F-2 | Migration (own PR): `form`, `form_version`, `form_request` (tenant, run, node, form version, recipient, token hash, expires, status, draft, answers, documents, log), forced RLS | Migration tests |
| F-3 | The step `forms.collect`, sending by email through reach out, the public page (type, files, save as you go, confirm), the Desk door for client users, deadline and one reminder | A run asks a contact, the link is filled in on a phone, the run continues with typed answers and two documents |
| F-4 | Dictation per question (token-scoped transcription) and the code check | Both behind their gates; HIPAA refusal tested |
| F-5 | "Talk to it" (conversation channel `form`, proposals into fields) | Recorded fixtures: a spoken answer becomes accepted field values, and a nudge in the answer text changes nothing |
| F-6 | Form editor in the Library, the Builder drafting forms, preview, texts and WhatsApp as channels, passing it on | An operator drafts the Collector's form from one sentence and publishes it |

F-1 to F-3 come before FP&A phase 2 (the Collector needs them). F-4 to F-6 can run beside it.
Size: F-1 to F-3 about 2 weeks, F-4 and F-5 about 1–2 weeks, F-6 about 1–2 weeks.

**Risks:** a public upload page is the platform's first place where a stranger can send files into a
client's account (hence the code, size and type limits, and no file is ever shown back on the
page); transcription and chat cost on a public page (the per-request caps); and phones (the page is
built and tested at phone width first).

---

## 5. Questions for the owner

| Question | Proposal |
|---|---|
| Require a one-time code to open a link? | Only for forms with files or marked sensitive |
| Can a person pass the form on? | Yes, to someone in the client's People or directory, recorded |
| Do signed-in client users get links too? | No: the Desk, with the usual email or text notification |
| Live voice calls filling a form | After F-6 |
| Link lifetime | Due date plus 7 days, at most 30 |
