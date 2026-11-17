// The branded email layout (docs/cases-plan.md §4.4; docs/plan.md §1.125): one layout for
// everything the client sees from us: the Mezonas logo (a PNG hosted with the app; mail clients
// drop SVG), the design system's colours and type, borders not shadows, a plain-text part,
// readable in light and dark mail clients, six languages. Notification emails move onto it after.
//
// Stream EMAIL builds this (cases-plan O1); until then `renderBrandedEmail` throws.

import type { Locale } from "../i18n/locale";

/** One email as sent: the subject, the plain-text part and the HTML part. */
export interface RenderedEmail {
  subject: string;
  text: string;
  html: string;
}

/** A block of the email's body, in order. Text is escaped by the layout; no raw HTML goes in. */
export type BrandedBlock =
  | { kind: "heading"; text: string }
  | { kind: "paragraph"; text: string }
  /** The lead's own note, quoted, with who wrote it. */
  | { kind: "note"; text: string; from: string }
  /** The one button. */
  | { kind: "button"; label: string; href: string }
  /** Small print: the security line, when the link expires. */
  | { kind: "small"; text: string };

export interface BrandedEmailInput {
  locale: Locale;
  subject: string;
  /** The line mail clients show beside the subject. */
  preheader?: string;
  /** Who it's from, shown at the top: the lead's name and photo (an https URL), or Mezonas. */
  from: { name: string; photoUrl: string | null };
  blocks: readonly BrandedBlock[];
  /** The app's origin, for the hosted logo. */
  origin: string;
}

/** Renders the branded layout around `blocks`. */
// Stream EMAIL builds this (cases-plan O1).
export function renderBrandedEmail(_input: BrandedEmailInput): RenderedEmail {
  throw new Error("renderBrandedEmail is not built yet (stream EMAIL, docs/plan.md §1.125)");
}
