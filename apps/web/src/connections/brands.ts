// Connector marks: how each connector's tile looks wherever it is listed (ConnectorMark).
//
// DECISION (docs/plan.md §1.85): a provider's own logo where one is published under CC0 (Simple
// Icons 16.37.0, its `path` on a 24px grid), drawn in the provider's colour on a solid white tile
// with a hairline border, in both themes, as the providers' own app icons are (the logos have
// cut-outs, which must show white, never the tile behind); a provider whose logo is not in that set (removed at the brand's request) gets its
// initials on the brand's colour instead of a copied logo. Connectors we build ourselves (bank
// feeds, uploads, email sending) take a Mezonas icon, since they carry no third-party brand. These
// colours belong to the providers' marks, not to our palette: nothing else uses them.
import type { IconName } from "../ui/icons";
import googleLogo from "./logos/google.svg";
import googleDriveLogo from "./logos/google-drive.svg";
import googleSheetsLogo from "./logos/google-sheets.svg";
import whatsappLogo from "./logos/whatsapp.svg";

export type ConnectorBrand =
  /** The provider's full-colour logo file, on white (the owner's files, 2026-11-11). */
  | { kind: "image"; src: string }
  /** The provider's logo in its colour, on white. */
  | { kind: "logo"; fill: string; path: string }
  /** The provider's initials on its colour; `fill: null` is ink on paper. */
  | { kind: "monogram"; fill: string | null; letters: string }
  /** One of ours: a Mezonas icon. */
  | { kind: "icon"; icon: IconName };

// DECISION (owner, 2026-11-11): the owner's full-colour logo files win over the one-colour
// Simple Icons paths. Search Console takes Google's "G". google-ads.svg is kept for a Google Ads
// connector, which doesn't exist yet.
const IMAGES: Record<string, string> = {
  gdrive: googleDriveLogo,
  gsheets: googleSheetsLogo,
  gsc: googleLogo,
  gsc_oauth: googleLogo,
  whatsapp_meta: whatsappLogo,
};

const LOGOS: Record<string, { fill: string; path: string }> = {
  qbo: {
    fill: "#2CA01C",
    path: "M12 0A12 12 0 0 0 0 12a12 12 0 0 0 12 12 12 12 0 0 0 12-12A12 12 0 0 0 12 0zm.642 4.1335c.9554 0 1.7296.776 1.7296 1.7332v9.0667h1.6c1.614 0 2.9275-1.3156 2.9275-2.933 0-1.6173-1.3136-2.9333-2.9276-2.9333h-.6654V7.3334h.6654c2.5722 0 4.6577 2.0897 4.6577 4.667 0 2.5774-2.0855 4.6666-4.6577 4.6666H12.642zM7.9837 7.333h3.3291v12.533c-.9555 0-1.73-.7759-1.73-1.7332V9.0662H7.9837c-1.6146 0-2.9277 1.316-2.9277 2.9334 0 1.6175 1.3131 2.9333 2.9277 2.9333h.6654v1.7332h-.6654c-2.5725 0-4.6577-2.0892-4.6577-4.6665 0-2.5771 2.0852-4.6666 4.6577-4.6666Z",
  },
  gmail: {
    fill: "#EA4335",
    path: "M24 5.457v13.909c0 .904-.732 1.636-1.636 1.636h-3.819V11.73L12 16.64l-6.545-4.91v9.273H1.636A1.636 1.636 0 0 1 0 19.366V5.457c0-2.023 2.309-3.178 3.927-1.964L5.455 4.64 12 9.548l6.545-4.91 1.528-1.145C21.69 2.28 24 3.434 24 5.457z",
  },
  gchat: {
    fill: "#00AC47",
    path: "M1.637 0C.733 0 0 .733 0 1.637v16.5c0 .904.733 1.636 1.637 1.636h3.955v3.323c0 .804.97 1.207 1.539.638l3.963-3.96h11.27c.903 0 1.636-.733 1.636-1.637V5.592L18.408 0Zm3.955 5.592h12.816v8.59H8.455l-2.863 2.863Z",
  },
  hubspot: {
    fill: "#FF7A59",
    path: "M18.164 7.93V5.084a2.198 2.198 0 001.267-1.978v-.067A2.2 2.2 0 0017.238.845h-.067a2.2 2.2 0 00-2.193 2.193v.067a2.196 2.196 0 001.252 1.973l.013.006v2.852a6.22 6.22 0 00-2.969 1.31l.012-.01-7.828-6.095A2.497 2.497 0 104.3 4.656l-.012.006 7.697 5.991a6.176 6.176 0 00-1.038 3.446c0 1.343.425 2.588 1.147 3.607l-.013-.02-2.342 2.343a1.968 1.968 0 00-.58-.095h-.002a2.033 2.033 0 102.033 2.033 1.978 1.978 0 00-.1-.595l.005.014 2.317-2.317a6.247 6.247 0 104.782-11.134l-.036-.005zm-.964 9.378a3.206 3.206 0 113.215-3.207v.002a3.206 3.206 0 01-3.207 3.207z",
  },
  hackernews: {
    fill: "#FF6600",
    path: "M0 24V0h24v24H0zM6.951 5.896l4.112 7.708v5.064h1.583v-4.972l4.148-7.799h-1.749l-2.457 4.875c-.372.745-.688 1.434-.688 1.434s-.297-.708-.651-1.434L8.831 5.896h-1.88z",
  },
  elevenlabs: { fill: "#000000", path: "M4.6035 0v24h4.9317V0zm9.8613 0v24h4.9317V0z" },
  stripe: {
    fill: "#635BFF",
    path: "M13.976 9.15c-2.172-.806-3.356-1.426-3.356-2.409 0-.831.683-1.305 1.901-1.305 2.227 0 4.515.858 6.09 1.631l.89-5.494C18.252.975 15.697 0 12.165 0 9.667 0 7.589.654 6.104 1.872 4.56 3.147 3.757 4.992 3.757 7.218c0 4.039 2.467 5.76 6.476 7.219 2.585.92 3.445 1.574 3.445 2.583 0 .98-.84 1.545-2.354 1.545-1.875 0-4.965-.921-6.99-2.109l-.9 5.555C5.175 22.99 8.385 24 11.714 24c2.641 0 4.843-.624 6.328-1.813 1.664-1.305 2.525-3.236 2.525-5.732 0-4.128-2.524-5.851-6.594-7.305h.003z",
  },
};

const MONOGRAMS: Record<string, { fill: string | null; letters: string }> = {
  // Zoho's logo is its four-letter wordmark, too small to read on a tile.
  zoho_crm: { fill: "#E42527", letters: "Z" },
  slack: { fill: "#4A154B", letters: "S" },
  linkedin: { fill: "#0A66C2", letters: "in" },
  outlook: { fill: "#0078D4", letters: "O" },
  bing_webmaster: { fill: "#258FFA", letters: "B" },
  ramp: { fill: null, letters: "R" },
  // §1.87: BILL's logo isn't in Simple Icons; ink, as we aren't sure of its colour.
  billcom: { fill: null, letters: "B" },
  podio: { fill: null, letters: "P" },
};

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
