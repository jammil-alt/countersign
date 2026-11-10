// One browser session for one tool call (docs/plan.md §1.26 "Sessions and stops"): check the
// tier, the caps and the stop; sign in by code (or reuse a kept low-tier session); do the work on
// allowed pages only; then always sign out (or keep the session, low tier only) and close the
// browser, in a finally block; and record what happened on the connection's log.

import {
  BROWSER_MAX_FAILURES,
  type BrowserConnectionConfig,
  type BrowserConnectionState,
  browserSiteHosts,
  BrowserConnectionConfig as ConfigSchema,
  checkBrowserUrl,
  emptyBrowserState,
  type JsonObject,
  mayKeepSession,
  type PinnedBrowserSite,
  signInAllowed,
  signInDecision,
} from "@countersign/core";
import { z } from "zod";
import type { ToolContext } from "../connector";
import type { BrowserCookie, BrowserDownload, BrowserTable } from "./driver";
import { checkBrowsePage } from "./scope";
import type { BrowserServices, BrowserSessionRecord } from "./services";
import {
  BrowserRefused,
  BrowserStop,
  checkForStops,
  isSignedIn,
  SignInFailed,
  signIn,
  signOut,
} from "./sign-in";

/** The agent account's login and, on low-tier sites that keep it, the session's cookies. */
const StoredLogin = z.object({
  username: z.string().min(1),
  password: z.string().min(1),
  session: z
    .object({
      cookies: z.array(z.record(z.string(), z.unknown())),
      savedAt: z.string(),
    })
    .optional(),
});
type StoredLogin = z.infer<typeof StoredLogin>;

export interface BrowserSessionOptions {
  /** Claiming a code: every `intervalMs`, at most `attempts` times. */
  codePoll: { intervalMs: number; attempts: number };
}

/** What a tool does once signed in: only through these, each page checked against the rules. */
export interface SignedInPage {
  /** Opens an allowed page; the address it ends at is checked again. Answers the final address. */
  open(url: string): Promise<string>;
  readText(): Promise<string>;
  readTables(): Promise<BrowserTable[]>;
  /** Fetches an allowed file; the address it ends at is checked again. */
  download(url: string): Promise<BrowserDownload>;
  /** Notes an action for the session's record. */
  note(action: BrowserSessionRecord["actions"][number]): void;
  /** The storage key of the last screenshot taken (after the last page opened), if any. */
  lastScreenshot(): string | null;
  site: PinnedBrowserSite;
}

/**
 * One tool call's browser session. `within` (a browsing skill's pages, ./scope.ts) narrows the
 * site's allowed pages further; with it, `url` is checked before anything opens.
 */
export interface BrowserCall {
  tool: string;
  site: string;
  url?: string | undefined;
  within?: readonly string[] | undefined;
}

const today = (at: Date) => at.toISOString().slice(0, 10);

function browserServices(ctx: ToolContext): BrowserServices {
  const services = ctx.services?.browser;
  if (!services) throw new BrowserRefused("browser logins are not available in this deployment");
  return services;
}

function configOf(ctx: ToolContext): BrowserConnectionConfig {
  const parsed = ConfigSchema.safeParse(ctx.connection.config);
  if (!parsed.success) throw new BrowserRefused("this browser login is not set up");
  return parsed.data;
}

/**
 * Replaces every secret this session handled (the password, cookie values, the code) wherever it
 * appears in what goes back to the model or a log: a page that echoes one never leaks it.
 */
export class Redactor {
  readonly #secrets = new Set<string>();
  add(value: string | null | undefined, min = 4): void {
    if (value && value.length >= min) this.#secrets.add(value);
  }
  text(value: string): string {
    let out = value;
    for (const s of this.#secrets) out = out.split(s).join("[hidden]");
    return out;
  }
  deep<T>(value: T): T {
    if (typeof value === "string") return this.text(value) as T;
    if (Array.isArray(value)) return value.map((v) => this.deep(v)) as T;
    if (value !== null && typeof value === "object" && !(value instanceof Uint8Array)) {
      return Object.fromEntries(
        Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, this.deep(v)]),
      ) as T;
    }
    return value;
  }
}

async function rolledState(services: BrowserServices, at: Date): Promise<BrowserConnectionState> {
  const state = (await services.state.get()) ?? emptyBrowserState(today(at));
  return state.day === today(at) ? state : { ...state, day: today(at), signIns: 0 };
}

/**
 * Runs `work` in a signed-in browser on the connection's site. Throws BrowserRefused, BrowserStop
 * or SignInFailed (or the work's own error) with messages that carry no secret.
 */
export async function withBrowserSession<T>(
  ctx: ToolContext,
  call: BrowserCall,
  options: BrowserSessionOptions,
  work: (page: SignedInPage) => Promise<T>,
): Promise<T> {
  const services = browserServices(ctx);
  const config = configOf(ctx);
  if (call.site !== config.site) {
    throw new BrowserRefused(`this browser login is for ${config.site}, not ${call.site}`);
  }
  const site = await services.site({ slug: config.site, versionId: config.siteVersionId });
  if (!site) throw new BrowserRefused("this site is no longer in our catalogue");
  const rules = { allow: site.profile.allow, block: site.profile.block };
  // The site's rules, then a browsing skill's own pages (the intersection, docs/plan.md §1.86).
  const allowed = (url: string): { ok: true; url: string } | { ok: false; reason: string } => {
    const onSite = checkBrowserUrl(url, rules);
    if (!onSite.ok || !call.within) return onSite;
    // The address as written, so traversal the URL parser would resolve is still seen.
    const listed = checkBrowsePage(url, call.within);
    return listed.ok ? onSite : listed;
  };
  // A browsing skill's address is refused before a browser opens or a sign-in is spent on it.
  // DECISION: only with `within`: without it a refused page still signs in and out as it always
  // has (the connector's own tests hold that behaviour).
  if (call.within && call.url !== undefined) {
    const first = allowed(call.url);
    if (!first.ok) throw new BrowserRefused(`${call.url}: ${first.reason}`);
  }
  const decision = signInDecision(site.tier, config.stricter);
  if (!decision.ok) throw new BrowserRefused(decision.reason);
  const stored = StoredLogin.safeParse(await ctx.credentials.get());
  if (!stored.success) {
    throw new BrowserRefused("the agent account's username and password are not set");
  }
  const login: StoredLogin = stored.data;
  const redact = new Redactor();
  redact.add(login.password, 1);
  for (const c of login.session?.cookies ?? []) redact.add(String(c.value ?? ""), 8);

  const startedAt = ctx.now();
  const keep = mayKeepSession(site.tier, config.stricter, site.profile);
  const record: BrowserSessionRecord = {
    site: site.slug,
    siteVersion: site.version,
    tool: call.tool,
    signIn: "none",
    pages: [],
    actions: [],
    screenshots: [],
    outcome: "failed",
    signedOut: false,
    keptSession: false,
    startedAt: startedAt.toISOString(),
    endedAt: startedAt.toISOString(),
  };

  // Caps and the stop are checked before a browser is even opened.
  let state = await rolledState(services, startedAt);
  const reuse = keep && login.session !== undefined;
  if (!reuse || state.stopped) {
    const cap = signInAllowed(config.caps, state, startedAt);
    if (!cap.ok) throw new BrowserRefused(cap.reason);
  }

  const tab = await services.open({ hosts: browserSiteHosts(site.profile) });
  if (!tab) throw new BrowserRefused("browser sessions are not available in this deployment");
  let signedIn = false;
  let tried = false;
  try {
    if (reuse && login.session) {
      tried = true;
      await tab.setCookies(login.session.cookies as unknown as BrowserCookie[]);
      await tab.goto(site.profile.login.url);
      await checkForStops(tab, site.profile.login);
      if (await isSignedIn(tab, site.profile.login)) {
        signedIn = true;
        record.signIn = "kept_session";
      } else {
        // The kept session no longer works: forget it and sign in afresh (a fresh browser).
        login.session = undefined;
        await ctx.credentials.set(withoutSession(login));
        const cap = signInAllowed(config.caps, state, startedAt);
        if (!cap.ok) throw new BrowserRefused(cap.reason);
      }
    }
    if (!signedIn) {
      state = { ...state, signIns: state.signIns + 1 };
      await services.state.put(state);
      tried = true;
      try {
        await signIn({
          tab,
          profile: site.profile,
          siteKey: site.slug,
          username: login.username,
          password: login.password,
          identityId: config.identity?.id ?? null,
          codes: services.codes,
          poll: options.codePoll,
          sleep: services.sleep ?? defaultSleep,
          onCode: (code) => redact.add(code, 1),
        });
      } catch (error) {
        if (error instanceof BrowserRefused) throw error;
        const failures = state.failures + 1;
        const message = error instanceof Error ? error.message : "signing in failed";
        if (error instanceof BrowserStop || failures >= BROWSER_MAX_FAILURES) {
          const reason =
            error instanceof BrowserStop ? message : `${failures} failed sign-ins: ${message}`;
          state = { ...state, failures, stopped: { reason, at: ctx.now().toISOString() } };
          await services.state.put(state);
          await services.state.stop(reason);
          throw new BrowserStop(reason);
        }
        state = { ...state, failures };
        await services.state.put(state);
        throw new SignInFailed(message);
      }
      signedIn = true;
      record.signIn = "fresh";
      if (state.failures > 0) {
        state = { ...state, failures: 0 };
        await services.state.put(state);
      }
    }
    // Evidence starts only now: recording is never on during sign-in.
    const shot = async () => {
      try {
        record.screenshots.push(await services.saveScreenshot(await tab.screenshot()));
      } catch {
        // Evidence is best effort; the work is not.
      }
    };
    await shot();
    for (const c of await tab.cookies()) redact.add(c.value, 8);

    const page: SignedInPage = {
      site,
      async open(url) {
        const before = allowed(url);
        if (!before.ok) throw new BrowserRefused(`${url}: ${before.reason}`);
        await tab.goto(before.url);
        const after = allowed(tab.url());
        if (!after.ok) {
          // Redirected somewhere agents may not go: leave without reading it.
          throw new BrowserRefused(`${url} went to a page agents may not open: ${after.reason}`);
        }
        await checkForStops(tab, site.profile.login);
        record.pages.push(after.url);
        await shot();
        return after.url;
      },
      readText: async () => redact.text(await tab.readText()),
      readTables: async () => redact.deep(await tab.readTables()),
      async download(url) {
        const before = allowed(url);
        if (!before.ok) throw new BrowserRefused(`${url}: ${before.reason}`);
        const file = await tab.download(before.url);
        const after = allowed(file.finalUrl);
        if (!after.ok) {
          throw new BrowserRefused(`${url} went to a file agents may not open: ${after.reason}`);
        }
        if (file.status < 200 || file.status >= 300) {
          throw new Error(`the site answered ${file.status} for ${url}`);
        }
        return file;
      },
      note: (action) => record.actions.push(action),
      lastScreenshot: () => record.screenshots.at(-1) ?? null,
    };
    const result = await work(page);
    record.outcome = "done";
    return redact.deep(result);
  } catch (error) {
    if (error instanceof BrowserStop) record.outcome = "stopped";
    const message = error instanceof Error ? error.message : String(error);
    record.reason = redact.text(message);
    // Same class, secrets removed: what reaches the model and the logs.
    const Clean =
      error instanceof BrowserStop
        ? BrowserStop
        : error instanceof SignInFailed
          ? SignInFailed
          : error instanceof BrowserRefused
            ? BrowserRefused
            : Error;
    throw new Clean(record.reason);
  } finally {
    // Always: keep the session (low tier, a clean finish) or sign out; then destroy the browser.
    try {
      if (keep && signedIn && record.outcome === "done") {
        const cookies = await tab.cookies();
        await ctx.credentials.set({
          ...withoutSession(login),
          session: {
            cookies: cookies as unknown as JsonObject[],
            savedAt: ctx.now().toISOString(),
          },
        });
        record.keptSession = true;
      } else {
        if (tried) record.signedOut = await signOut(tab, site.profile);
        // Medium tier (and any session that failed) never keeps a session.
        if (login.session !== undefined) await ctx.credentials.set(withoutSession(login));
      }
    } catch {
      // Closing still happens below.
    }
    await tab.close();
    record.endedAt = ctx.now().toISOString();
    await services.record(record).catch(() => undefined);
  }
}

/** setTimeout exists in every runtime this package runs in; the package has no runtime types. */
const defaultSleep = (ms: number) =>
  new Promise<void>((resolve) =>
    (globalThis as unknown as { setTimeout(fn: () => void, ms: number): unknown }).setTimeout(
      resolve,
      ms,
    ),
  );

function withoutSession(login: StoredLogin): { username: string; password: string } {
  return { username: login.username, password: login.password };
}
