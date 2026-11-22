// What the model gets (owner, 2026-11-21: "for AI steps… instructions, knowledge base and
// memory… a way to look at what the prompt will look like when it comes in"; docs/plan.md
// §1.180). On a skill step's setup: the system prompt part by part, each with where it comes
// from, the tools the model may call, and what arrives beside the step's input (the agent's
// notes). Asked of the server with the draft as it is drawn, so an unsaved change shows; the
// server builds it with the runtime's own builders, so it is what a run would send.
import type { processes, StepPromptPreview } from "@countersign/core";
import { type ReactNode, useState } from "react";
import { apiRoutes } from "../../api/routes";
import { Icon } from "../../ui/icons";
import { Button } from "../../ui/primitives";
import { errorText, Notice, useAction } from "../agents/ui";

type Part = StepPromptPreview["system"][number];

const PART_TITLE: Record<Part["key"], string> = {
  governance: "Ground rules",
  finish: "How it finishes",
  identity: "Who the agent is",
  agent_instructions: "How the agent works",
  task: "This step's instructions",
  settings: "Settings",
  parameters: "Parameters",
  language: "Language",
};

/** "our guardrails, the client's charter and 2 policies". */
function governanceWords(read: StepPromptPreview["governance"]): string {
  const said: string[] = [];
  if (read.some((r) => r.tier === "guardrails")) said.push("our guardrails");
  if (read.some((r) => r.tier === "charter")) said.push("the client's charter");
  const policies = read.filter((r) => r.tier !== "guardrails" && r.tier !== "charter").length;
  if (policies > 0) said.push(`${policies} ${policies === 1 ? "policy" : "policies"}`);
  if (said.length <= 1) return said[0] ?? "our guardrails";
  return `${said.slice(0, -1).join(", ")} and ${said.at(-1)}`;
}

/** Where a part comes from, in a line under its title. */
function partFrom(key: Part["key"], view: StepPromptPreview): string {
  switch (key) {
    case "governance":
      return `Read first on every step: ${governanceWords(view.governance)}.`;
    case "finish":
      return "Ours, the same on every step.";
    case "identity":
      return "From the agent's setup: its name, role and mission.";
    case "agent_instructions":
      return "The agent's own instructions, from its setup.";
    case "task":
      return "The skill's instructions, then what this step adds to them.";
    case "settings":
      return "The skill's settings, with the agent's and this step's over them.";
    case "parameters":
      return "The values this step runs the skill with.";
    case "language":
      return "The client's language, from their settings.";
  }
}

function Fold({
  title,
  from,
  testId,
  open,
  children,
}: {
  title: string;
  from?: string | undefined;
  testId: string;
  open?: boolean;
  children: ReactNode;
}) {
  return (
    <details className="rounded-sm border border-line" data-testid={testId} open={open}>
      <summary className="flex cursor-pointer flex-col gap-0.5 px-3 py-2">
        <span className="text-sm font-medium text-ink">{title}</span>
        {from ? <span className="text-xs text-ink-muted">{from}</span> : null}
      </summary>
      <div className="border-t border-line px-3 py-2">{children}</div>
    </details>
  );
}

const TEXT = "whitespace-pre-wrap break-words font-mono text-xs leading-5 text-ink";

export function PromptPreview({
  agentId,
  workflow,
  definition,
  step,
}: {
  agentId: string;
  /** The workflow as it is drawn, unsaved changes included. */
  workflow: processes.Process;
  /** The agent's setup as drafted. */
  definition: unknown;
  step: { id: string };
}) {
  const ask = useAction();
  const [view, setView] = useState<StepPromptPreview | null>(null);
  const [copied, setCopied] = useState(false);

  async function load() {
    setCopied(false);
    const res = await ask.call(apiRoutes.opsStepPromptPreview, {
      params: { id: agentId },
      body: { process: workflow, stepId: step.id, definition },
    });
    if (res.ok) setView(res.data);
  }

  const whole = view ? view.system.map((p) => p.text).join("\n\n") : "";
  const memory = view?.data.memory;
  return (
    <section
      className="flex flex-col gap-3 border-t border-line pt-4"
      data-testid="builder-prompt-preview"
    >
      <h3 className="eyebrow text-ink-muted">What the model gets</h3>
      {view ? null : (
        <p className="text-sm text-ink-muted">
          The prompt this step sends, part by part, with its tools and the agent's notes. Built from
          the workflow as it is drawn now; nothing runs.
        </p>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <Button
          variant="secondary"
          size="sm"
          data-testid="builder-prompt-preview-show"
          disabled={ask.busy}
          onClick={load}
        >
          {view ? "Read it again" : "Show the prompt"}
        </Button>
        {view && view.runs === "model" ? (
          <Button
            variant="ghost"
            size="sm"
            data-testid="builder-prompt-preview-copy"
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(whole);
                setCopied(true);
              } catch {
                setCopied(false);
              }
            }}
          >
            <Icon name="copy" size={14} />
            {copied ? "Copied" : "Copy the system prompt"}
          </Button>
        ) : null}
      </div>
      {ask.error ? (
        <Notice tone="warning" testId="builder-prompt-preview-error">
          {errorText(ask.error)}
        </Notice>
      ) : null}
      {view?.problems.length ? (
        <Notice tone="warning" testId="builder-prompt-preview-problems">
          It can't run as drawn: {view.problems.join("; ")}
        </Notice>
      ) : null}
      {view && view.runs !== "model" ? (
        <p className="text-sm text-ink" data-testid="builder-prompt-preview-none">
          {view.runs === "rules"
            ? "No model does this step: it runs its rule rows, so there is no prompt."
            : "No model does this step: it runs as code, so there is no prompt."}
        </p>
      ) : null}
      {view && view.runs === "model" ? (
        <>
          <p className="text-sm text-ink" data-testid="builder-prompt-preview-model">
            Runs on <span className="font-mono text-xs">{view.model?.id}</span>.{" "}
            {view.skill.mode === "task"
              ? "A task skill is the same job in any agent, so it gets our ground rules and its own instructions, and not the agent's identity, instructions or notes."
              : "It works as the agent: its identity, its instructions and its notes come with it."}
          </p>
          <div className="flex flex-col gap-2" data-testid="builder-prompt-preview-system">
            {view.system.map((part) => (
              <Fold
                key={part.key}
                title={PART_TITLE[part.key]}
                from={partFrom(part.key, view)}
                testId={`builder-prompt-part-${part.key}`}
                open={part.key === "task"}
              >
                <pre className={TEXT}>{part.text}</pre>
              </Fold>
            ))}
          </div>
          <Fold
            title={`Tools it may call (${view.tools.length})`}
            from="The skill's own, the agent's extra tools, then ours for finishing and reading the input."
            testId="builder-prompt-tools"
          >
            <ul className="flex flex-col gap-2">
              {view.tools.map((t) => (
                <li key={t.id} className="flex flex-col gap-0.5">
                  <span className="font-mono text-xs text-ink">{t.id}</span>
                  <span className="text-xs text-ink-muted">{t.description}</span>
                </li>
              ))}
            </ul>
          </Fold>
          <Fold
            title="What arrives as data"
            from="Never as instructions: the step's input and what the agent knows come as a tool's result."
            testId="builder-prompt-data"
            open
          >
            <div className="flex flex-col gap-2 text-sm text-ink">
              <p>
                The first message says: <span className="text-ink-muted">“{view.turn}”</span>
              </p>
              <p data-testid="builder-prompt-data-keys">
                Then it is handed: {view.data.keys.join(", ")}. The input is what the steps before
                this one produced, so it is only known in a run or a try.
              </p>
              {memory?.given ? (
                memory.notes.length > 0 ? (
                  <>
                    <p data-testid="builder-prompt-memory">
                      The agent's notes for this client, newest first ({memory.notes.length}). It
                      writes them itself during runs, and each step is handed up to 50.
                    </p>
                    <ul className="flex list-disc flex-col gap-1 pl-5 text-sm">
                      {memory.notes.map((n, i) => (
                        // biome-ignore lint/suspicious/noArrayIndexKey: notes may repeat; the list never reorders.
                        <li key={i}>{n}</li>
                      ))}
                    </ul>
                  </>
                ) : (
                  <p data-testid="builder-prompt-memory">
                    The agent's notes come with it, and it has none yet. It writes them itself
                    during runs.
                  </p>
                )
              ) : (
                <p data-testid="builder-prompt-memory">
                  {memory?.enabled
                    ? "No notes: a task skill is not handed the agent's notes."
                    : "No notes: this agent keeps none."}
                </p>
              )}
              <p className="text-ink-muted">
                Other knowledge (the client's FAQs, documents and policies not named above) is not
                in the prompt. The model reaches it only by searching, when the step has a search
                tool in the list above.
              </p>
            </div>
          </Fold>
        </>
      ) : null}
    </section>
  );
}
