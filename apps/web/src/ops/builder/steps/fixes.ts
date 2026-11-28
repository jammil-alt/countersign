// How to settle each issue that stops Publish (owner, 2026-11-26: "suggested fixes, including a
// 'for this to work you would need to adjust x'"). Pure. Three kinds, never more than the issue
// allows:
// - a fix in one click, only where there is one sensible answer (deliver the only output, take a
//   removed output off an End, add the main line's End);
// - "For this to work…", where what has to change is somewhere else (an End, an earlier step, the
//   step's Data tab), with that place to open;
// - anything else is the Builder's: the host offers "Ask the Builder", which drafts a change to
//   read over and undo, never applied unseen.
// DECISION: no fix here changes an approval, a permission or who does a step: those stay the
// operator's call (invariant 8).
import type { BuilderIssue } from "./issues";
import { endSteps, ensureEnd, setEndOutputs } from "./model";
import type { UsesContext } from "./options";
import type { Workflow } from "./types";

export interface IssueFix {
  /** One click, one sensible answer. */
  apply?: { label: string; run(w: Workflow): Workflow };
  /** What has to change somewhere else for this to work, and where to open it (a step or output id). */
  elsewhere?: { text: string; open: string | null };
}

/** The main line's closing End, if it has one. */
function mainEnd(w: Workflow) {
  const last = w.steps.at(-1);
  return last?.kind === "end" ? last : null;
}

export function fixFor(issue: BuilderIssue, w: Workflow, ctx: UsesContext): IssueFix {
  switch (issue.code) {
    case "output_never_delivered": {
      const out = w.outputs.find((o) => o.id === issue.at);
      const end = mainEnd(w);
      if (!out) return {};
      return {
        ...(end
          ? {
              apply: {
                label: "Deliver it from the last End",
                run: (x: Workflow) => {
                  const e = mainEnd(x);
                  return e && !e.outputs.includes(out.id)
                    ? setEndOutputs(x, e.id, { outputs: [...e.outputs, out.id] })
                    : x;
                },
              },
            }
          : {}),
        elsewhere: {
          text: `For this to work, an End has to deliver “${out.name || "this output"}”: pick it on the End where this path finishes.`,
          open: end?.id ?? null,
        },
      };
    }
    case "end_empty": {
      const only = w.outputs.length === 1 ? w.outputs[0] : undefined;
      return only && issue.at
        ? {
            apply: {
              label: `Deliver “${only.name || "the output"}”`,
              run: (x) => setEndOutputs(x, issue.at as string, { outputs: [only.id] }),
            },
          }
        : {};
    }
    case "unknown_output": {
      const at = issue.at;
      if (!at) return {};
      return {
        apply: {
          label: "Take it off this End",
          run: (x) => {
            const e = endSteps(x).find((s) => s.id === at);
            if (!e) return x;
            const known = new Set(x.outputs.map((o) => o.id));
            return setEndOutputs(x, at, { outputs: e.outputs.filter((o) => known.has(o)) });
          },
        },
      };
    }
    case "no_end":
      return { apply: { label: "End the main line", run: (x) => ensureEnd(x) } };
    case "no_outputs":
      return {
        elsewhere: {
          text: "For this to work, say what the workflow produces: add an output under the chart, then pick it on the End.",
          open: null,
        },
      };
    case "output_incomplete": {
      const out = w.outputs.find((o) => o.id === issue.at);
      if (!out || (out.kind !== "write" && out.kind !== "save") || out.action) return {};
      const fits = ctx.actions.groups.flatMap((g) =>
        g.actions.filter((a) =>
          out.kind === "write" ? a.kind === "change" || a.kind === "send" : a.kind === "save",
        ),
      );
      const one = fits.length === 1 ? fits[0] : undefined;
      if (!one) return {};
      return {
        apply: {
          label: `Use ${ctx.actions.get(one.id)?.label ?? one.label}`,
          run: (x) => ({
            ...x,
            outputs: x.outputs.map((o) =>
              o.id === out.id ? ({ ...o, action: { action: one.id, input: {} } } as typeof o) : o,
            ),
          }),
        },
      };
    }
    case "input_missing": {
      const field = /"([^"]+)"/.exec(issue.message)?.[1] ?? "it";
      return {
        elsewhere: {
          text: `For this to work, an earlier step has to give “${field}”, or you set it in this step's Data tab.`,
          open: issue.at ?? null,
        },
      };
    }
    case "loop_writes":
      return {
        elsewhere: {
          text: "A Loop only reads. For this to work, make the change in a step after the Loop, from what it decided.",
          open: issue.at ?? null,
        },
      };
    case "for_each_list_missing":
      return {
        elsewhere: {
          text: "For this to work, a step before it has to give a list (the lines of a bill, the receipts in a message) to go through.",
          open: issue.at ?? null,
        },
      };
    default:
      return {};
  }
}
