// The BrowserDriver as apps/api has it (ARCHITECTURE §6.10; docs/plan.md §1.26 "Browser driver"):
// one browser per tool call, or per browsing skill run and site (a held session, §1.86), in the
// browser service (apps/browser, Worker `mezonas-browser`), reached only through the optional
// `BROWSER` service binding. Browser Run and Playwright live there, so this Worker carries neither;
// everything that decides (the permission gate, pinned origins, the blocked tier, the vault, the
// audit, external actions) stays here, in the connector that drives the tab. Closing the tab
// destroys the browser.

import { type BrowserTab, type BrowserTabService, remoteBrowserTab } from "@countersign/connectors";
import { z } from "zod";
import type { Bindings } from "../env";

/**
 * `open`'s answer (connectors' `BrowserOpenAnswer`), checked (invariant 5). The tab is an RPC stub,
 * so only its presence is checked here; each of its answers is checked by `remoteBrowserTab`.
 */
const OpenAnswer = z.discriminatedUnion("ok", [
  z.object({
    ok: z.literal(true),
    url: z.string(),
    tab: z.custom<BrowserTabService>(
      (v) => v !== null && (typeof v === "object" || typeof v === "function"),
    ),
  }),
  z.object({
    ok: z.literal(false),
    error: z.object({ code: z.enum(["no_browser", "invalid"]), message: z.string() }),
  }),
]);

/** Opens a fresh browser for one site in the browser service; undefined without the binding. */
// DECISION: the binding keeps the name `BROWSER` (now a service binding, not Browser Run itself),
// so the code that only asks whether browsers are available here (platform.ts) reads the same.
export function browserRunOpener(
  env: Pick<Bindings, "BROWSER">,
):
  | ((options: { hosts: string[]; keepAliveMs?: number | undefined }) => Promise<BrowserTab | null>)
  | undefined {
  const service = env.BROWSER;
  if (!service) return undefined;
  return async ({ hosts, keepAliveMs }) => {
    const answer = await service.open({
      hosts,
      ...(keepAliveMs === undefined ? {} : { keepAliveMs }),
    });
    const parsed = OpenAnswer.safeParse(answer);
    if (!parsed.success) throw new Error("the browser service gave an unexpected answer to open");
    const opened = parsed.data;
    if (opened.ok) return remoteBrowserTab(opened.tab, opened.url);
    // No Browser Run behind the service: the same as no browser here.
    if (opened.error.code === "no_browser") return null;
    throw new Error(`the browser service refused: ${opened.error.message}`);
  };
}
