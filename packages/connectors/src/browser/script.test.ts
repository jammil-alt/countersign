// Scripted site tools against the fake supplier portal (docs/plan.md §1.86 "Scripts (wave 4)"): a
// published read script runs in one signed-in session and gives back typed outputs; a write script
// submits once, only when run as the write tool; a test run never clicks the submit; an element
// that isn't there asks for help with what was tried; a page the site doesn't allow is refused; a
// draft (nothing published) and the wrong tool are refused before a browser opens.

import {
  BrowserScriptDefinition,
  type BrowserScriptDefinitionInput,
  type PublishedBrowserScript,
} from "@countersign/core";
import { describe, expect, it } from "vitest";
import { captureBefore, executeWrite, runReadTool } from "../invoke";
import { failure, ORIGIN, PASSWORD, setUp, USERNAME } from "./browser.test-helper";
import { BROWSER_SCRIPT_READ_TOOL, BROWSER_SCRIPT_SUBMIT_TOOL } from "./ids";
import { runScriptSteps } from "./script";
import { withBrowserSession } from "./session";

const ALLOW = [`${ORIGIN}/home`, `${ORIGIN}/invoices*`, `${ORIGIN}/orders*`];

function published(slug: string, def: BrowserScriptDefinitionInput): PublishedBrowserScript {
  return {
    id: `script-${slug}`,
    slug,
    versionId: `version-${slug}`,
    version: 1,
    definition: BrowserScriptDefinition.parse(def),
  };
}

const STOCK = published("stock", {
  schemaVersion: 1,
  site: "supplier",
  name: "Check stock",
  inputs: [{ name: "sku", label: "SKU", type: "text" }],
  outputs: [{ name: "stock", label: "In stock", type: "integer" }],
  steps: [
    { id: "s1", op: "open", url: `${ORIGIN}/orders/lookup?sku={{sku}}` },
    { id: "s2", op: "read_field", selector: "#stock", output: "stock" },
  ],
  sideEffect: "none",
});

const ORDER = published("order", {
  schemaVersion: 1,
  site: "supplier",
  name: "Place an order",
  inputs: [
    { name: "sku", label: "SKU", type: "text" },
    { name: "qty", label: "Quantity", type: "integer" },
  ],
  outputs: [{ name: "price", label: "Unit price", type: "decimal" }],
  steps: [
    { id: "s1", op: "open", url: `${ORIGIN}/orders/new` },
    { id: "s2", op: "fill", selector: "#sku", value: { input: "sku" } },
    { id: "s3", op: "fill", selector: "#qty", value: { input: "qty" } },
    { id: "s4", op: "read_field", selector: "#price", output: "price" },
    { id: "s5", op: "click", selector: "#place", submits: true },
  ],
  sideEffect: "external",
});

const MOVED = published("moved", {
  ...ORDER.definition,
  name: "Place an order (old form)",
  steps: ORDER.definition.steps.map((s) =>
    s.id === "s3" ? { ...s, selector: "#quantity" } : s,
  ) as BrowserScriptDefinitionInput["steps"],
});

const OFF_SITE = published("off-site", {
  ...STOCK.definition,
  name: "Read settings",
  steps: [
    { id: "s1", op: "open", url: `${ORIGIN}/account/settings?sku={{sku}}` },
    { id: "s2", op: "read_field", selector: "#stock", output: "stock" },
  ],
});

async function scripted(opts: Parameters<typeof setUp>[0] = {}) {
  const s = setUp({
    profile: { allow: ALLOW },
    scripts: { stock: STOCK, order: ORDER, moved: MOVED, "off-site": OFF_SITE },
    ...opts,
  });
  await s.identify();
  return s;
}

const key = "run-1:place:0";

describe("scripted site tools", () => {
  it("runs a published read script in one session and gives back its typed outputs", async () => {
    const s = await scripted();
    const r = await runReadTool(
      s.connector,
      BROWSER_SCRIPT_READ_TOOL,
      { site: "supplier", script: "stock", inputs: { sku: "OAK-1" } },
      s.ctx,
    );
    expect(r.output).toEqual({ stock: 42 });
    expect(s.portal.signIns).toBe(1);
    expect(s.portal.signOuts).toBe(1);
    expect(s.records).toHaveLength(1);
    expect(s.records[0]).toMatchObject({
      tool: BROWSER_SCRIPT_READ_TOOL,
      outcome: "done",
      pages: [`${ORIGIN}/orders/lookup?sku=OAK-1`],
    });
    // The login was typed by our sign-in only, never by the script.
    const typed = s.driver.events.flatMap((e) => (e.op === "fill" ? [e.value] : []));
    expect(typed).toEqual([USERNAME, PASSWORD, "481516"]);
  });

  it("checks the inputs against the script's declarations before a browser opens", async () => {
    const s = await scripted();
    const why = await failure(
      runReadTool(
        s.connector,
        BROWSER_SCRIPT_READ_TOOL,
        { site: "supplier", script: "stock", inputs: { sku: "OAK-1", extra: "x" } },
        s.ctx,
      ),
    );
    expect(why).toMatch(/can't take these inputs/);
    expect(s.driver.opened).toBe(0);
  });

  it("refuses a script that isn't published, and a write run as the read tool", async () => {
    const s = await scripted();
    expect(
      await failure(
        runReadTool(
          s.connector,
          BROWSER_SCRIPT_READ_TOOL,
          { site: "supplier", script: "draft-only", inputs: {} },
          s.ctx,
        ),
      ),
    ).toMatch(/no published script "draft-only"/);
    expect(
      await failure(
        runReadTool(
          s.connector,
          BROWSER_SCRIPT_READ_TOOL,
          { site: "supplier", script: "order", inputs: { sku: "OAK-1", qty: 2 } },
          s.ctx,
        ),
      ),
    ).toMatch(/submits a form/);
    expect(s.driver.opened).toBe(0);
  });

  it("submits a write script once, as the write tool, and reads what it declared", async () => {
    const s = await scripted();
    const input = { site: "supplier", script: "order", inputs: { sku: "OAK-1", qty: 2 } };
    const before = await captureBefore(s.connector, BROWSER_SCRIPT_SUBMIT_TOOL, input, s.ctx);
    expect(before.before).toBeNull();
    expect(s.driver.opened).toBe(0);
    const out = await executeWrite(s.connector, BROWSER_SCRIPT_SUBMIT_TOOL, input, {
      ...s.ctx,
      idempotencyKey: key,
    });
    expect(out.output).toEqual({
      price: "1212.50",
      submitted: true,
      url: `${ORIGIN}/orders`,
      reverse: null,
    });
    expect(s.portal.orders).toEqual([{ number: "ORD-1", sku: "OAK-1", qty: "2" }]);
    expect(s.records[0]?.actions.map((a) => a.kind)).toEqual(["fill", "fill", "read", "click"]);
    // The record names the fields, never what was typed in them.
    expect(JSON.stringify(s.records)).not.toContain("OAK-1");
  });

  it("refuses a write where the client turned writes off, before an approval card", async () => {
    const s = await scripted({ stricter: { noWrites: true } });
    const input = { site: "supplier", script: "order", inputs: { sku: "OAK-1", qty: 2 } };
    expect(
      await failure(captureBefore(s.connector, BROWSER_SCRIPT_SUBMIT_TOOL, input, s.ctx)),
    ).toMatch(/no changes are made/);
  });

  it("never clicks the submit in a dry run (a recording or a test)", async () => {
    const s = await scripted();
    const run = await withBrowserSession(
      s.ctx,
      { tool: "test", site: "supplier" },
      { codePoll: { intervalMs: 0, attempts: 1 } },
      (page) =>
        runScriptSteps(
          page,
          ORDER.definition.steps,
          { sku: "OAK-1", qty: 2 },
          ORDER.definition.outputs,
          {
            dryRun: true,
            everyStep: true,
          },
        ),
    );
    expect(run.submitted).toBe(false);
    expect(run.steps.at(-1)).toMatchObject({ id: "s5", status: "skipped" });
    expect(run.steps.every((st) => st.screenshot !== null)).toBe(true);
    expect(run.outputs).toEqual({ price: "1212.50" });
    expect(s.portal.orders).toEqual([]);
  });

  it("asks for help when an element isn't there, and submits nothing", async () => {
    const s = await scripted();
    const out = await executeWrite(
      s.connector,
      BROWSER_SCRIPT_SUBMIT_TOOL,
      { site: "supplier", script: "moved", inputs: { sku: "OAK-1", qty: 2 } },
      { ...s.ctx, idempotencyKey: key },
    );
    const output = out.output as {
      submitted: boolean;
      needsHelp: { question: string; tried: string[] };
    };
    expect(output.submitted).toBe(false);
    expect(output.needsHelp.question).toMatch(/couldn't find #quantity/);
    expect(output.needsHelp.tried.at(-1)).toMatch(/Step s3 \(fill\) found no #quantity/);
    expect(s.portal.orders).toEqual([]);
    expect(s.driver.events.some((e) => e.op === "click" && e.selector === "#place")).toBe(false);
    // Signed out all the same.
    expect(s.portal.signOuts).toBe(1);
  });

  it("refuses a page the site doesn't allow, and reads nothing there", async () => {
    const s = await scripted();
    const why = await failure(
      runReadTool(
        s.connector,
        BROWSER_SCRIPT_READ_TOOL,
        { site: "supplier", script: "off-site", inputs: { sku: "OAK-1" } },
        s.ctx,
      ),
    );
    expect(why).toMatch(/BrowserRefused: .*agents never open this page/);
    expect(s.driver.events.some((e) => e.op === "goto" && e.url.includes("/account"))).toBe(false);
    expect(s.portal.signOuts).toBe(1);
  });
});
