import { z } from "zod";
import { BrowserSiteProfile, BrowserSiteSlug, BrowserStricter, BrowserTier } from "../browser/site";
import { isUuid } from "../ids";
import { defineRoute } from "./contract";

// Browser connections, phase 3 of Access (ARCHITECTURE §6.10, docs/plan.md §1.26). The operator
// keeps the catalogue of sites agents may sign in to (each change of the login steps or URL rules
// is a new, immutable version; the tier is set on its own, with a note of who checked the site's
// terms). The client admin sets up a browser connection on an offered site from the Access page:
// it names the site and pins its current version, gets an agent identity in the code service, and
// takes the agent account's login through the write-only credentials route. The client may make a
// connection stricter (no writes, sign-in by a person only), never looser.

const Id = z.string().refine((v) => isUuid(v), "not an id");
const OPS = ["operator"] as const;

export const BrowserSiteVersionView = z.object({
  id: z.string(),
  version: z.number().int(),
  profile: BrowserSiteProfile,
  changeNote: z.string().nullable(),
  createdAt: z.string(),
});

export const BrowserSiteView = z.object({
  id: z.string(),
  slug: z.string(),
  name: z.string(),
  tier: BrowserTier,
  notes: z.string(),
  updatedAt: z.string(),
  /** The newest version: what new connections pin. */
  current: BrowserSiteVersionView,
  versions: z.number().int(),
  /** Client connections on this site, among the clients this operator serves. */
  connections: z.number().int(),
});
export type BrowserSiteView = z.infer<typeof BrowserSiteView>;

/** Notes are required when the tier is set: who checked the site's terms, and when. */
const TierNotes = z.string().trim().min(3).max(2000);

export const CreateBrowserSite = z.strictObject({
  slug: BrowserSiteSlug,
  name: z.string().trim().min(1).max(120),
  tier: BrowserTier,
  notes: TierNotes,
  profile: BrowserSiteProfile,
});
export const NewBrowserSiteVersion = z.strictObject({
  profile: BrowserSiteProfile,
  changeNote: z.string().trim().max(500).optional(),
});
export const SetBrowserSiteTier = z.strictObject({ tier: BrowserTier, notes: TierNotes });

/** A site the client admin may set a browser connection up on (never a blocked one). */
export const BrowserSiteOffer = z.object({
  slug: z.string(),
  name: z.string(),
  tier: BrowserTier,
  /** How the site sends its second factor, so the form can ask for an authenticator key. */
  secondFactor: z.enum(["none", "totp", "sms", "email"]),
});
export type BrowserSiteOffer = z.infer<typeof BrowserSiteOffer>;

/** What the Access page shows of a browser login beside the usual vault item. */
export const BrowserVaultInfo = z.object({
  site: z.object({ slug: z.string(), name: z.string(), tier: BrowserTier }),
  /** The site's tier made stricter by the client. */
  effectiveTier: BrowserTier,
  siteVersion: z.number().int().nullable(),
  /** The agent identity's address and number, for the agent account on the site. */
  identity: z.object({ email: z.string(), phone: z.string().nullable() }).nullable(),
  stricter: BrowserStricter,
  signInsPerDay: z.number().int(),
  signInsToday: z.number().int(),
  /** Why sign-ins stopped (two failures, a CAPTCHA, an unexpected page); null while working. */
  stopped: z.object({ reason: z.string(), at: z.string() }).nullable(),
});
export type BrowserVaultInfo = z.infer<typeof BrowserVaultInfo>;

export const SetUpBrowserConnection = z.strictObject({
  site: BrowserSiteSlug,
  /**
   * For sites whose second factor is an authenticator app: the `otpauth://` link the site shows
   * when the agent account turns it on. Passed straight to the code service, never stored here.
   */
  authenticator: z.string().trim().max(2048).optional(),
});
export type SetUpBrowserConnection = z.infer<typeof SetUpBrowserConnection>;

export const SetBrowserStricter = BrowserStricter;

const SlugParam = z.object({ slug: BrowserSiteSlug });

export const browserRoutes = {
  opsBrowserSites: defineRoute({
    method: "GET",
    path: "/api/ops/browser-sites",
    auth: "session",
    roles: OPS,
    summary: "The catalogue of websites agents may sign in to, with each site's current version",
    response: z.object({ sites: z.array(BrowserSiteView) }),
  }),
  opsCreateBrowserSite: defineRoute({
    method: "POST",
    path: "/api/ops/browser-sites",
    auth: "session",
    roles: OPS,
    summary: "Add a site to the catalogue: its tier, the notes of who checked its terms, version 1",
    body: CreateBrowserSite,
    response: z.object({ site: BrowserSiteView }),
  }),
  opsNewBrowserSiteVersion: defineRoute({
    method: "POST",
    path: "/api/ops/browser-sites/:slug/versions",
    auth: "session",
    roles: OPS,
    summary:
      "A new version of a site's login steps and pages (connections keep the version they pinned)",
    params: SlugParam,
    body: NewBrowserSiteVersion,
    response: z.object({ site: BrowserSiteView }),
  }),
  opsSetBrowserSiteTier: defineRoute({
    method: "PUT",
    path: "/api/ops/browser-sites/:slug/tier",
    auth: "session",
    roles: OPS,
    summary:
      "Set a site's risk tier, with a note; it applies to every connection on the site at once",
    params: SlugParam,
    body: SetBrowserSiteTier,
    response: z.object({ site: BrowserSiteView }),
  }),
  portalSetUpBrowser: defineRoute({
    method: "POST",
    path: "/api/access/browser",
    auth: "session",
    roles: ["client_admin"],
    summary:
      "Set up a browser login on an offered site: pins its version and makes the agent identity",
    body: SetUpBrowserConnection,
    response: z.object({ connectionId: z.string() }),
  }),
  portalSetBrowserStricter: defineRoute({
    method: "PUT",
    path: "/api/access/browser/:connectionId",
    auth: "session",
    roles: ["client_admin"],
    summary: "Make a browser login stricter: no writes, or sign-in by a person only (never looser)",
    params: z.object({ connectionId: Id }),
    body: SetBrowserStricter,
    response: z.object({ connectionId: z.string() }),
  }),
} as const;
