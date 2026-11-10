// A browsing skill's scope (docs/plan.md §1.86): its pages, its limits, help requests, the memory
// notes it reads and writes, and the script draft offered for a path that worked twice. The
// connector side (the site's rules, redirects) is in browser.test.ts against the fake portal.

import { describe, expect, it } from "vitest";
import { BROWSER_FILE_DOWNLOAD_TOOL, BROWSER_PAGE_READ_TOOL } from "./ids";
import {
  BROWSE_SCRIPT_DRAFT_SUBJECT,
  BrowseScope,
  browseHelpNote,
  browseHelpTag,
  checkBrowsePage,
  pagePattern,
} from "./scope";

const ORIGIN = "https://portal.supplier.test";
const PAGES = ["/orders/*", "/invoices"];

describe("checkBrowsePage", () => {
  it("opens full addresses on the skill's pages only", () => {
    expect(checkBrowsePage(`${ORIGIN}/orders/7`, PAGES)).toEqual({
      ok: true,
      url: `${ORIGIN}/orders/7`,
    });
    expect(checkBrowsePage(`${ORIGIN}/invoices`, PAGES).ok).toBe(true);
    expect(checkBrowsePage(`${ORIGIN}/statements`, PAGES)).toMatchObject({
      ok: false,
      code: "not_listed",
    });
  });

  it("refuses protocol-relative addresses, bare paths and other schemes", () => {
    for (const url of [
      "//evil.test/orders/7",
      "\\\\evil.test/orders/7",
      "/orders/7",
      "javascript:alert(1)",
      "file:///orders/7",
      "ftp://portal.supplier.test/orders/7",
    ]) {
      expect(checkBrowsePage(url, PAGES)).toMatchObject({ ok: false, code: "invalid" });
    }
  });

  it("refuses traversal as written, encoded or not", () => {
    for (const path of [
      "/orders/../users",
      "/orders/./7",
      "/orders/..",
      "/orders/%2e%2e/users",
      "/orders/%2E%2E/users",
      "/orders/..%2fusers",
      "/orders/7%5c..%5cusers",
      "/orders/%252e%252e/users",
      "/orders\\..\\users",
    ]) {
      expect(checkBrowsePage(`${ORIGIN}${path}`, PAGES)).toMatchObject({
        ok: false,
        code: "traversal",
      });
    }
    // A query that names another address is not traversal: the landing address is checked again.
    expect(checkBrowsePage(`${ORIGIN}/orders/7?next=/users`, PAGES).ok).toBe(true);
  });
});

describe("pagePattern", () => {
  it("turns a record's own parts into *", () => {
    expect(pagePattern(`${ORIGIN}/invoices/INV-1001.pdf`)).toBe("/invoices/*");
    expect(pagePattern(`${ORIGIN}/orders/7/lines?page=2&sort=date`)).toBe(
      "/orders/*/lines?page=*&sort=date",
    );
    expect(pagePattern(`${ORIGIN}`)).toBe("/");
  });
});

function scope(opts: { clock?: { t: number }; limits?: { pages?: number } } = {}) {
  const clock = opts.clock ?? { t: Date.parse("2026-11-10T15:00:00Z") };
  return new BrowseScope({
    skill: "custom:order-status@2",
    browse: { sites: ["supplier"], pages: PAGES },
    goal: "Find the order's delivery date",
    now: () => new Date(clock.t),
    limits: opts.limits,
  });
}

describe("BrowseScope.check", () => {
  it("leaves other tools alone and refuses anything but the two reads", () => {
    const s = scope();
    expect(s.check("docs.read", { id: "x" })).toEqual({ ok: true, input: { id: "x" } });
    expect(s.check("browser.form.submit", { site: "supplier" })).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/never a form or a sign-in/),
    });
    expect(s.check("browser.sign_in", { site: "supplier" })).toMatchObject({ ok: false });
  });

  it("refuses another site, and sets `within` to the skill's pages over the model's", () => {
    const s = scope();
    expect(
      s.check(BROWSER_PAGE_READ_TOOL, { site: "bank", url: `${ORIGIN}/orders/7` }),
    ).toMatchObject({ ok: false, reason: expect.stringMatching(/not one of this skill's sites/) });
    expect(
      s.check(BROWSER_FILE_DOWNLOAD_TOOL, {
        site: "supplier",
        url: `${ORIGIN}/orders/7`,
        within: ["/*"],
      }),
    ).toEqual({
      ok: true,
      input: { site: "supplier", url: `${ORIGIN}/orders/7`, within: PAGES },
    });
  });

  it("stops at the time limit and at the cost limit", () => {
    const clock = { t: Date.parse("2026-11-10T15:00:00Z") };
    const s = scope({ clock });
    expect(s.overLimit("0.49")).toBeNull();
    clock.t += 5 * 60_000;
    expect(
      s.check(BROWSER_PAGE_READ_TOOL, { site: "supplier", url: `${ORIGIN}/orders/7` }),
    ).toMatchObject({ ok: false, reason: expect.stringMatching(/limit of 5 minutes/) });
    expect(s.overLimit()).toBe("time");
    expect(s.needsHelp().question).toMatch(/within 5 minutes/);

    const c = scope();
    expect(c.overLimit("0.50")).toBe("cost");
    expect(c.needsHelp().question).toMatch(/within \$0\.50 of model time/);
  });

  it("asks the model's own question when it asked for help", () => {
    const s = scope();
    s.observe(
      BROWSER_PAGE_READ_TOOL,
      { site: "supplier", url: `${ORIGIN}/orders/7` },
      {
        status: "failed",
        error: "the site answered 500",
      },
    );
    expect(s.askedForHelp({ question: "  Which tab shows the delivery date?  " })).toEqual({
      question: "Which tab shows the delivery date?",
      tried: [
        "Looked for: Find the order's delivery date",
        `Could not open ${ORIGIN}/orders/7: the site answered 500`,
      ],
      remember: "[browse-help skill=custom:order-status sites=supplier]",
    });
  });
});

describe("help answers and paths in memory", () => {
  it("gives back this skill's answers for these sites, as data", () => {
    const s = scope();
    const tag = browseHelpTag("custom:order-status@1", ["supplier"]);
    const notes = [
      browseHelpNote(tag, "Where is the date?", "Under Shipments, not Orders."),
      browseHelpNote(browseHelpTag("custom:other", ["supplier"]), "q", "not ours"),
      browseHelpNote(browseHelpTag("custom:order-status", ["bank"]), "q", "other site"),
      "Vendor ACME is also called Acme Supply.",
    ];
    expect(s.data(notes)).toEqual({
      helpAnswers: ["Asked: Where is the date? Answer: Under Shipments, not Orders."],
      knownPaths: [],
    });
  });

  it("keeps a path that worked, and offers it as a script draft the second time, once", async () => {
    const run = () => {
      const s = scope();
      for (const [tool, url] of [
        [BROWSER_PAGE_READ_TOOL, `${ORIGIN}/orders/7`],
        [BROWSER_PAGE_READ_TOOL, `${ORIGIN}/orders/7`],
        [BROWSER_FILE_DOWNLOAD_TOOL, `${ORIGIN}/invoices`],
      ] as const) {
        s.observe(tool, { site: "supplier", url }, { status: "done", output: { url } });
      }
      return s;
    };
    const first = await run().finish([]);
    expect(first.operatorItem).toBeUndefined();
    expect(first.memory).toEqual([
      expect.stringMatching(
        /^\[browse-path skill=custom:order-status fp=[0-9a-f]{16}\] supplier\/orders\/\* > supplier\/invoices$/,
      ),
    ]);
    const notes = [...(first.memory ?? [])];
    // Another record, the same pages: the same path.
    const second = await run().finish(notes);
    expect(second.memory).toEqual([
      expect.stringMatching(/^\[browse-script-offered skill=custom:order-status fp=/),
    ]);
    expect(second.operatorItem).toMatchObject({
      subjectType: BROWSE_SCRIPT_DRAFT_SUBJECT,
      title: expect.stringMatching(/worked twice: "Find the order's delivery date" on supplier/),
      payload: {
        draft: {
          kind: "browser_script",
          status: "draft",
          skill: "custom:order-status",
          sites: ["supplier"],
          timesSucceeded: 2,
          steps: [
            { tool: BROWSER_PAGE_READ_TOOL, site: "supplier", page: "/orders/*" },
            { tool: BROWSER_FILE_DOWNLOAD_TOOL, site: "supplier", page: "/invoices" },
          ],
        },
      },
    });
    notes.push(...(second.memory ?? []));
    expect(await run().finish(notes)).toEqual({});
    expect(scope().data(notes).knownPaths).toEqual(["supplier/orders/* > supplier/invoices"]);
    // Nothing read: nothing kept.
    expect(await scope().finish(notes)).toEqual({});
  });
});
