// The blocked tier's hosts (invariant 13), as the browser service checks them: well-known banks,
// payment services, email accounts and identity providers. apps/api decides every site's tier
// (core's `BROWSER_BLOCKED_HOSTS` and `siteTier`); this service checks the same list again as it
// opens a browser and as each page loads, so a site on it is never opened whatever it was asked.

// DECISION: a copy of core's list, not an import: this Worker takes core's types only
// (scripts/check-deps.mjs, rule 7). ./blocked.test.ts holds it equal to core's, entry for entry.
export const BLOCKED_HOSTS = [
  // Banks
  "chase.com",
  "bankofamerica.com",
  "wellsfargo.com",
  "citi.com",
  "citibank.com",
  "usbank.com",
  "pnc.com",
  "truist.com",
  "capitalone.com",
  "tdbank.com",
  "schwab.com",
  "fidelity.com",
  "americanexpress.com",
  "discover.com",
  "ally.com",
  "usaa.com",
  "navyfederal.org",
  "regions.com",
  "key.com",
  "citizensbank.com",
  "53.com",
  "huntington.com",
  "svb.com",
  "mercury.com",
  "brex.com",
  "hsbc.com",
  "barclays.co.uk",
  "rbcroyalbank.com",
  "td.com",
  "scotiabank.com",
  "bmo.com",
  // Payment services
  "paypal.com",
  "venmo.com",
  "stripe.com",
  "squareup.com",
  "cash.app",
  "zellepay.com",
  "wise.com",
  "payoneer.com",
  "adyen.com",
  "braintreegateway.com",
  "authorize.net",
  "coinbase.com",
  // Email accounts
  "mail.google.com",
  "gmail.com",
  "outlook.com",
  "outlook.live.com",
  "outlook.office.com",
  "outlook.office365.com",
  "hotmail.com",
  "mail.yahoo.com",
  "mail.aol.com",
  "icloud.com",
  "proton.me",
  "protonmail.com",
  "mail.zoho.com",
  // Identity providers
  "accounts.google.com",
  "myaccount.google.com",
  "login.microsoftonline.com",
  "login.microsoft.com",
  "login.live.com",
  "account.microsoft.com",
  "appleid.apple.com",
  "idmsa.apple.com",
  "login.yahoo.com",
  "okta.com",
  "oktapreview.com",
  "onelogin.com",
  "duosecurity.com",
  "jumpcloud.com",
  "pingidentity.com",
  "login.gov",
  "id.me",
] as const;

/** The listed domain `host` is, or is under; null when it is on none. Ports and `*.` are ignored. */
export function blockedHost(host: string): string | null {
  const h = host.trim().toLowerCase().replace(/^\*\./, "").replace(/:\d+$/, "").replace(/\.$/, "");
  return BLOCKED_HOSTS.find((d) => h === d || h.endsWith(`.${d}`)) ?? null;
}

/** Whether an address is on a listed site; anything that is not a web address is not. */
export function onBlockedSite(address: string): boolean {
  let host: string;
  try {
    host = new URL(address).hostname;
  } catch {
    return false;
  }
  return blockedHost(host) !== null;
}
