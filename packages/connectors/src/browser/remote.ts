// A BrowserTab over the browser service's RPC tab (apps/browser, reached through apps/api's
// `BROWSER` service binding; ./driver.ts "The browser service"). Every call is one round trip; its
// answer is checked (invariant 5) and brings back the tab's address, which `url()` then answers. The
// connector above makes every decision (pinned origins, what may be read, what is redacted), as it
// does over a local Playwright tab.

import { z } from "zod";
import type { BrowserControl, BrowserTab, BrowserTabAnswer, BrowserTabService } from "./driver";

const Cookie = z.object({
  name: z.string(),
  value: z.string(),
  domain: z.string(),
  path: z.string(),
  expires: z.number(),
  httpOnly: z.boolean(),
  secure: z.boolean(),
  sameSite: z.enum(["Strict", "Lax", "None"]),
});
const Table = z.object({ headers: z.array(z.string()), rows: z.array(z.array(z.string())) });
const Control = z
  .object({
    selector: z.string(),
    kind: z.enum(["field", "select", "button", "link"]),
    label: z.string(),
    submits: z.boolean().optional(),
  })
  .transform(
    ({ submits, ...c }): BrowserControl => (submits === undefined ? c : { ...c, submits }),
  );
const Address = z.object({ url: z.string() });
const Bytes = z.instanceof(Uint8Array);
const Download = z.object({
  bytes: Bytes,
  filename: z.string(),
  mimeType: z.string(),
  finalUrl: z.string(),
  status: z.number().int(),
});

/** The browser service answered something other than the contract. */
export class BrowserServiceAnswerError extends Error {
  constructor(method: string) {
    super(`the browser service gave an unexpected answer to ${method}`);
    this.name = "BrowserServiceAnswerError";
  }
}

/** Releases an RPC stub, where the runtime gives it a disposer. */
function dispose(stub: unknown) {
  const key = (Symbol as { dispose?: symbol }).dispose;
  const fn = key ? (stub as Record<symbol, unknown>)[key] : undefined;
  if (typeof fn === "function") {
    try {
      fn.call(stub);
    } catch {
      // Already released.
    }
  }
}

/**
 * The tab apps/api drives: `stub` is the service's tab and `url` the address it opened on. `close`
 * closes the browser and releases the stub; it never throws.
 */
export function remoteBrowserTab(stub: BrowserTabService, url: string): BrowserTab {
  let current = url;
  let closed = false;
  async function take<T>(
    method: string,
    schema: z.ZodType<T>,
    answer: Promise<BrowserTabAnswer<unknown>>,
  ): Promise<T> {
    const got: unknown = await answer;
    const url = Address.safeParse(got);
    const value = schema.safeParse((got as { value?: unknown } | null)?.value);
    if (!url.success || !value.success) throw new BrowserServiceAnswerError(method);
    current = url.data.url;
    return value.data;
  }
  const none = z.null();
  return {
    url: () => current,
    goto: async (to) => {
      await take("goto", none, stub.goto(to));
    },
    fill: async (selector, value) => {
      await take("fill", none, stub.fill(selector, value));
    },
    click: async (selector) => {
      await take("click", none, stub.click(selector));
    },
    has: (selector) => take("has", z.boolean(), stub.has(selector)),
    readText: () => take("readText", z.string(), stub.readText()),
    readTables: () => take("readTables", z.array(Table), stub.readTables()),
    textOf: (selector) => take("textOf", z.string().nullable(), stub.textOf(selector)),
    controls: () => take("controls", z.array(Control), stub.controls()),
    sendsForm: (selector) => take("sendsForm", z.boolean(), stub.sendsForm(selector)),
    readOnly: async (on) => {
      await take("readOnly", none, stub.readOnly(on));
    },
    download: (from) => take("download", Download, stub.download(from)),
    cookies: () => take("cookies", z.array(Cookie), stub.cookies()),
    setCookies: async (cookies) => {
      await take("setCookies", none, stub.setCookies(cookies));
    },
    screenshot: () => take("screenshot", Bytes, stub.screenshot()),
    async alive() {
      if (closed) return false;
      try {
        return (await stub.alive()) === true;
      } catch {
        return false;
      }
    },
    async close() {
      if (closed) return;
      closed = true;
      try {
        await stub.close();
      } catch {
        // The service closes the browser when the stub is released, below.
      } finally {
        dispose(stub);
      }
    },
  };
}
