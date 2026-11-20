// docs/plan.md §1.164 step 3 ("Zoho's fields"): a write's input typed from a client's own fields
// (`toolInputs`, per literal `module`), and Reshape data before it proposing those fields by API name
// and by label, the write reading the whole Reshape output as its record.

import { describe, expect, it } from "vitest";
import type { JsonSchema } from "../schemas/common";
import type { SkillDefinition } from "../schemas/skill";
import type { ToolSpec } from "../schemas/tool";
import { type TypingContext, toolInputSchema } from "../template/typer";
import { RESHAPE_SKILL, stepInputSchema } from "./reshape";
import { proposeReshape, recordInputKey, reshapeContext, wireToReshape } from "./reshape-propose";
import { Process, type Step } from "./schema";
import { validateProcess } from "./validate";

const UPDATE = "zoho_crm.record.update";

/** The tool's own input: `fields` is any record (as the connector declares it). */
const updateInput: JsonSchema = {
  type: "object",
  properties: {
    module: { type: "string", enum: ["Leads", "Contacts", "Accounts", "Deals"] },
    id: { type: "string" },
    fields: { type: "object", additionalProperties: {} },
    expectedModifiedTime: { type: "string" },
  },
  required: ["module", "id", "fields"],
};

/** What apps/api builds from the client's Zoho fields (the connector's zohoToolInputs). */
const leadRecord: JsonSchema = {
  type: "object",
  properties: {
    Last_Name: { title: "Last Name", type: "string", maxLength: 80 },
    Email: { title: "Email", type: "string", maxLength: 100, format: "email" },
    Company: { title: "Company", type: "string", maxLength: 200 },
    Region: { title: "Sales region", type: "string", enum: ["North", "South", "West"] },
    Last_Import_Date: { title: "Last import date", type: "string", format: "date" },
  },
  "x-record": true,
};
const leadsUpdate: JsonSchema = {
  ...updateInput,
  properties: {
    ...(updateInput.properties as Record<string, JsonSchema>),
    module: { type: "string", const: "Leads" },
    fields: leadRecord,
  },
};

const updateTool: ToolSpec = {
  id: UPDATE,
  description: "Change fields of a Zoho CRM record.",
  input: updateInput,
  output: { type: "object", properties: { id: { type: "string" } } },
  sideEffect: "external",
  verb: "update",
  source: "zoho_crm",
  connector: "zoho_crm",
};

const reshapeSkill: SkillDefinition = {
  schemaVersion: 1,
  id: RESHAPE_SKILL,
  name: "Reshape data",
  description: "Reshapes data.",
  category: "data",
  mode: "tool",
  handler: "data.reshape",
  tools: ["data.reshape"],
  input: { type: "object", additionalProperties: true },
  output: { type: "object", additionalProperties: true },
  settings: [],
  requiresConnectors: [],
  requiresPacks: [],
  producesAlerts: false,
};

/** What publish validation types with: the tools' own inputs. */
const plain: TypingContext = {
  skills: { [RESHAPE_SKILL]: reshapeSkill },
  tools: { [UPDATE]: updateTool },
};
/** What the builder types with for a client agent. */
const ctx: TypingContext = {
  ...plain,
  toolInputs: { [UPDATE]: { by: "module", schemas: { Leads: leadsUpdate } } },
};

/** A row of the client's sheet, as Read table would type it, then Reshape, then the update. */
function sheetProcess(module = "Leads"): Process {
  return Process.parse({
    schemaVersion: 4,
    triggers: [
      {
        id: "t",
        on: {
          type: "manual",
          input: {
            type: "object",
            properties: {
              row: {
                type: "object",
                properties: {
                  leadId: { type: "string" },
                  email: { type: "string" },
                  company: { type: "string" },
                  salesRegion: { type: "string" },
                  lastImportDate: { type: "string" },
                },
              },
            },
          },
        },
      },
    ],
    steps: [
      {
        id: "shape",
        kind: "skill",
        name: "Reshape data",
        skill: RESHAPE_SKILL,
        input: {},
        reshape: { fields: [] },
      },
      {
        id: "update",
        kind: "write",
        name: "Update the lead",
        tool: UPDATE,
        input: { module, id: "{{trigger.row.leadId}}", fields: {} },
      },
    ],
  });
}

describe("a write typed from the client's own fields", () => {
  it("types a step by its literal module, and falls back to the tool's own input", () => {
    expect(toolInputSchema(UPDATE, { module: "Leads" }, ctx)).toBe(leadsUpdate);
    expect(toolInputSchema(UPDATE, { module: "Deals" }, ctx)).toBe(updateInput);
    // A module only known when it runs: the tool's own input.
    expect(toolInputSchema(UPDATE, { module: "{{trigger.module}}" }, ctx)).toBe(updateInput);
    expect(toolInputSchema(UPDATE, { module: "Leads" }, plain)).toBe(updateInput);
    const step = sheetProcess().steps[1] as Step;
    expect(stepInputSchema(step, ctx)).toBe(leadsUpdate);
    expect(recordInputKey(leadsUpdate)).toBe("fields");
    expect(recordInputKey(updateInput)).toBeNull();
  });

  it("proposes the client's custom fields by label as well as by API name", () => {
    const process = sheetProcess();
    const context = reshapeContext(process, "shape", ctx);
    expect(context?.next).toMatchObject({ stepId: "update", into: "fields" });
    if (!context) return;
    const p = proposeReshape({ context });
    const from = Object.fromEntries(p.mapping.fields.map((f) => [f.name, f.from]));
    expect(from).toEqual({
      Last_Name: undefined,
      Email: { input: "trigger.row.email" },
      Company: { input: "trigger.row.company" },
      // "Sales region" is the label of the custom field `Region`.
      Region: { input: "trigger.row.salesRegion" },
      Last_Import_Date: { input: "trigger.row.lastImportDate" },
    });
    expect(p.how).toEqual({
      Email: "name",
      Company: "name",
      Region: "name",
      Last_Import_Date: "name",
    });
    expect(p.unmapped).toEqual(["Last_Name"]);
    // The field keeps its label and type, so the builder shows "Sales region".
    expect(p.mapping.fields.find((f) => f.name === "Region")?.schema).toMatchObject({
      title: "Sales region",
      enum: ["North", "South", "West"],
    });
    // Without its label, `Region` isn't found from `salesRegion`.
    const untitled: JsonSchema = {
      ...leadRecord,
      properties: {
        ...(leadRecord.properties as Record<string, JsonSchema>),
        Region: { type: "string" },
      },
    };
    const bare = proposeReshape({
      context: { ...context, next: { stepId: "update", name: "", schema: untitled } },
    });
    expect(bare.mapping.fields.find((f) => f.name === "Region")?.from).toBeUndefined();
  });

  it("wires the write's record to the whole Reshape output, keeping its module and record id", () => {
    const process = sheetProcess();
    const context = reshapeContext(process, "shape", ctx);
    if (!context) throw new Error("no context");
    const p = proposeReshape({ context });
    const update = process.steps[1] as Step & { input: Record<string, unknown> };
    const wired = wireToReshape(update.input, "shape", p.mapping, stepInputSchema(update, ctx));
    expect(wired).toEqual({
      module: "Leads",
      id: "{{trigger.row.leadId}}",
      fields: "{{steps.shape.output}}",
    });
    const done = Process.parse({
      ...process,
      steps: [
        { ...(process.steps[0] as Step), input: p.input, reshape: p.mapping },
        { ...update, input: wired },
      ],
    });
    // Validated as at publish (the tool's own input) and as the builder types it.
    const reshapeErrors = (c: TypingContext) =>
      validateProcess(done, c).errors.filter((e) => e.stepId === "shape");
    expect(reshapeErrors(plain)).toEqual([]);
    expect(reshapeErrors(ctx)).toEqual([]);
  });

  it("leaves a module without a field list as before: the tool's own input is the target", () => {
    const context = reshapeContext(sheetProcess("Deals"), "shape", ctx);
    expect(context?.next?.into).toBeUndefined();
    expect(Object.keys((context?.next?.schema.properties ?? {}) as object)).toEqual([
      "module",
      "id",
      "fields",
      "expectedModifiedTime",
    ]);
  });
});
