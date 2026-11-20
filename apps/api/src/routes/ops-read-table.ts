// Back office: Read table's sample-file check (owner, 2026-11-20; docs/plan.md §1.164). In the
// builder's inspector the operator picks a sample file for a Read table step; it is read here with
// the step's effective parameters (its own over the agent's, over the skill's defaults), exactly
// as the step would read a client's document, and the answer says which file header each expected
// column took, what is missing and the first rows. Nothing is stored or sent to a model; operator
// only, audited by `mount`.

import { readTableFile, TableFileError } from "@countersign/connectors";
import {
  parameterValueProblems,
  parseSkillRef,
  processes,
  type ReadTableSampleView,
  resolveSkillParameters,
  routes,
} from "@countersign/core";
import type { Hono } from "hono";
import { type AppEnv, HttpError, mount } from "../http";
import { agentInScope } from "./ops-lineage";

/** At most this many rows and problems come back to the builder. */
const ROWS_SHOWN = 5;
const PROBLEMS_SHOWN = 20;

function bytesOf(base64: string): Uint8Array {
  try {
    return Uint8Array.from(atob(base64.replace(/\s/g, "")), (c) => c.charCodeAt(0));
  } catch {
    throw new HttpError(400, "invalid_request", "the file isn't base64");
  }
}

export function opsReadTableRoutes(app: Hono<AppEnv>): void {
  mount(app, routes.opsReadTableSample, async (ctx): Promise<ReadTableSampleView> => {
    const { body, services } = ctx;
    await agentInScope(ctx, ctx.params.id);
    const parsed = processes.Process.safeParse(body.process);
    if (!parsed.success) {
      throw new HttpError(422, "invalid_process", "the workflow doesn't read in the new format");
    }
    const step = processes.findStep(parsed.data, body.stepId)?.step;
    if (step?.kind !== "skill" || !processes.isReadTableStep(step)) {
      throw new HttpError(422, "not_a_read_table_step", `no Read table step "${body.stepId}"`);
    }
    const def = services.platform.catalog.get(processes.READ_TABLE_SKILL);
    if (!def) throw new HttpError(503, "unavailable", "Read table isn't registered here");
    const agent = body.agentSkills?.find(
      (s) => parseSkillRef(s.skill).id === processes.READ_TABLE_SKILL,
    )?.parameters;
    const parameters = resolveSkillParameters(def, {
      agent,
      step: step.customize?.parameters,
    });
    const problems = parameterValueProblems(def, parameters);
    if (problems.length > 0) {
      throw new HttpError(
        422,
        "invalid_parameters",
        `Read table's parameters: ${problems.map((p) => p.message).join("; ")}`,
      );
    }
    const options = processes.readTableOptions(parameters);
    if (!options.ok) throw new HttpError(422, "invalid_parameters", options.error);

    const bytes = bytesOf(body.file.base64);
    let file: ReturnType<typeof readTableFile>;
    try {
      file = readTableFile(
        { bytes, mimeType: body.file.mimeType, filename: body.file.filename },
        options.options,
      );
    } catch (error) {
      if (error instanceof TableFileError) {
        throw new HttpError(422, "unreadable_file", error.message);
      }
      throw error;
    }
    const { read } = file;
    return {
      kind: file.kind,
      sheet: read.sheet,
      sheets: file.sheets,
      columns: read.columns,
      unmatched: read.unmatched,
      rows: read.rows.slice(0, ROWS_SHOWN),
      rowCount: read.rows.length,
      problems: read.problems.slice(0, PROBLEMS_SHOWN),
      problemCount: read.problems.length,
      failure: read.failure,
    };
  });
}
