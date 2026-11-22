// R2 (docs/plan.md §1.86, §9): the skill schema gained `method`, `reads`, `browse` and `rules`.
// A built-in skill pinned by a stored version, or a `skill_version` row, is read again under the
// new schema, so re-parsing a registered built-in must neither fail nor add a field (a default)
// that would move its hash (invariant 3). No database: the catalog is code.

import { hashJson, isToolWrapper, SkillDefinition } from "@countersign/core";
import { describe, expect, it } from "vitest";
import { createPlatform, deploymentConnectors } from "./platform";

// The catalog a deployment builds (every connector registered, outside production), as
// platformFor does.
const platform = createPlatform({ connectors: deploymentConnectors({}, false) });
const builtins = platform.catalog.list();

// DECISION: both counts are pinned (the owner's inventory: 100 skills, 85 of them only a tool by
// another name), so retiring wrappers in R2, or a new connector read, changes them on purpose.
// Wave 4: `browser.script.read`, a connector read, adds its read skill (a wrapper) to both.
// §1.87: BILL's six reads add six more.
// Skill model (2026-11-10): the splits add 16 that are no wrappers: Read document and Check
// totals; Look up existing, Match the unmatched, Check matches, Compare to historicals, Read a
// vendor's quote, Choose items to merge; Bookkeeping's three and Marketing's five AI skills.
// The templates add three AI skills: Choose items and accounts, Prepare bill, Explain a problem.
// Review: Check bill, the deterministic check after Prepare bill.
// Reshape data (2026-11-11): data.reshape, a built-in code skill (not a wrapper).
// §1.88: the vendor-first matching adds four: Match vendor, Match by SKU (vendor), Semantic match
// (vendor), Master item manager (the AI two kept for stored steps: new steps take the Library
// skills the pack installs, which are not built-ins).
// §1.104: vendor contracts add two that are no wrappers: Read a vendor contract (AI) and Review
// notes for AP (built-in code).
// §1.113: Odoo's two reads (search and get) add two read skills, both wrappers.
// §1.114: three connector reads, each a wrapper: excel.range.read, and the calendars' shared
// calendar.events.list and calendar.freebusy (registered once for both; OneDrive's
// drive.file.list is Google Drive's, already counted).
// §1.121: forms.request (a step-only skill on its handler, counted as a wrapper like
// comms.reach-out) and forms.draft (an AI task skill).
// §1.123: data.group-list, a built-in code skill (its handler in `tools`, not a wrapper).
// §1.164: the Sales pack's four tool skills (Match to CRM, Refresh CRM records for matching,
// Look up CRM records, Confirmed matches), each a wrapper of its tool; data.read-table and
// data.write-table, built-in code skills (not wrappers); Zoho CRM's field list
// (zoho_crm.field.list), a connector read, so a wrapper.
// §1.187: QuickBooks' qbo.banking.find (a booking already written), a connector read, so a
// wrapper.
// §1.205 (C2.4): Materials' materials.qbo-item (a catalog item tied to its QuickBooks item), a
// tool skill over one handler, so a wrapper.
// §1.204: the desktop app's three reads (desktop.files.list, desktop.file.read,
// desktop.xlsx.read), each a wrapper.
const BUILTINS = 154;
const WRAPPERS = 108;

describe("built-in skills under the R2 skill schema", () => {
  it("registers the platform's, the packs' and each connector's read skills, once each", () => {
    expect(builtins.length).toBe(BUILTINS);
    expect(new Set(builtins.map((s) => s.id)).size).toBe(builtins.length);
  });

  it("parses every one unchanged: same fields, same hash", async () => {
    for (const def of builtins) {
      const stored = JSON.parse(JSON.stringify(def)) as unknown;
      const parsed = SkillDefinition.safeParse(stored);
      expect(parsed.success, def.id).toBe(true);
      if (!parsed.success) continue;
      expect(Object.keys(parsed.data).sort(), def.id).toEqual(Object.keys(def).sort());
      expect(await hashJson(parsed.data), def.id).toBe(await hashJson(stored));
      // No built-in names a method yet: it is derived from `mode` (skillMethod).
      expect(parsed.data.method, def.id).toBeUndefined();
    }
  });

  it("counts the tool wrappers that retire (a process reads or writes the tool directly)", () => {
    // Every connector read skill (connectorReadSkills) is one, plus the platform's tool-mode
    // built-ins that call only their handler.
    const wrappers = builtins.filter(isToolWrapper);
    expect(wrappers.length).toBe(WRAPPERS);
    expect(wrappers.every((s) => s.mode === "tool" && s.tools.length === 0)).toBe(true);
  });
});
