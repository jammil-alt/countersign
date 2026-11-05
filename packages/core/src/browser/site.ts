// Browser connections (ARCHITECTURE §6.10, docs/plan.md §1.26 phase 3): a site profile as the
// operator writes it (`browser_site_version.profile`), a client's browser connection, the URL rules
// every page an agent opens must pass, and the risk tier rules. Pure: the browser connector
// (packages/connectors/src/browser) applies them, the API validates with them, the back office
// edits with them.

import { z } from "zod";
import { CodesIdentityId, CodesPattern, CodesSender } from "../codes/service";

// ── Tiers ────────────────────────────────────────────────────────────────────────────────────────

export const BROWSER_TIERS = ["low", "medium", "high", "blocked"] as const;
export const BrowserTier = z.enum(BROWSER_TIERS);
export type BrowserTier = z.infer<typeof BrowserTier>;

const TIER_RANK: Record<BrowserTier, number> = { low: 0, medium: 1, high: 2, blocked: 3 };

/** The stricter of two tiers. */
export function stricterTier(a: BrowserTier, b: BrowserTier): BrowserTier {
  return TIER_RANK[a] >= TIER_RANK[b] ? a : b;
}

/**
 * What a client made stricter for itself on one browser connection (never looser): no writes at
 * all, or sign-in by a person only (which treats the site as high tier for that client).
 */
export const BrowserStricter = z.strictObject({
  noWrites: z.boolean().default(false),
  personSignIn: z.boolean().default(false),
});
export type BrowserStricter = z.infer<typeof BrowserStricter>;

/** True when `next` turns off something `current` has on (a client may only tighten). */
export function stricterLoosening(current: BrowserStricter, next: BrowserStricter): string[] {
  return (["noWrites", "personSignIn"] as const).filter((k) => current[k] && !next[k]);
}

/** The tier a client's connection works at: the site's live tier, made stricter by the client. */
export function effectiveTier(site: BrowserTier, stricter?: Partial<BrowserStricter>): BrowserTier {
  return stricter?.personSignIn ? stricterTier(site, "high") : site;
}

export type SignInDecision =
  | { ok: true }
  | { ok: false; code: "blocked" | "needs_person"; reason: string };

/**
 * Whether our code may sign in on its own (the tier table in ARCHITECTURE §6.10): low and medium
 * yes; high needs a person through Browser Run's human handoff, which is not built yet; blocked
 * never.
 */
export function signInDecision(
  site: BrowserTier,
  stricter?: Partial<BrowserStricter>,
): SignInDecision {
  const tier = effectiveTier(site, stricter);
  if (tier === "blocked") {
    return {
      ok: false,
      code: "blocked",
      reason: "agents never sign in to this site (blocked tier)",
    };
  }
  if (tier === "high") {
    return {
      ok: false,
      code: "needs_person",
      reason:
        site === "high"
          ? "a person must sign in to this site (high tier); signing in by a person is not available yet"
          : "you asked for a person to sign in to this site; signing in by a person is not available yet",
    };
  }
  return { ok: true };
}

/**
 * The most a write through a browser connection may be (the tier table): `off` (blocked tier, or
 * the client turned writes off), `approval` (medium and high: always approved), or `matrix` (low:
 * as the connection's matrix allows, approval by default like any connection).
 */
export function browserWriteCeiling(
  site: BrowserTier,
  stricter?: Partial<BrowserStricter>,
): "off" | "approval" | "matrix" {
  if (site === "blocked" || stricter?.noWrites) return "off";
  return effectiveTier(site, stricter) === "low" ? "matrix" : "approval";
}

/** Only low-tier sites may keep a session (cookies, encrypted in the vault) between sign-ins. */
export function mayKeepSession(
  site: BrowserTier,
  stricter: Partial<BrowserStricter> | undefined,
  profile: Pick<BrowserSiteProfile, "session">,
): boolean {
  return effectiveTier(site, stricter) === "low" && profile.session.keep;
}

// ── URLs ─────────────────────────────────────────────────────────────────────────────────────────

/** The WHATWG URL every runtime core runs in has (core has no DOM or Node types on purpose). */
interface WebUrl {
  protocol: string;
  host: string;
  hostname: string;
  origin: string;
  pathname: string;
  search: string;
  username: string;
  password: string;
}
const WebURL = (globalThis as unknown as { URL: new (url: string) => WebUrl }).URL;

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * Pages are https, or plain http on this machine only (the tests' fixture sites).
 */
// DECISION: http is accepted for loopback hosts only, so tests can serve fixture sites; every real
// site is https. A loopback site in a deployment simply finds nothing to open.
function schemeOk(u: WebUrl): boolean {
  return u.protocol === "https:" || (u.protocol === "http:" && LOOPBACK.has(u.hostname));
}

function parseUrl(value: string): WebUrl | null {
  try {
    return new WebURL(value);
  } catch {
    return null;
  }
}

/** An origin exactly as `new URL(x).origin` writes it: scheme, host and port, no path. */
export const BrowserOrigin = z
  .string()
  .trim()
  .max(200)
  .refine((v) => {
    const u = parseUrl(v);
    return u !== null && schemeOk(u) && u.origin === v;
  }, "an origin such as https://portal.example.com (https, no path)");

export const BrowserUrl = z
  .string()
  .trim()
  .max(2000)
  .refine((v) => {
    const u = parseUrl(v);
    return u !== null && schemeOk(u) && !u.username && !u.password;
  }, "an https address");

/**
 * A page pattern: `*` stands for any run of characters, matched without regard to case. A pattern
 * starting with `/` or `*` is matched against the path and query (`/invoices/*`); any other is a
 * whole address (`https://portal.example.com/invoices/*`). Fragments are ignored.
 */
export const UrlPattern = z.string().trim().min(1).max(500);

/**
 * Allowed patterns name their origin outright (no `*` before the path), so an allow list can never
 * reach a host the operator didn't write down.
 */
export const AllowPattern = UrlPattern.refine((p) => {
  const m = /^(https?:\/\/[^/*?#]+)(\/.*)?$/i.exec(p);
  if (!m?.[1]) return false;
  const u = parseUrl(m[1]);
  return u !== null && schemeOk(u) && u.origin === m[1].toLowerCase();
}, "an allowed page starts with its site's address, e.g. https://portal.example.com/invoices/*");

/**
 * Pages agents never open, on any site, whatever its profile says: settings, passwords, users and
 * permissions, billing and payment, deletion. Matched against the path and query.
 */
export const BROWSER_DEFAULT_BLOCKED = [
  "*setting*",
  "*password*",
  "*passwd*",
  "*/users*",
  "*/user-management*",
  "*permission*",
  "*/roles*",
  "*billing*",
  "*payment*",
  "*delete*",
] as const;

function globRegExp(pattern: string): RegExp {
  const body = pattern
    .split("*")
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*");
  return new RegExp(`^${body}$`, "i");
}

function decoded(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/** Whether a URL matches one pattern (see UrlPattern). */
export function urlMatches(pattern: string, url: string): boolean {
  const u = parseUrl(url);
  if (!u) return false;
  const pathAndQuery = `${u.pathname}${u.search}`;
  const target =
    pattern.startsWith("/") || pattern.startsWith("*")
      ? pathAndQuery
      : `${u.origin}${u.pathname}${u.search}`;
  const re = globRegExp(pattern);
  // Both as written and percent-decoded, so `%70assword` is still a password page.
  return re.test(target) || re.test(decoded(target));
}

export type UrlCheck =
  | { ok: true; url: string }
  | {
      ok: false;
      code: "invalid" | "scheme" | "blocked" | "not_allowed";
      reason: string;
    };

/**
 * Whether an agent may open this page on this site: a valid https address with no credentials in
 * it, matching none of the platform's blocked pages or the site's, and one of the site's allowed
 * pages. Called before every navigation and again on the address the browser ends up at.
 */
export function checkBrowserUrl(
  url: string,
  rules: Pick<BrowserSiteProfile, "allow" | "block">,
): UrlCheck {
  const u = parseUrl(url);
  if (!u) return { ok: false, code: "invalid", reason: "not a web address" };
  if (!schemeOk(u) || u.username || u.password) {
    return { ok: false, code: "scheme", reason: "only https pages without a login in the address" };
  }
  const href = `${u.origin}${u.pathname}${u.search}`;
  const blocked = [...BROWSER_DEFAULT_BLOCKED, ...rules.block].find((p) => urlMatches(p, href));
  if (blocked) {
    return { ok: false, code: "blocked", reason: `agents never open this page (${blocked})` };
  }
  if (!rules.allow.some((p) => urlMatches(p, href))) {
    return { ok: false, code: "not_allowed", reason: "this page is not one agents may open" };
  }
  return { ok: true, url: href };
}

/** The host (and port) of an address, or null when it is not one. */
export function urlHost(url: string): string | null {
  return parseUrl(url)?.host ?? null;
}

/** Whether `url` is on one of the login origins exactly (scheme, host and port). */
export function onLoginOrigin(url: string, origins: readonly string[]): boolean {
  const u = parseUrl(url);
  return u !== null && origins.includes(u.origin);
}

// ── The site profile (one `browser_site_version`) ────────────────────────────────────────────────

export const CssSelector = z.string().trim().min(1).max(300);

const CodeEntry = {
  /** Where the code is typed, and the button that sends it. */
  codeField: CssSelector,
  codeButton: CssSelector,
};

/**
 * How the site asks for a second factor: none, an authenticator code (the code service computes
 * it), or a code by text or email (the code service reads it out of the message with `pattern`).
 */
export const BrowserSecondFactor = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("none") }),
  z.strictObject({ kind: z.literal("totp"), ...CodeEntry }),
  z.strictObject({
    kind: z.literal("sms"),
    sender: CodesSender,
    pattern: CodesPattern,
    ...CodeEntry,
  }),
  z.strictObject({
    kind: z.literal("email"),
    sender: CodesSender,
    pattern: CodesPattern,
    ...CodeEntry,
  }),
]);
export type BrowserSecondFactor = z.infer<typeof BrowserSecondFactor>;

/** How to tell the agent is signed in: the address it lands on, an element on the page, or both. */
export const BrowserSignedInCheck = z
  .strictObject({ url: UrlPattern.optional(), selector: CssSelector.optional() })
  .refine((c) => c.url !== undefined || c.selector !== undefined, "a URL pattern or a selector");

// DECISION: selectors are named `usernameField`, `passwordField` and `submitButton` (not
// `password`): core's contract refuses response fields named like a secret, and the back office
// reads profiles back.
export const BrowserLogin = z.strictObject({
  url: BrowserUrl,
  /** The only origins credentials and codes are ever typed into. */
  origins: z.array(BrowserOrigin).min(1).max(5),
  usernameField: CssSelector,
  passwordField: CssSelector,
  submitButton: CssSelector,
  secondFactor: BrowserSecondFactor,
  signedIn: BrowserSignedInCheck,
  /**
   * Elements that mean "stop and ask a person" on this site, beside the platform's own CAPTCHA and
   * unusual-activity checks.
   */
  stopSelectors: z.array(CssSelector).max(20).default([]),
});
export type BrowserLogin = z.infer<typeof BrowserLogin>;

export const BrowserSignOut = z
  .strictObject({ url: BrowserUrl.optional(), selector: CssSelector.optional() })
  .refine((s) => s.url !== undefined || s.selector !== undefined, "a sign-out URL or a selector");

export const BrowserSiteProfile = z
  .strictObject({
    login: BrowserLogin,
    signOut: BrowserSignOut,
    /** Pages agents may open (one at least). */
    allow: z.array(AllowPattern).min(1).max(50),
    /** Pages agents never open, beside the platform's defaults (BROWSER_DEFAULT_BLOCKED). */
    block: z.array(UrlPattern).max(50).default([]),
    /** Keep the session between sign-ins (low tier only, encrypted in the vault). */
    session: z.strictObject({ keep: z.boolean().default(false) }).default({ keep: false }),
    /** For the operator: terms checked, by whom, anything odd about the site. */
    notes: z.string().max(2000).default(""),
  })
  .superRefine((p, ctx) => {
    if (!onLoginOrigin(p.login.url, p.login.origins)) {
      ctx.addIssue({
        code: "custom",
        message: "the login page must be on one of the login origins",
        path: ["login", "url"],
      });
    }
    if (p.signOut.url && !onLoginOrigin(p.signOut.url, p.login.origins)) {
      ctx.addIssue({
        code: "custom",
        message: "the sign-out page must be on one of the login origins",
        path: ["signOut", "url"],
      });
    }
  })
  .meta({ id: "BrowserSiteProfile" });
export type BrowserSiteProfile = z.infer<typeof BrowserSiteProfile>;
export type BrowserSiteProfileInput = z.input<typeof BrowserSiteProfile>;

export const BrowserSiteSlug = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]{0,62}$/, "lowercase letters, digits and dashes");

/** A site as a run needs it: the live tier and the pinned version's profile. */
export interface PinnedBrowserSite {
  slug: string;
  name: string;
  tier: BrowserTier;
  versionId: string;
  version: number;
  profile: BrowserSiteProfile;
}

// ── A client's browser connection (`connection.config` of connector `browser`) ──────────────────

export const BROWSER_SIGN_INS_PER_DAY = 10;

const HourMinute = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "HH:MM");

export const BrowserCaps = z.strictObject({
  signInsPerDay: z.number().int().min(1).max(100).default(BROWSER_SIGN_INS_PER_DAY),
  /** Sign in only between these times (in `timezone`); null = any time. */
  hours: z
    .strictObject({ start: HourMinute, end: HourMinute, timezone: z.string().min(1).max(64) })
    .nullable()
    .default(null),
});
export type BrowserCaps = z.infer<typeof BrowserCaps>;

/** The non-secret part of a browser connection: which site, which version, which identity. */
export const BrowserConnectionConfig = z.object({
  site: BrowserSiteSlug,
  siteVersionId: z.uuid(),
  /** The agent identity in the code service (not secret), and its address and number to show. */
  identity: z
    .object({ id: CodesIdentityId, email: z.string(), phone: z.string().nullable() })
    .nullable(),
  stricter: BrowserStricter.default({ noWrites: false, personSignIn: false }),
  caps: BrowserCaps.default({ signInsPerDay: BROWSER_SIGN_INS_PER_DAY, hours: null }),
});
export type BrowserConnectionConfig = z.infer<typeof BrowserConnectionConfig>;

/**
 * Sign-in counters and stops (`connection.config.browserState`): sign-ins today (UTC), failed
 * sign-ins in a row, and why sign-ins stopped (two failures, a CAPTCHA, an unexpected page).
 */
export const BrowserConnectionState = z.object({
  day: z.string(),
  signIns: z.number().int().min(0),
  failures: z.number().int().min(0),
  stopped: z.object({ reason: z.string(), at: z.string() }).nullable(),
});
export type BrowserConnectionState = z.infer<typeof BrowserConnectionState>;

/** Two failed sign-ins in a row stop the connection, so the client's account is never locked. */
export const BROWSER_MAX_FAILURES = 2;

export function emptyBrowserState(day: string): BrowserConnectionState {
  return { day, signIns: 0, failures: 0, stopped: null };
}

/** The minutes since midnight of `at` in `timezone` (UTC when the zone is unknown). */
function minutesIn(at: Date, timezone: string): number {
  try {
    const parts = new Intl.DateTimeFormat("en-GB", {
      timeZone: timezone,
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).formatToParts(at);
    const h = Number(parts.find((p) => p.type === "hour")?.value ?? "0");
    const m = Number(parts.find((p) => p.type === "minute")?.value ?? "0");
    return h * 60 + m;
  } catch {
    return at.getUTCHours() * 60 + at.getUTCMinutes();
  }
}

const toMinutes = (hm: string) => Number(hm.slice(0, 2)) * 60 + Number(hm.slice(3, 5));

export type CapCheck =
  | { ok: true }
  | { ok: false; code: "stopped" | "hours" | "daily_cap"; reason: string };

/** Whether another sign-in may start now (checked in code before every sign-in). */
export function signInAllowed(
  caps: BrowserCaps,
  state: BrowserConnectionState,
  at: Date,
): CapCheck {
  if (state.stopped) {
    return {
      ok: false,
      code: "stopped",
      reason: `sign-ins are stopped until a person checks the account: ${state.stopped.reason}`,
    };
  }
  if (caps.hours) {
    const now = minutesIn(at, caps.hours.timezone);
    const start = toMinutes(caps.hours.start);
    const end = toMinutes(caps.hours.end);
    const inside = start <= end ? now >= start && now < end : now >= start || now < end;
    if (!inside) {
      return {
        ok: false,
        code: "hours",
        reason: `sign-ins are allowed only between ${caps.hours.start} and ${caps.hours.end}`,
      };
    }
  }
  const today = at.toISOString().slice(0, 10);
  const used = state.day === today ? state.signIns : 0;
  if (used >= caps.signInsPerDay) {
    return {
      ok: false,
      code: "daily_cap",
      reason: `this connection already signed in ${used} times today (the limit is ${caps.signInsPerDay})`,
    };
  }
  return { ok: true };
}
