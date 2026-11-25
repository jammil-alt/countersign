// More (§5): what most steps never touch, folded. Model (AI), if it fails, whether the client sees
// it. Deadline and channel live with a person's or a contact's instructions, where they are said.
// "Run by another agent" is the step's `agent` (a slug of the client's other agents).

import { SmallInput, SmallSelect } from "../fields";
import type { StepFormEnv } from "./form-kit";
import type { DoStep } from "./types";

export function MoreSection({
  step,
  env,
  onChange,
}: {
  step: DoStep;
  env: StepFormEnv;
  onChange(next: DoStep): void;
}) {
  const aiHere = step.doneBy === "ai" && step.uses === undefined;
  return (
    <details className="border-t border-line pt-3" data-testid="do-more">
      <summary className="eyebrow cursor-pointer text-ink-muted">More</summary>
      <div className="mt-3 flex flex-col gap-3">
        {aiHere ? (
          <div className="flex flex-col gap-1 text-sm text-ink">
            Model
            <SmallSelect
              aria-label="Model"
              value={step.ai?.model?.id ?? ""}
              onChange={(e) => {
                const { model: _m, ...rest } = step.ai ?? {};
                onChange({
                  ...step,
                  ai: e.target.value ? { ...rest, model: { id: e.target.value } } : rest,
                });
              }}
            >
              <option value="">The default</option>
              {env.models.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label}
                </option>
              ))}
            </SmallSelect>
          </div>
        ) : null}
        <div className="flex flex-col gap-1 text-sm text-ink">
          Run by another agent
          <SmallSelect
            aria-label="Run by another agent"
            value={step.agent ?? ""}
            onChange={(e) => {
              const { agent: _a, ...rest } = step;
              onChange(e.target.value ? { ...rest, agent: e.target.value } : rest);
            }}
          >
            <option value="">This agent</option>
            {(env.agents ?? []).map((a) => (
              <option key={a.slug} value={a.slug}>
                {a.name}
              </option>
            ))}
          </SmallSelect>
        </div>
        <div className="flex flex-col gap-1 text-sm text-ink">
          If it fails
          <SmallSelect
            aria-label="If it fails"
            value={step.onError === "continue" ? "continue" : "fail"}
            onChange={(e) => {
              const { onError: _o, ...rest } = step;
              onChange(e.target.value === "continue" ? { ...rest, onError: "continue" } : rest);
            }}
          >
            <option value="fail">Stop the run</option>
            <option value="continue">Go on</option>
          </SmallSelect>
        </div>
        <div className="flex flex-col gap-1.5">
          <label className="flex items-center gap-2 text-sm text-ink">
            <input
              type="checkbox"
              aria-label="The client sees this step"
              checked={step.client?.visible ?? false}
              onChange={(e) => {
                const { client: _c, ...rest } = step;
                onChange(
                  e.target.checked
                    ? {
                        ...rest,
                        client: {
                          visible: true,
                          ...(step.client?.label ? { label: step.client.label } : {}),
                        },
                      }
                    : { ...rest, client: { visible: false } },
                );
              }}
            />
            The client sees this step
          </label>
          {step.client?.visible ? (
            <SmallInput
              aria-label="What the client sees it called"
              placeholder="What the client sees it called"
              value={step.client.label ?? ""}
              onChange={(e) =>
                onChange({
                  ...step,
                  client: { visible: true, ...(e.target.value ? { label: e.target.value } : {}) },
                })
              }
            />
          ) : null}
        </div>
        {step.doneBy === "person" || step.doneBy === "contact" ? (
          <p className="text-xs text-ink-muted">
            The deadline and the channel are set under Instructions.
          </p>
        ) : null}
      </div>
    </details>
  );
}
