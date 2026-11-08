# Privacy policy: draft wording for measuring mezonas.com

Status: draft of 2026-11-08, for the owner and the lawyer. **Not applied** to the live `/privacy`
page, which still says "This website uses no analytics". The site does not measure until this
section (as reviewed) is in `apps/site/src/pages/privacy.html`: `build.mjs` refuses a measuring
build while the policy says "no analytics" or does not link `/no-measure` (`apps/site/README.md`,
"Measuring"). A policy that describes measuring the site doesn't do yet would be wrong the other
way, so the two go live in one PR, with the "Last updated" date changed.

Adapted from Plenary Labs' `docs/specs/marketing-portal/privacy-draft.md` (copied, not shared) and
rewritten for Mezonas and what the code does today:

| What the policy says | Where the code does it |
|---|---|
| No cookies, nothing stored in the browser | `apps/site/src/measure.js` (no storage of any kind; tested in `measure.test.ts`) |
| Nothing sent with Do Not Track or Global Privacy Control, and not counted if it were | `measure.js` stops at once; the collector drops a request with `DNT: 1` or `Sec-GPC: 1` (`packs/marketing/src/measure/collect.ts`) |
| No IP address or user agent stored | `packs/marketing/src/measure/events.ts` (`visitHash`, browser and system families only); `apps/api/src/routes/pack-inbound.ts` passes the IP to the hash and nowhere else |
| A visit is a hash with a salt per site per UTC day, deleted after its day | `site_salt`; the nightly pass at 03:41 UTC deletes every spent salt (`rollup.ts`) |
| Location to the city, from the connection | Cloudflare's `request.cf` (`placeOf`) |
| Referrer without its query; only `utm_*` tags read from the address | `events.ts` (`toSiteEvents`) |
| Times of a visit to the hour | `site_visit` (`date_trunc('hour', …)` in `rollup.ts`) |
| Events 90 days, visits 13 months, daily totals kept | `SITE_EVENT_RETENTION_DAYS`, `SITE_VISIT_RETENTION_MONTHS`, the nightly sweep |
| A goal is a click on a marked element, with no link to a person | `site_visit.reached_goal` and `goal` (`docs/plan.md` §1.72) |
| No new provider | Cloudflare (hosting, the collector) and Neon (database), both already on `/subprocessors` |

**Questions for the lawyer:**

1. Does this stay within the consent exemption for audience measurement where one applies (for
   example the CNIL's guidance, and the UK's PECR as amended in 2025): anonymous figures about our
   own site, never joined to anything that names a person, with a plain way to object?
2. Is legitimate interest the right basis for visitors in the EU and the UK?
3. The opt-out is Do Not Track or Global Privacy Control only: with nothing stored in the browser
   there is nowhere to keep a choice made on a page. Is that a "simple way to object", or should
   the site keep an opt-out choice in the browser (which would be the one thing it stores)?
4. Clients' sites are a later step (`docs/marketing-plan.md` F4, M50): there Mezonas is the
   processor and the terms need processor wording. Nothing here covers that.

---

## Proposed section: "This website" (replaces the current paragraph under "What we collect")

We measure how mezonas.com is used, so we can tell which pages help and which don't. We do this
ourselves. No analytics company, advertising network or other third party receives this
information, and we don't use it for advertising.

**We don't use cookies for this, and we don't store anything on your device.** We don't store your
IP address or your browser's identifier either.

**You can stop it.** If your browser sends Global Privacy Control or Do Not Track, our pages send
us nothing about your visit, and we would not count it if they did.
[How we measure this site](https://mezonas.com/no-measure) says how to turn either one on. (In
the page's HTML this link is `<a href="/no-measure">`.)

Otherwise, when you open a page, we record:

- the page, and when you opened it;
- the website that sent you (its address without anything after a `?`), and any campaign tags in
  the link you followed (`utm_source` and similar);
- your approximate location (country, region and city, never finer) and time zone, which our
  hosting provider works out from your connection;
- the kind of device (phone, tablet or computer), your browser and operating system families (for
  example "Firefox" and "macOS", not their versions) and your first language, from what your
  browser sends with every request.

While the page is open, it tells us how long it was in view while you were reading, how far down
you scrolled, and which of our marked links and buttons you clicked.

To count a visit without knowing who you are, we combine your IP address and your browser's
identifier with a random value that is different for each day, and keep only the scrambled
result. We delete the random value within hours of the day ending (UTC), so nobody, including us,
can make the result again or connect your visits on different days.

If you click "Talk to us" or our contact address, we note on that day's visit that it reached
contact. We don't note who you are, and if you then write to us, your email is not linked to the
visit.

Our hosting provider also processes standard request data, such as IP addresses, and may set a
strictly necessary security cookie, to deliver and protect the site. That is separate from our
measuring and we don't receive it.

**How long we keep it.** Single page events: 90 days. A summary of each visit, with its times to
the hour: 13 months. After that we keep only daily totals (for example, visits per page per day),
which say nothing about any one visitor. We use all of it only to count and improve our own
website, and never combine it with anything else we hold.

**Why.** Our legitimate interest in understanding and improving our website. Because we can't
identify you from this information, we usually can't find "your" visits to show or delete them.

---

## Also to change when this goes live

- `/privacy`, "How we use it": add "to count and improve our own website" if the lawyer wants it
  there as well.
- `/privacy`, "Retention and deletion": add the 90 days and 13 months.
- `/subprocessors`: no new provider (Cloudflare and Neon are listed). Confirm Cloudflare's row
  mentions the site's visit data.
- `docs/plan.md` §1.29 and `apps/site/README.md` already say the site measures only while the flag
  is set.
