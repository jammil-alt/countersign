# 10DLC resubmission: Twelve Thirty-Four Consulting LLC (Mezonas' own campaign)

The first campaign was rejected for missing opt-in evidence. Since 2026-11-14 (`docs/plan.md` §1.98),
nobody gets texts until they sign up themselves, on a page we run, by ticking an unticked box. This
folder is what to paste into Twilio's console and the evidence to point carriers at. Mezonas' campaign
is the pilot: every client's campaign describes the same opt-in.

**Two ways to register.** Through the platform, as every client will: back office, the client's
Texts and WhatsApp page, then the portal's US texting registration, then "Submit to Twilio". The
words below are what it fills in. Or by hand in Twilio's console, for the campaign already there
for +1 469 378 9525. Use one, not both, for the same number.

Edit the rejected campaign and resubmit it. Don't delete it and make a new one: an edited resubmit
isn't charged vetting again, and a new campaign is ($15).

## Before you submit

1. **The sign-up page is live.** Merge the sign-up PR, then open your own link: portal, People,
   "Texting sign-up link", "Show the link". Open it in a private window: it must load without signing
   in. That link goes in the message flow below, where it says `<your sign-up link>`. The page must
   be on the environment where Twelve Thirty-Four is a client (production has had no release yet).
2. **The public explanation is live.** `https://mezonas.com/sms-terms#opt-in` shows the sign-up
   page, the invitation and START, with these screenshots (jammil-alt/countersign#284). It goes live
   when #284 merges and the site deploys from `main`.
3. **HELP gets an answer.** Our code recognises HELP but doesn't reply to it. In Twilio's console,
   on the campaign's Messaging Service, set the HELP reply to the help message below (Advanced
   Opt-Out). Check that STOP and START replies are set too.
4. **The number is in the Messaging Service.** +1 469 378 9525 must be a sender on the campaign's
   Messaging Service.

## The fields

**Use case:** Low Volume Mixed (or Mixed for a Standard brand). The texts are 2FA codes, account
alerts and two-way customer care, never marketing.

**Campaign description**

> Twelve Thirty-Four Consulting LLC (Mezonas) texts its own staff and the vendors and customers it
> works with, about their work together: one-time verification codes, alerts about work waiting for
> them, and two-way questions and answers about orders, deliveries and invoices. Every recipient
> signed up on our sign-up page by ticking an unticked box. No marketing or promotional messages are
> sent.

**Message flow / how people opt in** (`a2pSignupOptIn`, the words the portal pre-fills)

> Twelve Thirty-Four Consulting LLC texts its own staff and the vendors and customers it works with,
> about their work together: questions, updates, codes and alerts. No marketing. People choose to get
> texts on Twelve Thirty-Four Consulting LLC's sign-up page (`<your sign-up link>`): staff get the link
> from Twelve Thirty-Four Consulting LLC, and vendors and customers get an email invitation from
> Twelve Thirty-Four Consulting LLC with a link to the same page. Texting is optional. On the page they
> enter their mobile number, tick an unticked box beside these words and press "Text me": "I agree to
> get text messages from Twelve Thirty-Four Consulting LLC, sent through Mezonas, about my work with
> Twelve Thirty-Four Consulting LLC: questions, updates, codes and alerts. No marketing. Msg frequency
> varies. Msg & data rates may apply. Reply STOP to opt out, HELP for help. Terms:
> https://mezonas.com/sms-terms. Privacy: https://mezonas.com/privacy." A confirmation text follows.
> Anyone can also text START to Twelve Thirty-Four Consulting LLC's number. How this works, with
> screenshots: https://mezonas.com/sms-terms#opt-in.

**Sample messages**

1. `Twelve Thirty-Four Consulting LLC: your Mezonas verification code is 482913. It expires in 10 minutes. Reply STOP to opt out.`
2. `Twelve Thirty-Four Consulting LLC: 3 items are waiting for your approval in Mezonas: https://app.mezonas.com/desk Reply STOP to opt out.`
3. `Hi Pat, this is the Mezonas assistant for Twelve Thirty-Four Consulting LLC. Can you confirm Friday's delivery for PO 1042? Reply YES or NO. Reply STOP to opt out.`
4. `Twelve Thirty-Four Consulting LLC: you are signed up for texts from us. Message frequency varies. Msg & data rates may apply. Reply HELP for help, STOP to opt out.`

**Message contents:** embedded links yes (sample 2); phone numbers no; age-gated no; direct lending
no; affiliate marketing no.

**Opt-in keywords:** START, UNSTOP, YES

**Opt-in message:** `Twelve Thirty-Four Consulting LLC: you are signed up for texts from us. Message frequency varies. Msg & data rates may apply. Reply HELP for help, STOP to opt out.`

**Opt-out keywords:** STOP, STOPALL, UNSUBSCRIBE, CANCEL, END, QUIT, REVOKE, OPTOUT

**Opt-out message:** `Twelve Thirty-Four Consulting LLC: you have been unsubscribed and will get no more texts from us. Reply START to sign up again.`

**Help keywords:** HELP, INFO

**Help message:** `Twelve Thirty-Four Consulting LLC: reply to this text to reach us. Msg & data rates may apply. Reply STOP to opt out.`

**Privacy policy:** https://mezonas.com/privacy · **Terms:** https://mezonas.com/sms-terms

## How this answers "missing opt-in evidence"

| What carriers check | Where it is |
|---|---|
| A call to action they can open | The sign-up page (`<your sign-up link>`), public, no sign-in |
| Consent is explicit and optional | An unticked box; "Texting is your choice. Nothing else depends on it." |
| Brand, purpose, frequency, rates, STOP, HELP, terms, privacy | The words beside the box, word for word (`2-signup-page-filled.png`) |
| How invited people opt in | The invitation email (`5-invitation-email.png`) and its page (`4-invitation-page.png`); "Don't ask me again" on both |
| A confirmation | The opt-in message above, sent from the number after each sign-up (`3-signup-done.png`) |
| Records | Each sign-up keeps the words shown, the number, the time, IP and browser (`docs/plan.md` §1.98) |

## The screenshots

The real page, rendered from the app with the API's answers filled in for the screenshot:

- `1-signup-page.png`, `1-signup-page-desktop.png`: the page as it opens, box unticked.
- `2-signup-page-filled.png`: name, number, box ticked, "Text me".
- `3-signup-done.png`: after signing up.
- `4-invitation-page.png`: the page from an invitation, greeting the person by name.
- `5-invitation-email.png`: the invitation email.
