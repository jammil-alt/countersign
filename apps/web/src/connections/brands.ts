// Connector marks: how each connector's tile looks wherever it is listed (ConnectorMark).
//
// DECISION (docs/plan.md §1.85): the owner's logo files come first (IMAGES, below). Otherwise a
// provider's own logo where one is published under CC0 (Simple
// Icons 16.37.0, its `path` on a 24px grid), drawn in the provider's colour on a solid white tile
// with a hairline border, in both themes, as the providers' own app icons are (the logos have
// cut-outs, which must show white, never the tile behind); a provider whose logo is not in that set (removed at the brand's request) gets its
// initials on the brand's colour instead of a copied logo. Connectors we build ourselves (bank
// feeds, uploads, email sending) take a Mezonas icon, since they carry no third-party brand. These
// colours belong to the providers' marks, not to our palette: nothing else uses them.
import type { IconName } from "../ui/icons";
import billLogo from "./logos/bill.png?no-inline";
import bingLogo from "./logos/bing.svg?no-inline";
import gmailLogo from "./logos/gmail.svg?no-inline";
import googleLogo from "./logos/google.svg?no-inline";
import googleChatLogo from "./logos/google-chat.svg?no-inline";
import googleDriveLogo from "./logos/google-drive.svg?no-inline";
import googleSheetsLogo from "./logos/google-sheets.svg?no-inline";
import hubspotLogo from "./logos/hubspot.svg?no-inline";
import linkedinLogo from "./logos/linkedin.svg?no-inline";
import outlookLogo from "./logos/outlook.svg?no-inline";
import podioLogo from "./logos/podio.svg?no-inline";
import quickbooksLogo from "./logos/quickbooks.svg?no-inline";
import rampLogo from "./logos/ramp.svg?no-inline";
import slackLogo from "./logos/slack.svg?no-inline";
import stripeLogo from "./logos/stripe.svg?no-inline";
import whatsappLogo from "./logos/whatsapp.svg?no-inline";
import zohoLogo from "./logos/zoho.svg?no-inline";

export type ConnectorBrand =
  /** The provider's full-colour logo file, on white (the owner's files, 2026-11-11). */
  | { kind: "image"; src: string }
  /** The provider's logo in its colour, on white. */
  | { kind: "logo"; fill: string; path: string }
  /** The provider's initials on its colour; `fill: null` is ink on paper. */
  | { kind: "monogram"; fill: string | null; letters: string }
  /** One of ours: a Mezonas icon. */
  | { kind: "icon"; icon: IconName };

// DECISION (owner, 2026-11-11, extended 2026-11-12): the owner's logo files (the same set as the
// site's, apps/site/src/logos) win over the one-colour Simple Icons paths and the initials, in the
// back office and the portal alike. Search Console takes Google's "G". BILL's file is the site's
// PNG, shrunk for a tile. Imported `?no-inline`, so each is its own file, not inlined into the
// first-load script (scripts/web-size.mjs). google-ads.svg is kept for a Google Ads connector, which doesn't exist yet.
const IMAGES: Record<string, string> = {
  qbo: quickbooksLogo,
  gmail: gmailLogo,
  gdrive: googleDriveLogo,
  gsheets: googleSheetsLogo,
  gchat: googleChatLogo,
  gsc: googleLogo,
  gsc_oauth: googleLogo,
  hubspot: hubspotLogo,
  whatsapp_meta: whatsappLogo,
  stripe: stripeLogo,
  slack: slackLogo,
  outlook: outlookLogo,
  zoho_crm: zohoLogo,
  linkedin: linkedinLogo,
  bing_webmaster: bingLogo,
  ramp: rampLogo,
  billcom: billLogo,
  podio: podioLogo,
};

const LOGOS: Record<string, { fill: string; path: string }> = {
  hackernews: {
    fill: "#FF6600",
    path: "M0 24V0h24v24H0zM6.951 5.896l4.112 7.708v5.064h1.583v-4.972l4.148-7.799h-1.749l-2.457 4.875c-.372.745-.688 1.434-.688 1.434s-.297-.708-.651-1.434L8.831 5.896h-1.88z",
  },
  elevenlabs: { fill: "#000000", path: "M4.6035 0v24h4.9317V0zm9.8613 0v24h4.9317V0z" },
};

// A provider with no logo file and no published path: its initials (none today).
const MONOGRAMS: Record<string, { fill: string | null; letters: string }> = {};

const ICONS: Record<string, IconName> = {
  bankfeed: "bank",
  upload: "upload",
  resend: "email",
  twilio: "message",
  webhook: "arrow",
  website: "report",
  browser: "sidebar",
  testkit: "settings",
};

/** The mark for a connector id, or null (the tile then shows the name's initials). */
export function connectorBrand(connector: string | undefined): ConnectorBrand | null {
  if (!connector) return null;
  const image = IMAGES[connector];
  if (image) return { kind: "image", src: image };
  const logo = LOGOS[connector];
  if (logo) return { kind: "logo", ...logo };
  const monogram = MONOGRAMS[connector];
  if (monogram) return { kind: "monogram", ...monogram };
  const icon = ICONS[connector];
  if (icon) return { kind: "icon", icon };
  return null;
}
