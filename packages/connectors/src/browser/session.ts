// One browser session for one tool call (docs/plan.md §1.26 "Sessions and stops"): check the
// tier, the caps and the stop; sign in by code (or reuse a kept low-tier session); do the work on
// allowed pages only; then always sign out (or keep the session, low tier only) and close the
// browser, in a finally block; and record what happened on the connection's log.
// v0.16 (docs/plan.md §1.86): a browsing skill's calls share one such session for the skill run
// (`inBrowserSession`, held in the run's `sessions`), so a run signs in once per site.

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
import type { HeldSession, ToolContext } from "../connector";
import type { BrowserControl, BrowserCookie, BrowserDownload, BrowserTable } from "./driver";
import { checkBrowsePage } from "./scope";
import type { BrowserServices, BrowserSessionRecord } from "./services";
import {
  BrowserCapReached,
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
  /** How long the browser may sit idle (a held session's longest wait); absent, the driver's own. */
  keepAliveMs?: number | undefined;
}

/** What a tool does once signed in: only through these, each page checked against the rules. */
export interface SignedInPage {
  /** Opens an allowed page; the address it ends at is checked again. Answers the final address. */
  open(url: string): Promise<string>;
  readText(): Promise<string>;
  readTables(): Promise<BrowserTable[]>;
  /** Fetches an allowed file; the address it ends at is checked again. */
  download(url: string): Promise<BrowserDownload>;
  /** Whether an element `selector` names is on the page. */
  has(selector: string): Promise<boolean>;
  /** Types into an element (a script's or a recording's fill; never a login: that is sign-in's). */
  fill(selector: string, value: string): Promise<void>;
  /**
   * Clicks an element; the page it lands on is checked like an opened one (allowed, no stop page)
   * and photographed. Answers the address it ends at.
   */
  click(selector: string): Promise<string>;
  /** One element's text (a field's value); null when nothing matches. */
  textOf(selector: string): Promise<string | null>;
  /** The page's fields, lists, buttons and links, for the recorder; [] where the driver can't. */
  controls(): Promise<BrowserControl[]>;
  /** The address the page is on now. */
  url(): string;
  /** A screenshot of the page now, kept as evidence: its storage key, or null when it failed. */
  shoot(): Promise<string | null>;
  /** Notes an action for the session's record. */
  note(action: BrowserSessionRecord["actions"][number]): void;
  /**
   * The storage key of the screenshot taken after the last page this session opened; null when
   * that one failed (evidence is best effort) or nothing was opened yet.
   */
  lastScreenshot(): string | null;
  /** Hides this session's secrets (password, cookies, code) in a value. */
  redact<T>(value: T): T;
  /** Whether the browser still answers (Browser Run closes one left idle past its keep-alive). */
  alive(): Promise<boolean>;
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

type PageCheck = { ok: true; url: string } | { ok: false; reason: string };

/**
 * The connection's site and the check every address goes through: the site's rules, then a
 * browsing skill's own pages (the intersection, docs/plan.md §1.86). A browsing skill's address
 * (`within` and `url`) is refused here, before a browser opens or a sign-in is spent on it.
 */
// DECISION: only with `within`: without it a refused page still signs in and out as it always
// has (the connector's own tests hold that behaviour).
async function siteOf(ctx: ToolContext, call: BrowserCall) {
  const services = browserServices(ctx);
  const config = configOf(ctx);
  if (call.site !== config.site) {
    throw new BrowserRefused(`this browser login is for ${config.site}, not ${call.site}`);
  }
  const site = await services.site({ slug: config.site, versionId: config.siteVersionId });
  if (!site) throw new BrowserRefused("this site is no longer in our catalogue");
  const rules = { allow: site.profile.allow, block: site.profile.block };
  const allowed = (url: string): PageCheck => {
    const onSite = checkBrowserUrl(url, rules);
    if (!onSite.ok || !call.within) return onSite;
    // The address as written, so traversal the URL parser would resolve is still seen.
    const listed = checkBrowsePage(url, call.within);
    return listed.ok ? onSite : listed;
  };
  if (call.within && call.url !== undefined) {
    const first = allowed(call.url);
    if (!first.ok) throw new BrowserRefused(`${call.url}: ${first.reason}`);
  }
  return { services, config, site, allowed };
}

/**
 * The connection's pinned site and its setup, checked as a session checks them (the site named is
 * the connection's, still in the catalogue), without opening a browser: a write's before state.
 */
export async function browserConnectionSite(
  ctx: ToolContext,
  site: string,
): Promise<{ site: PinnedBrowserSite; config: BrowserConnectionConfig }> {
  const checked = await siteOf(ctx, { tool: "", site });
  return { site: checked.site, config: checked.config };
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
  const { services, config, site, allowed } = await siteOf(ctx, call);
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
    if (!cap.ok) throw new BrowserCapReached(cap.code, cap.reason);
  }

  const tab = await services.open({
    hosts: browserSiteHosts(site.profile),
    ...(options.keepAliveMs !== undefined ? { keepAliveMs: options.keepAliveMs } : {}),
  });
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
        if (!cap.ok) throw new BrowserCapReached(cap.code, cap.reason);
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
    const shot = async (): Promise<string | null> => {
      try {
        const key = await services.saveScreenshot(await tab.screenshot());
        record.screenshots.push(key);
        return key;
      } catch {
        // Evidence is best effort; the work is not.
        return null;
      }
    };
    await shot();
    for (const c of await tab.cookies()) redact.add(c.value, 8);

    // The last opened page's own screenshot: never an earlier page's when this one's failed.
    let pageShot: string | null = null;
    const page: SignedInPage = {
      site,
      async open(url) {
        pageShot = null;
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
        pageShot = await shot();
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
      has: (selector) => tab.has(selector),
      async fill(selector, value) {
        await tab.fill(selector, value);
        // The value is the client's data: the record names the element only.
        record.actions.push({ kind: "fill", url: tab.url(), selector });
      },
      async click(selector) {
        pageShot = null;
        const from = tab.url();
        await tab.click(selector);
        record.actions.push({ kind: "click", url: from, selector });
        const after = allowed(tab.url());
        if (!after.ok) {
          // A click that leaves the allowed pages: stop there, read nothing.
          throw new BrowserRefused(
            `clicking ${selector} went to a page agents may not open: ${after.reason}`,
          );
        }
        await checkForStops(tab, site.profile.login);
        if (after.url !== record.pages.at(-1)) record.pages.push(after.url);
        pageShot = await shot();
        return after.url;
      },
      async textOf(selector) {
        if (!tab.textOf) throw new BrowserRefused("this browser can't read single fields");
        const text = await tab.textOf(selector);
        return text === null ? null : redact.text(text);
      },
      controls: async () => redact.deep(tab.controls ? await tab.controls() : []),
      url: () => tab.url(),
      shoot: () => shot(),
      note: (action) => record.actions.push(action),
      lastScreenshot: () => pageShot,
      redact: (value) => redact.deep(value),
      alive: async () => (tab.alive ? tab.alive().catch(() => false) : true),
    };
    const result = await work(page);
    record.outcome = "done";
    return redact.deep(result);
  } catch (error) {
    if (error instanceof BrowserStop) record.outcome = "stopped";
    const clean = cleanError(error, redact);
    record.reason = clean.message;
    throw clean;
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

/** The same error class, secrets removed: what reaches the model and the logs. */
function cleanError(error: unknown, redact: { text(value: string): string }): Error {
  const message = redact.text(error instanceof Error ? error.message : String(error));
  if (error instanceof BrowserCapReached) return new BrowserCapReached(error.code, message);
  const Clean =
    error instanceof BrowserGone
      ? BrowserGone
      : error instanceof BrowserStop
        ? BrowserStop
        : error instanceof SignInFailed
          ? SignInFailed
          : error instanceof BrowserRefused
            ? BrowserRefused
            : Error;
  return new Clean(message);
}

/** A session kept open for one skill run's calls on one site: each call's work, one at a time. */
export interface HeldBrowserSession {
  run<T>(work: (page: SignedInPage) => Promise<T>): Promise<T>;
}

/** A held session's browser closed between calls (Browser Run's idle limit): open another. */
class BrowserGone extends Error {
  override name = "BrowserGone";
}

/**
 * How many times a held session opens a fresh browser after its browser closed between calls.
 * Each one signs in again and counts against the connection's caps.
 */
// DECISION: twice per held session. The keep-alive covers the run's time limit, so a browser that
// closes anyway is Browser Run's doing; a third time something else is wrong, and the run asks
// for help rather than spend more of the connection's sign-ins.
export const HELD_SESSION_REOPENS = 2;

/**
 * Signs in once and keeps the session until `close`. withBrowserSession's own `work(page)` runs
 * each call's work in turn, so the checks, evidence, sign-out and record are those of one call
 * (one record per browser). The browser is asked to stay open as long as the run may wait
 * between calls (`keepAliveMs`, else the run's `sessions.heldForMs`). Should it close anyway, the
 * call that finds it gone runs again in a fresh browser, signed in again within the caps (at most
 * `HELD_SESSION_REOPENS` times). A stop page (a CAPTCHA mid-session), a failed sign-in or a
 * browser that can't be opened again ends the session: the run is told (`sessions.ended`) before
 * the call's failure reaches it, and later calls fail with that reason. Throws the sign-in's own
 * error (caps, a failed sign-in, a stop) when it can't sign in at first.
 */
// DECISION: one session per skill run per site, closed when the run ends (docs/plan.md §1.86):
// 15 pages must not spend 15 of the connection's daily sign-ins or send 15 codes. The run's time
// limit (5 minutes) bounds how long it stays signed in.
export async function holdBrowserSession(
  ctx: ToolContext,
  call: BrowserCall,
  options: BrowserSessionOptions,
  key = `browser:${ctx.connection.id}`,
): Promise<HeldSession<HeldBrowserSession>> {
  type Job = {
    work: (page: SignedInPage) => Promise<unknown>;
    resolve: (value: unknown) => void;
    reject: (error: unknown) => void;
    /** Already moved to a fresh browser once: never moved again. */
    moved: boolean;
  };
  const jobs: Job[] = [];
  const state: {
    wake: (() => void) | null;
    closing: boolean;
    ended: Error | null;
    told: boolean;
  } = { wake: null, closing: false, ended: null, told: false };
  const nudge = () => {
    state.wake?.();
    state.wake = null;
  };
  // The run hears once that its session ended early; never of its own close.
  const tell = (error: Error) => {
    if (state.told || state.closing) return;
    state.told = true;
    ctx.sessions?.ended?.(key, error);
  };
  let ready: (page: SignedInPage) => void = () => undefined;
  const opened = new Promise<SignedInPage>((resolve) => {
    ready = resolve;
  });
  const keepAliveMs = options.keepAliveMs ?? ctx.sessions?.heldForMs;
  const held: BrowserSessionOptions = {
    ...options,
    ...(keepAliveMs !== undefined ? { keepAliveMs } : {}),
  };
  const browser = () =>
    withBrowserSession(ctx, call, held, async (page) => {
      ready(page);
      for (;;) {
        const job = jobs.shift();
        if (!job) {
          if (state.closing) return;
          await new Promise<void>((resolve) => {
            state.wake = resolve;
          });
          continue;
        }
        try {
          job.resolve(page.redact(await job.work(page)));
        } catch (error) {
          const clean = cleanError(error, { text: (t) => page.redact(t) });
          // Gone: the browser closed under the session, not the site refusing or stopping it.
          const gone =
            !(error instanceof BrowserStop) &&
            !(error instanceof BrowserRefused) &&
            !(await page.alive());
          if (gone && !job.moved) {
            // The call runs again in a fresh browser.
            job.moved = true;
            jobs.unshift(job);
          } else {
            if (error instanceof BrowserStop) tell(clean);
            job.reject(clean);
          }
          // A stop page ends the session; so does a closed browser. withBrowserSession records it,
          // tries to sign out and closes the browser.
          if (error instanceof BrowserStop) throw error;
          if (gone) throw new BrowserGone("the browser closed between pages");
        }
      }
    });
  const done = (async () => {
    for (let reopened = 0; ; reopened++) {
      try {
        return await browser();
      } catch (error) {
        // A fresh browser only for a call that waits on it, and only so many times.
        const again =
          error instanceof BrowserGone &&
          !state.closing &&
          jobs.length > 0 &&
          reopened < HELD_SESSION_REOPENS;
        if (!again) throw error;
      }
    }
  })();
  const finished = done.then(
    () => {
      state.ended = new BrowserRefused("this skill run's browser session has ended");
    },
    (error: unknown) => {
      state.ended = error instanceof Error ? error : new Error(String(error));
      tell(state.ended);
    },
  );
  // Anything still queued when the session ends gets its reason.
  void finished.then(() => {
    for (const job of jobs.splice(0)) job.reject(state.ended);
  });
  await Promise.race([opened, finished]);
  if (state.ended) throw state.ended;
  return {
    value: {
      run<T>(work: (page: SignedInPage) => Promise<T>): Promise<T> {
        if (state.ended || state.closing) {
          return Promise.reject(
            state.ended ?? new BrowserRefused("the browser session is closing"),
          );
        }
        return new Promise<T>((resolve, reject) => {
          jobs.push({ work, resolve: resolve as (value: unknown) => void, reject, moved: false });
          nudge();
        });
      },
    },
    async close() {
      state.closing = true;
      nudge();
      await finished;
    },
  };
}

/**
 * One browser call's work: in the skill run's held session when the call is a browsing skill's
 * (it has `within`, and the run keeps sessions), else in a session of its own, as before. The
 * address is checked before the held session is opened or used, so a refused first address
 * neither spends a sign-in nor spoils the session for the run's other calls.
 */
export async function inBrowserSession<T>(
  ctx: ToolContext,
  call: BrowserCall,
  options: BrowserSessionOptions,
  work: (page: SignedInPage) => Promise<T>,
): Promise<T> {
  if (!ctx.sessions || !call.within) return withBrowserSession(ctx, call, options, work);
  await siteOf(ctx, call);
  const within = call.within;
  const key = `browser:${ctx.connection.id}:${within.join(" ")}`;
  const held = await ctx.sessions.hold(key, () =>
    holdBrowserSession(ctx, { tool: call.tool, site: call.site, within }, options, key),
  );
  return held.run(work);
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
