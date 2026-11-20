// Signing in and out by code (ARCHITECTURE §6.10 "Signing in"; invariant 13): our code opens the
// login page, types only on the site's pinned login origins (checked again just before each thing
// it types), gets the second factor from the code service (a wait opened before submitting, then
// one claim with a bounded poll), and checks the signed-in page. The model is never involved and
// none of this reaches a log, a tool result or a screenshot.

import {
  type BrowserLogin,
  type BrowserSiteProfile,
  onLoginOrigin,
  urlHost,
  urlMatches,
} from "@countersign/core";
import { ToolRefused } from "../connector";
import type { BrowserTab } from "./driver";
import type { BrowserCodesPort } from "./services";

/**
 * A page that means "stop and ask a person": a CAPTCHA, an unusual-activity or new-device check,
 * or any page the sign-in did not expect. Fails the step with its reason, never retried: the
 * connection's sign-ins stop until someone checks the account.
 */
export class BrowserStop extends Error {
  override name = "BrowserStop";
}

/** A sign-in that did not work (wrong login, no code in time). Counts toward the two-failure stop. */
export class SignInFailed extends Error {
  override name = "SignInFailed";
}

/**
 * Our own code service (apps/mfa) could not give the sign-in its code: it is down, an RPC failed,
 * or it reached its daily cap of code requests. Not the client's failed sign-in, so it never counts
 * toward the two-failure stop; the step may try again (PLATFORM_QA INTEG-1).
 */
export class CodesUnavailable extends Error {
  override name = "CodesUnavailable";
}

/** The code service's own error code on a thrown error (apps/api's CodesServiceError), if any. */
function codesErrorCode(error: unknown): unknown {
  return typeof error === "object" && error !== null
    ? (error as { code?: unknown }).code
    : undefined;
}

function codesUnavailable(error: unknown): CodesUnavailable {
  return new CodesUnavailable(
    codesErrorCode(error) === "daily_cap"
      ? "our code service reached its daily limit of codes for this login; this is not a failed sign-in, and it can try again tomorrow"
      : "our code service did not answer; this is not a failed sign-in, and it can try again",
  );
}

/** Refused before anything was typed or opened (tier, caps, rules, setup). */
export class BrowserRefused extends ToolRefused {
  override name = "BrowserRefused";
}

/**
 * Refused by the connection's sign-in caps (core's `signInAllowed`): stopped, outside its hours or
 * at its daily limit. A browsing skill asks for help on it rather than fail (./scope.ts).
 */
export class BrowserCapReached extends BrowserRefused {
  override name = "BrowserCapReached";
  constructor(
    readonly code: "stopped" | "hours" | "daily_cap",
    message: string,
  ) {
    super(message);
  }
}

// DECISION: the platform's own stop checks, on every site beside the profile's `stopSelectors`:
// the common CAPTCHA widgets and the usual words of unusual-activity and new-device pages.
export const PLATFORM_STOP_SELECTORS = [
  'iframe[src*="recaptcha"]',
  'iframe[src*="hcaptcha"]',
  'iframe[src*="challenges.cloudflare.com"]',
  ".g-recaptcha",
  ".h-captcha",
  ".cf-turnstile",
  "[data-sitekey]",
  '[id*="captcha" i]',
  '[class*="captcha" i]',
];
const STOP_WORDS = [
  /unusual (activity|sign[- ]?in)/i,
  /new device/i,
  /verify (that )?(it'?s|it is) (really )?you/i,
  /suspicious/i,
  /(are you|not) a robot/i,
  /captcha/i,
  /account (is |has been )?(locked|suspended)/i,
  /too many (failed )?(attempts|sign[- ]?ins)/i,
];

/** Throws BrowserStop when the page is a CAPTCHA or an account check. */
export async function checkForStops(tab: BrowserTab, login: BrowserLogin): Promise<void> {
  for (const s of [...PLATFORM_STOP_SELECTORS, ...login.stopSelectors]) {
    if (await tab.has(s)) {
      throw new BrowserStop("the site showed a CAPTCHA or an account check; a person must look");
    }
  }
  const text = await tab.readText();
  const word = STOP_WORDS.find((w) => w.test(text));
  if (word) {
    throw new BrowserStop(
      "the site showed an unusual-activity or new-device check; a person must look",
    );
  }
}

function hostOf(url: string): string {
  return urlHost(url) ?? "an unknown address";
}

/**
 * Nothing is typed unless the tab is on one of the login origins, exactly, by the browser's own
 * address now (`where`): a remote tab's `url()` is as of its last call, which can be from before the
 * wait for a code (docs/plan.md §1.26 "Browser driver").
 */
async function requireLoginOrigin(tab: BrowserTab, login: BrowserLogin): Promise<void> {
  const at = tab.where ? await tab.where() : tab.url();
  if (!onLoginOrigin(at, login.origins)) {
    throw new BrowserStop(
      `the sign-in page moved to ${hostOf(at)}, which is not the site's login address; nothing was typed`,
    );
  }
}

/**
 * Types a sign-in value on the login origins only. The tab checks the origin itself as it types
 * (`onlyOn`), so a page that moves between the check above and the typing gets nothing either.
 */
async function fillOnLogin(
  tab: BrowserTab,
  login: BrowserLogin,
  selector: string,
  value: string,
): Promise<void> {
  await requireLoginOrigin(tab, login);
  try {
    await tab.fill(selector, value, { onlyOn: login.origins });
  } catch (error) {
    // Refused because the page moved at the last moment: a stop, as above, not a failed sign-in.
    await requireLoginOrigin(tab, login);
    throw error;
  }
}

export async function isSignedIn(tab: BrowserTab, login: BrowserLogin): Promise<boolean> {
  const { url, selector } = login.signedIn;
  if (url !== undefined && !urlMatches(url, tab.url())) return false;
  if (selector !== undefined && !(await tab.has(selector))) return false;
  return true;
}

export interface SignInInput {
  tab: BrowserTab;
  profile: BrowserSiteProfile;
  siteKey: string;
  username: string;
  password: string;
  identityId: string | null;
  codes: BrowserCodesPort | null;
  poll: { intervalMs: number; attempts: number };
  sleep: (ms: number) => Promise<void>;
  /** Told the code once claimed, so everything the tool returns can be checked for it. */
  onCode?: (code: string) => void;
}

/** How long a sign-in's wait for a code stays open at the code service. */
const WAIT_SECONDS = 180;

async function openWait(input: SignInInput) {
  const factor = input.profile.login.secondFactor;
  if (factor.kind === "none") return null;
  if (!input.codes) {
    throw new BrowserRefused("this site asks for a code, and the code service is not available");
  }
  if (!input.identityId) {
    throw new BrowserRefused("this browser login has no agent identity for its codes");
  }
  const base = { identityId: input.identityId, siteKey: input.siteKey, ttlSeconds: WAIT_SECONDS };
  let wait: Awaited<ReturnType<BrowserCodesPort["openWait"]>>;
  try {
    wait = await input.codes.openWait(
      factor.kind === "totp"
        ? { ...base, channel: "totp" }
        : { ...base, channel: factor.kind, sender: factor.sender, pattern: factor.pattern },
    );
  } catch (error) {
    throw codesUnavailable(error);
  }
  return { waitId: wait.waitId, identityId: input.identityId, codes: input.codes };
}

type OpenWait = { waitId: string; identityId: string; codes: BrowserCodesPort };

/**
 * Claims the wait's code, polling a bounded number of times; null when none came. A claim the code
 * service fails to answer is polled past; if no code came and one did fail, the code service is
 * the trouble (CodesUnavailable), not the site.
 */
async function claimCode(wait: OpenWait, input: SignInInput): Promise<string | null> {
  let failed: unknown = null;
  for (let i = 0; i < input.poll.attempts; i++) {
    try {
      const r = await wait.codes.claim({ identityId: wait.identityId, waitId: wait.waitId });
      if (r.status === "code") return r.code;
      if (r.status === "expired") break;
    } catch (error) {
      failed = error;
    }
    await input.sleep(input.poll.intervalMs);
  }
  if (failed !== null) throw codesUnavailable(failed);
  return null;
}

/**
 * Closes a wait the sign-in did not get its code from, so a code the site sends a later sign-in
 * never lands in it (PLATFORM_QA INTEG-2). Best effort: the wait expires on its own anyway.
 */
// DECISION: a cancel at the code service on every way out of a sign-in that didn't claim its code,
// rather than a wait as short as the poll: it also covers the failures before the poll (a refused
// password, a form that couldn't be filled), and concurrent sign-ins keep their own waits.
async function cancelWait(wait: OpenWait): Promise<void> {
  try {
    await wait.codes.cancel({ identityId: wait.identityId, waitId: wait.waitId });
  } catch {
    // An older code service without the call, or one that is down: the wait times out.
  }
}

/**
 * Signs in. Throws BrowserStop (stop and ask a person), SignInFailed (counts as a failed sign-in),
 * CodesUnavailable (our code service's trouble: never counted) or BrowserRefused (nothing was
 * tried). Error messages never carry what was typed. A wait whose code it didn't claim is closed.
 */
export async function signIn(input: SignInInput): Promise<void> {
  const { tab, profile } = input;
  const login = profile.login;
  try {
    await tab.goto(login.url);
  } catch {
    throw new SignInFailed("the sign-in page did not open");
  }
  await checkForStops(tab, login);
  await requireLoginOrigin(tab, login);
  if (!(await tab.has(login.usernameField)) || !(await tab.has(login.passwordField))) {
    throw new BrowserStop("the sign-in page did not look as expected; nothing was typed");
  }
  // The wait opens before anything is submitted, so the code that sign-in triggers has a wait to
  // land in (a code with no wait open is an alert at the code service, never handed out).
  const wait = await openWait(input);
  const got = { code: false };
  try {
    await submitLogin(input, wait, got);
  } finally {
    if (wait && !got.code) await cancelWait(wait);
  }
}

/** Submits the login and, when asked, the code (`got.code` once the wait's code is claimed). */
async function submitLogin(
  input: SignInInput,
  wait: OpenWait | null,
  got: { code: boolean },
): Promise<void> {
  const { tab, profile } = input;
  const login = profile.login;
  try {
    await fillOnLogin(tab, login, login.usernameField, input.username);
    await fillOnLogin(tab, login, login.passwordField, input.password);
    await requireLoginOrigin(tab, login);
    await tab.click(login.submitButton);
  } catch (error) {
    if (error instanceof BrowserStop) throw error;
    throw new SignInFailed("the sign-in form could not be filled in");
  }
  await checkForStops(tab, login);
  if (wait && !(await isSignedIn(tab, login))) {
    if (!onLoginOrigin(tab.url(), login.origins)) {
      throw new BrowserStop(
        `after the password the site went to ${hostOf(tab.url())}, which the sign-in did not expect`,
      );
    }
    const factor = login.secondFactor;
    if (factor.kind === "none") throw new Error("unreachable");
    if (!(await tab.has(factor.codeField))) {
      throw new SignInFailed(
        "the site did not ask for a code and did not sign in; the username or password may be wrong",
      );
    }
    const code = await claimCode(wait, input);
    if (code === null) throw new SignInFailed("no sign-in code arrived in time");
    got.code = true;
    input.onCode?.(code);
    try {
      await fillOnLogin(tab, login, factor.codeField, code);
      await requireLoginOrigin(tab, login);
      await tab.click(factor.codeButton);
    } catch (error) {
      if (error instanceof BrowserStop) throw error;
      throw new SignInFailed("the code could not be entered");
    }
    await checkForStops(tab, login);
  }
  if (!(await isSignedIn(tab, login))) {
    if (!onLoginOrigin(tab.url(), login.origins)) {
      throw new BrowserStop(
        `the sign-in ended on ${hostOf(tab.url())}, which it did not expect; a person must look`,
      );
    }
    throw new SignInFailed(
      "the site did not show the signed-in page; the username, password or code may be wrong",
    );
  }
}

/** Signs out by the profile's page or button. Never throws. */
export async function signOut(tab: BrowserTab, profile: BrowserSiteProfile): Promise<boolean> {
  try {
    if (profile.signOut.selector && (await tab.has(profile.signOut.selector))) {
      await tab.click(profile.signOut.selector);
      return true;
    }
    if (profile.signOut.url) {
      await tab.goto(profile.signOut.url);
      return true;
    }
    return false;
  } catch {
    return false;
  }
}
