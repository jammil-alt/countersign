# What Mezonas may claim in public

Status: **draft for the owner's review**, 2026-11-08 · Owner: Jammil · Changes by PR, then loaded
again in the back office

Every public sentence about Mezonas keeps to this list: mezonas.com, its guides, social posts,
forum replies, and anything a marketing agent drafts. It is the Mezonas client's claims list in
the Marketing area (`docs/marketing-plan.md` §4.5): the content checks read its newest version, so
a guide that breaks a "Never" entry can't be published, and a guide that touches an "Approved with
a condition" entry shows the condition beside the words for a person to confirm.

The machine-readable copy is `fixtures/marketing/mezonas-claims.json`. To load it for the Mezonas
client, the operator sends it as the body of the Marketing pack's `seed-claims` action (the first
time) or `save-claims` (a new version), from the back office's Claims page or with
`POST /api/ops/clients/<Mezonas id>/packs/marketing/actions/seed-claims` and
`{ "list": <the JSON> }`. Each version is kept; the newest is the one the checks use.

Everything below was taken from what mezonas.com says today (`apps/site/src/pages`) and what the
code does (CLAUDE.md's invariants). Each claim names why it is true, so that when the product
changes its owner knows which claims to check again. Words in a "Never" entry's phrases are
refused wherever they appear; the phrases are in the JSON.

Every client's list, this one included, also keeps two house rules the checks apply whatever the
list says: no exclamation marks, and never "AI-powered".

## Approved

| Claim | Why it is true | Where it is said today |
|---|---|---|
| We build and run agents for your back office. Mezonas is a managed service: you don't build anything and you don't learn a new tool | The operator builds and runs agents per client; clients never edit agents (CLAUDE.md, invariant 11) | Home: hero, "What we do" |
| Your agents work in your own tools, like QuickBooks and Gmail (and Zoho CRM, Podio and others) | The connectors (`packages/connectors`) | Home |
| Every change your agents want to make waits for your approval by default, unless you choose otherwise | Approval is on by default; every write is an external action behind the gate (invariant 8) | Home: hero, "You make the call", Security |
| Each change is shown before and after, with the records behind it | `external_action.before`, evidence `sources` (invariants 8, 10) | Home: Approvals |
| Deleting is switched off | Delete is off in every matrix (invariant 8) | Home: Security |
| Test runs never change anything in your tools | Test runs never write (invariant 8) | Home: How it works, Security |
| You connect your own tools from your portal, and can disconnect at any time | Clients sign in to their own tools (invariant 8) | Home: How it works |
| Logins and keys you enter are encrypted with a key that belongs to your account alone, and can't be read back, not even by us; agents never see them | Secrets are encrypted with the client's own key, write-only, never reach a model, log or screen (invariant 13) | Home: Security; privacy policy §8 |
| Each client's data is kept apart, down to each row in our database; what your agents learn about your business is used only for you | Row-level security on every client table; memory per client (invariant 1) | Home: Security; privacy policy §3, §8 |
| Each change keeps who proposed it, who approved it, what it was before and the records behind it | `external_action`, the audit log (invariants 10, 14) | Home: Security |
| An agent reaches only the tools it is given, within limits you can see and tighten on your Access page | Bindings and grants; clients tighten their matrix (invariants 8, 13) | Home: Security |
| You can require a named person to release a tool before an agent uses it, with a one-time code | Human release (`docs/plan.md` §1.26) | Home: Security |
| Your portal shows reports, runs, approvals, requests and connections, in plain words | The client portal | Home: "Your own portal" |
| We don't receive or store card numbers | Payments are on Stripe's pages; card numbers are never stored (invariant 14) | Privacy policy §2 |
| We don't use client data to train AI models, we don't sell it, and we don't use it for advertising | Our providers' commercial API terms; no such use in the code | Privacy policy §3, §4 |
| Gmail is used only to send messages a person at the client approved; we don't read, search or label your mailbox | Gmail is send only (invariant 12, ARCHITECTURE §6.4) | Privacy policy §4 |
| Text from documents, emails, messages and websites is passed to models as data, never as instructions | Invariant 9 | Privacy policy §6 |
| mezonas.com uses no advertising cookies | The site's own pages | Privacy policy §2 |

## Approved with a condition

| Claim | Condition |
|---|---|
| A routine change can run on its own | Only with "we set that up with you, and you can switch it back at any time" in the same passage: it runs without a person only when the operator set the step so, the client's matrix allows it and the agent acts (invariant 8) |
| mezonas.com uses no analytics | Only until measurement goes on (`SITE_MEASURE=on`, after the lawyer reads the privacy wording, `docs/marketing-plan.md` §8.4); from then on say what we measure and that we keep no IP address and set no cookie |
| A named tool we connect to (QuickBooks, Gmail, Zoho CRM, Podio, Slack, WhatsApp, Outlook and the rest) | Only tools whose connector is built and offered; never a logo without the owner's approval, and never "partner" or "certified" without a written agreement |
| A comparison that names another company's product (Zapier, Make, a bookkeeping service) | The owner's approval for each one; comparing approaches without naming anyone needs none |
| A figure about time or money saved, or how much work agents do | A source on record for each figure (a client's own numbers, with their written agreement) before it appears anywhere |
| HIPAA, SOC 2 or PCI | Only as `docs/hipaa-plan.md` says it stands (what is built and what is open), never "compliant" or "certified" until an assessment says so |
| Phone calls, texts and WhatsApp on the client's numbers | Only once the legal review of calls and texts is done (CLAUDE.md, waiting on the owner), and with consent and quiet hours said as the text message terms say them |

## Never

- That agents **work without people** or are fully autonomous, or that a person never needs to look.
- That agents **never make mistakes**, or any accuracy figure ("99% accurate") that isn't published with its method.
- **Prices**, fees or "free", until pricing is public (the terms leave fees to the client's order).
- **Customer names, counts, quotes or logos**, unless the customer has agreed in writing.
- That we are **certified** or **compliant** with HIPAA, SOC 2 or PCI, or "bank-level" security.
- That Mezonas **replaces** a bookkeeper, an accountant or anyone's job.
- That anyone at Mezonas **can read your logins or keys**, or that agents see them.
- **Unlimited** anything (agents, runs, connections).
- A forum or community post that **doesn't say the writer works at Mezonas**, or that a person did not post themselves.

## To confirm (owner)

- The two conditions about the site's measurement and about calls and texts depend on reviews only
  the owner can arrange.
- Whether "a Twelve Thirty-Four company" should appear on every public page.
- Whether "managed service" or "service suite" is the phrase to lead with.
