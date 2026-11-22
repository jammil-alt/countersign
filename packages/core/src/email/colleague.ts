// Another address at a contact's company (docs/plan.md §1.194): a vendor's colleague answering an
// email that went to someone else there. Pure: no I/O. Such mail is never the contact's answer; it
// is only kept for a person to read and enter.

/** Mail services anyone can sign up to: their domain says nothing about a company. */
export const FREE_MAIL_DOMAINS: ReadonlySet<string> = new Set([
  "gmail.com",
  "googlemail.com",
  "yahoo.com",
  "yahoo.co.uk",
  "ymail.com",
  "hotmail.com",
  "hotmail.co.uk",
  "outlook.com",
  "live.com",
  "msn.com",
  "aol.com",
  "icloud.com",
  "me.com",
  "mac.com",
  "proton.me",
  "protonmail.com",
  "gmx.com",
  "gmx.de",
  "mail.com",
  "zoho.com",
  "zohomail.com",
  "yandex.com",
  "comcast.net",
  "att.net",
  "verizon.net",
  "sbcglobal.net",
  "bellsouth.net",
  "cox.net",
  "earthlink.net",
]);

function domainOf(address: string): string | null {
  const at = address.lastIndexOf("@");
  if (at <= 0 || at === address.length - 1) return null;
  return address
    .slice(at + 1)
    .replace(/\.$/, "")
    .toLowerCase();
}

/**
 * The first of `senders` (the From header's address, then the envelope sender's) at the contact's
 * own domain but not the contact's address: a colleague's. Null when none is, or when the contact's
 * domain is a free mail service's, which says nothing about a company.
 */
// DECISION (§1.194): the same domain exactly (a subdomain is another domain), never a free mail
// service's; proof is not needed, since such mail is only kept, never taken as an answer.
export function colleagueAddress(
  contactEmail: string,
  senders: readonly (string | null | undefined)[],
): string | null {
  const own = contactEmail.trim().toLowerCase();
  const domain = domainOf(own);
  if (!domain || FREE_MAIL_DOMAINS.has(domain)) return null;
  for (const s of senders) {
    const address = s?.trim().toLowerCase();
    if (!address || address === own) continue;
    if (domainOf(address) === domain) return address;
  }
  return null;
}
