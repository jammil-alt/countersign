# Measuring a client's website: processor terms (draft)

Status: **draft for the owner and the lawyer**, 2026-11-08 (M50, `docs/plan.md` §1.78). Nothing
here is on the site: `apps/site` keeps its current terms and privacy policy until the lawyer has
read this and the owner has decided. It is not legal advice; it lists what the service does, so
the lawyer can write the words.

## 1. What changes when a client has the Marketing area

Until now Mezonas only touched data a client gave us about its own business. With the Marketing
area on, we also count **the visitors to the client's own website**: people who have no account
with us, never agreed to anything with us, and mostly don't know we exist. For that data the
client decides what is measured and why, and we do the counting for it. In the usual words: the
client is the **controller** and Mezonas is its **processor** (GDPR Art. 28, UK GDPR), its
**service provider** (CCPA/CPRA, Cal. Civ. Code §1798.140(ag)) and its **processor** under the US
state privacy laws that use the word (Virginia, Colorado, Connecticut, Texas, and the others).

For Mezonas's own site (`mezonas.com`), we are the controller; its privacy policy's measurement
section covers that (`docs/marketing-plan.md` §8.4, the site's own PR).

## 2. What we collect, as built

So the lawyer can describe it exactly (from `packs/marketing`, `docs/plan.md` §1.72–§1.74):

| What | Kept | How long |
|---|---|---|
| The page path, the referring site's host, campaign tags (`utm_*`), clicks on elements the client named, how far a page was scrolled, time engaged | Per event | 90 days |
| A visit: a SHA-256 hash of a random salt for that site and UTC day, the IP address and the user agent, cut to 128 bits | The hash only; the salt is deleted when its day is over, so a visit can't be linked to another day's | 13 months |
| Country, region and city from Cloudflare's own lookup; browser family and device class (phone, tablet, desktop) | Per visit | 13 months |
| Daily totals per page, source and click | Counts only | Kept |
| The IP address and the full user agent | **Never stored or logged**; used once, in memory, for the visit hash and the bot checks | — |
| Cookies, local storage identifiers, fingerprints, cross-site identifiers | **None** | — |

Do Not Track and Global Privacy Control are honoured: such a visit is not counted at all. A
visitor can also switch it off on one site (`localStorage["mezonas-measure"] = "off"`; on
mezonas.com, the `/no-measure` page). Requests from bots and scripts are counted only as a
number per reason.

Where it goes: Cloudflare (the Worker that receives it) and Neon (the database), both already on
the subprocessors page. Nothing goes to an advertising network, an analytics vendor or a model.
A weekly report agent may read the **figures** through the pack's tools, and an operator may read
the back office's reports through our assistant connection (the ops MCP server); both send what
they read to our model provider (Anthropic), already a subprocessor. The lawyer should check
whether the terms' "we don't use it to train AI models" covers this as written.

Search figures (Google Search Console, Bing Webmaster Tools) are the client's own accounts about
its own site; we read them with a key or a sign-in the client gives us. They hold searches, not
visitors, and are not personal data as we receive them (Google withholds rare searches). No
processor wording is needed for them beyond "tools you connect" (terms §6).

## 3. What the terms need (a data processing addendum, or a section)

The GDPR's Art. 28(3) list, and the CCPA's service-provider contract terms, mapped to what we do:

1. **Subject matter, duration, nature and purpose**: counting visits to the client's website for
   the client's own reports, for as long as the client has the Marketing area on.
2. **Types of data and of people**: website visitors; the data in §2 above.
3. **Only on the client's instructions**: we measure only the sites the client asks us to, and
   use the figures only for that client's reports and agents (CLAUDE.md invariant 1: one client's
   figures never reach another's). We never sell or share them (CCPA "sell" and "share"), never
   use them for advertising, never combine them with other clients' data or our own, and never
   use them to train models.
4. **Confidentiality** of the people who handle them: already terms §8; the processor clause
   should say it covers our staff and the people who build and run the client's agents.
5. **Security**: as `docs/security.md` (encryption in transit and at rest, per-client row-level
   security, audit log). The addendum can point to a security summary rather than list it.
6. **Subprocessors**: the subprocessors page, with notice before a new one (the terms already
   promise 30 days for changes that matter; the lawyer should decide whether subprocessor changes
   get their own notice and a right to object).
7. **Helping with visitors' requests** (access, deletion): we keep nothing that names a visitor, so
   we can't find one person's visits; the clause should say so plainly, and that we delete a
   site's data on the client's request.
8. **Helping with breaches and assessments**: notice of a breach without undue delay (the lawyer
   picks the hours: 72 is the GDPR's for the controller, so processors usually promise 48 or
   fewer).
9. **Deletion or return at the end**: already terms §12 (export within 30 days, then deletion);
   the site data follows the same path (the purge deletes every row of the client).
10. **Audits**: information on request, and an audit at the client's cost, at most once a year,
    with notice (usual wording).
11. **International transfers**: our providers are in the US; for a client with EU or UK
    visitors, the Standard Contractual Clauses (module 2, controller to processor) or the UK
    addendum. The lawyer decides whether we offer this now or say the service is for US
    businesses.
12. **CCPA certification**: that we understand and will comply with the restrictions, and will
    tell the client if we can no longer meet them.

## 4. What the client's own site must say

The client is the controller, so its own privacy notice must describe the measurement; we should
give them words they can adapt. A draft for the lawyer:

> We count visits to this site with Mezonas, without cookies. We do not store your IP address or
> anything that names you. We see the pages you read, the site that sent you, your country and
> region, and your type of device, and we keep a day's visit apart from any other day's. If your
> browser sends Do Not Track or Global Privacy Control, your visit is not counted.

The client also decides whether it needs a consent banner. With no cookies and nothing stored on
the visitor's device, the ePrivacy rules on device storage may not apply, but the lawyer should
say so for the EU and UK, and for any US state law that the client is under.

## 5. What Mezonas's own privacy policy needs

A short new section, beside the measurement section for mezonas.com:

- That we count visits to our **clients'** websites for them, as their processor, and that a
  visitor to such a site should read **that site's** privacy notice and send requests to it.
- What we keep and for how long (§2), and that we keep nothing that names a visitor.
- That a client's figures are used only for that client.

And the subprocessors page needs no new row: Cloudflare and Neon are already there.

## 6. Clients we can't offer it to yet

- **A client in HIPAA mode.** A visit to a health client's site can itself be health information
  (a page about a condition, a booking page; HHS's guidance on online tracking, 2022 and 2024, in
  part vacated in 2024 for pages anyone can see). Until the owner decides with the lawyer, the
  platform stores nothing a visitor sends for a client in HIPAA mode (`inboundHeld`,
  `packages/core/src/compliance`; `docs/plan.md` §1.78). The decision to make: whether a BAA with
  the client covers measurement, and whether pages behind a sign-in are ever measured (today
  nothing stops a client pasting the snippet on them).
- **A site for children under 13** (COPPA): the lawyer should say whether the terms exclude it.

## 7. Decisions for the owner

1. A data processing addendum (its own page, linked from the terms) or a section in the terms.
2. Whether to offer it outside the US now (§3.11).
3. Breach notice hours (§3.8).
4. HIPAA clients (§6).
5. Whether the snippet's page tells site owners what their notice must say (§4); today the
   operator gives the snippet to the client.
