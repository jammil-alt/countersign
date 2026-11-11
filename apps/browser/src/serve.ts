// One tab as the browser service serves it (core of `RemoteTab` in ./service.ts, kept free of
// `cloudflare:workers` so Node tests and real Chromium can drive it). Each call checks its input
// (invariant 5), runs one Playwright primitive and answers the value with the tab's address. It
// decides nothing: apps/api's connector checks origins, redacts and records.
//
// A value typed by `fill` (a password, a code) or set by `setCookies` (a held session) is used for
// that one call: it is never logged, kept or returned, and a failure answers a fixed message
// instead of Playwright's, so the value can't come back inside an error.

import type {
  BrowserCookie,
  BrowserTab,
  BrowserTabAnswer,
  BrowserTabService,
} from "@countersign/connectors";
import { z } from "zod";

const Url = z.string().max(8_192);
const Selector = z.string().min(1).max(2_048);
// A field's value: a username, a password, a one-time code or a script's input.
const Value = z.string().max(16_384);
// The origins a fill may type on (apps/api's choice: a site's login origins).
const Origins = z.array(z.string().min(1).max(2_048)).min(1).max(50);
const Cookie = z.object({
  name: z.string().max(4_096),
  value: z.string().max(16_384),
  domain: z.string().max(1_024),
  path: z.string().max(4_096),
  expires: z.number(),
  httpOnly: z.boolean(),
  secure: z.boolean(),
  sameSite: z.enum(["Strict", "Lax", "None"]),
  partitionKey: z.string().max(1_024).optional(),
});
const Cookies = z.array(Cookie).max(500);

/** An address's origin (`https://host[:port]`); empty for anything that isn't one. */
function originOf(address: string): string {
  try {
    return new URL(address).origin;
  } catch {
    return "";
  }
}

/** A call the service refused, or one that failed where its message could carry a secret. */
export class BrowserServiceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BrowserServiceError";
  }
}

function parse<S extends z.ZodType>(schema: S, value: unknown, what: string): z.output<S> {
  const r = schema.safeParse(value);
  if (!r.success) throw new BrowserServiceError(`invalid ${what}`);
  return r.data;
}

/** Serves `tab` over the browser service's contract (driver.ts `BrowserTabService`). */
export function serveTab(tab: BrowserTab): BrowserTabService {
  const answer = <T>(value: T): BrowserTabAnswer<T> => ({ url: tab.url(), value });
  const live = async () => (tab.where ? tab.where() : tab.url());
  const needs = <K extends keyof BrowserTab>(name: K): NonNullable<BrowserTab[K]> => {
    const fn = tab[name];
    if (typeof fn !== "function") throw new BrowserServiceError(`this browser has no ${name}`);
    return (fn as (...args: never[]) => unknown).bind(tab) as NonNullable<BrowserTab[K]>;
  };
  return {
    async goto(url) {
      await tab.goto(parse(Url, url, "address"));
      return answer(null);
    },
    async where() {
      const at = await live();
      return { url: at, value: null };
    },
    async fill(selector, value, onlyOn) {
      const s = parse(Selector, selector, "selector");
      // Checked without naming the value; the value is typed and forgotten.
      if (!Value.safeParse(value).success) throw new BrowserServiceError("invalid value");
      const origins = onlyOn === undefined ? undefined : parse(Origins, onlyOn, "origins");
      // DECISION: apps/api decides the origins; the service only holds the typing to them, on the
      // browser's own address at this moment (apps/api's copy of the address can be old).
      if (origins && !origins.includes(originOf(await live()))) {
        throw new BrowserServiceError("the page is not on an allowed origin; nothing was typed");
      }
      try {
        await tab.fill(s, value, origins ? { onlyOn: origins } : undefined);
      } catch {
        // DECISION: Playwright's own message is dropped: it names the selector today, but a fill
        // that fails must never be able to hand back what it was typing.
        throw new BrowserServiceError("the field could not be filled");
      }
      return answer(null);
    },
    async click(selector) {
      await tab.click(parse(Selector, selector, "selector"));
      return answer(null);
    },
    async has(selector) {
      return answer(await tab.has(parse(Selector, selector, "selector")));
    },
    async readText() {
      return answer(await tab.readText());
    },
    async readTables() {
      return answer(await tab.readTables());
    },
    async textOf(selector) {
      return answer(await needs("textOf")(parse(Selector, selector, "selector")));
    },
    async controls() {
      return answer(await needs("controls")());
    },
    async sendsForm(selector) {
      return answer(await needs("sendsForm")(parse(Selector, selector, "selector")));
    },
    async readOnly(on) {
      await needs("readOnly")(parse(z.boolean(), on, "read-only flag"));
      return answer(null);
    },
    async download(url) {
      return answer(await tab.download(parse(Url, url, "address")));
    },
    async cookies() {
      return answer(await tab.cookies());
    },
    async setCookies(cookies) {
      const r = Cookies.safeParse(cookies);
      if (!r.success) throw new BrowserServiceError("invalid cookies");
      try {
        await tab.setCookies(
          r.data.map(({ partitionKey, ...c }) =>
            partitionKey === undefined ? c : { ...c, partitionKey },
          ) as BrowserCookie[],
        );
      } catch {
        throw new BrowserServiceError("the session could not be restored");
      }
      return answer(null);
    },
    async screenshot() {
      return answer(await tab.screenshot());
    },
    async alive() {
      return tab.alive ? tab.alive() : true;
    },
    close: () => tab.close(),
  };
}

/**
 * What `open` takes: the site's hosts (the first 50 become Browser Run's guardrails, as before the
 * move) and how long a held session's browser may sit idle.
 */
export const OpenInput = z.object({
  hosts: z.array(z.string().min(1).max(253)).max(500),
  keepAliveMs: z.number().optional(),
});
