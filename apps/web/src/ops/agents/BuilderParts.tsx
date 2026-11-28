// The Builder in the back office (ARCHITECTURE §9.6): on an agent page, Revise asks the Builder for a
// new draft from an instruction or one of the client's requests and shows what changed. New agents
// are drafted by conversation (NewAgentConversation, O5).
import type { AgentBundle } from "@countersign/core";
import { useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import type { ResponseOf } from "../../api/client";
import { type AgentSummary, apiRoutes } from "../../api/routes";
import { useApi } from "../../api/useApi";
import { Badge, Button, buttonClass, Card, SectionLabel } from "../../ui/primitives";
import { parseBundle } from "../versions";
import { ChangeList } from "./ChangeList";
import { errorText, Field, isCode, Notice, Select, TextArea, useAction } from "./ui";

type Revision = ResponseOf<typeof apiRoutes.opsReviseAgent>;

/** The agent's page, from its summary. */
export function agentPath(agent: Pick<AgentSummary, "kind" | "slug" | "tenantId">): string {
  return agent.kind === "template"
    ? `/ops/templates/${agent.slug}`
    : `/ops/clients/${agent.tenantId}/agents/${agent.slug}`;
}

function bundleOf(raw: unknown): AgentBundle | null {
  const p = parseBundle({ bundle: raw });
  return p.ok ? p.bundle : null;
}

/** What the Builder said: gaps, the rules it was held to, and what still stops a publish. */
export function BuilderFindings({
  gaps,
  notes,
  errors,
}: {
  gaps: readonly string[];
  notes: readonly string[];
  errors: readonly { stepId: string | null; field: string; code: string; message: string }[];
}) {
  return (
    <div className="flex flex-col gap-3">
      {gaps.length > 0 ? (
        <div data-testid="builder-gaps">
          <p className="mb-1 text-sm font-medium text-ink">What it can't do yet</p>
          <ul className="list-disc pl-5 text-sm text-ink">
            {gaps.map((g) => (
              <li key={g}>{g}</li>
            ))}
          </ul>
        </div>
      ) : (
        <p className="text-sm text-ink-muted" data-testid="builder-gaps">
          Every step uses skills and tools you already have.
        </p>
      )}
      {notes.length > 0 ? (
        <div data-testid="builder-notes">
          <p className="mb-1 text-sm font-medium text-ink">Kept to our rules</p>
          <ul className="list-disc pl-5 text-sm text-ink-muted">
            {notes.map((n) => (
              <li key={n}>{n}</li>
            ))}
          </ul>
        </div>
      ) : null}
      {errors.length > 0 ? (
        <Notice tone="warning" testId="builder-errors">
          Before it can be published:
          <ul className="mt-2 list-disc pl-5">
            {errors.map((e) => (
              <li key={`${e.stepId}:${e.field}:${e.code}`}>{e.message}</li>
            ))}
          </ul>
        </Notice>
      ) : null}
    </div>
  );
}

/** Revise with the Builder, from the agent page (templates and client agents alike). */
export function ReviseTab({
  agent,
  base,
  latestVersion,
  onChanged,
}: {
  agent: AgentSummary;
  base: string;
  latestVersion: number | null;
  onChanged(): void;
}) {
  const [instruction, setInstruction] = useState("");
  // `?request=<id>` comes from the requests queue's "Revise with the Builder".
  const [search] = useSearchParams();
  const [requestId, setRequestId] = useState(search.get("request") ?? "");
  const [result, setResult] = useState<Revision | null>(null);
  const action = useAction();
  // A client's open requests can be handed to the Builder as the instruction.
  const queue = useApi(
    apiRoutes.opsRequests,
    agent.tenantId ? { query: { client: agent.tenantId, status: "open" } } : null,
  );
  const requests = queue.data?.items ?? [];
  const request = requests.find((r) => r.id === requestId);
  const empty = !instruction.trim() && !requestId;

  async function revise() {
    if (empty) return;
    const res = await action.call(apiRoutes.opsReviseAgent, {
      params: { id: agent.id },
      body: {
        ...(instruction.trim() ? { instruction: instruction.trim() } : {}),
        ...(requestId ? { requestId } : {}),
      },
    });
    if (res.ok) {
      setResult(res.data);
      onChanged();
    }
  }

  const revised = result ? bundleOf(result.bundle) : null;
  const first = revised?.workflows[0]?.slug;
  return (
    <div className="grid grid-cols-1 gap-5 xl:grid-cols-[minmax(0,1fr)_420px]">
      <Card className="p-5" testId="revise-form">
        <SectionLabel>Ask the Builder</SectionLabel>
        <p className="mb-4 text-sm text-ink-muted">
          It starts from the latest version{latestVersion ? ` (v${latestVersion})` : ""} and saves a
          new draft. Approvals stay on: only you can switch one off, in the workflow builder.
        </p>
        <div className="flex flex-col gap-4">
          {agent.kind === "client" && requests.length > 0 ? (
            <Field label="From a client request" hint="Their words go to the Builder as data.">
              <Select
                data-testid="revise-request-select"
                value={requestId}
                onChange={(e) => setRequestId(e.target.value)}
              >
                <option value="">None</option>
                {requests.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.subject}
                  </option>
                ))}
              </Select>
            </Field>
          ) : null}
          {request ? (
            <Notice tone="neutral" testId="revise-request-text">
              {request.text}
            </Notice>
          ) : null}
          <Field
            label="What should change?"
            hint={
              agent.kind === "client"
                ? "e.g. For this client, skip the approval for invoices under $200."
                : "e.g. Ask the purchaser when a match is below 90%."
            }
          >
            <TextArea
              data-testid="revise-instruction-input"
              rows={4}
              value={instruction}
              onChange={(e) => setInstruction(e.target.value)}
            />
          </Field>
        </div>
        {action.error ? (
          <div className="mt-3">
            <Notice tone="warning" testId="revise-error">
              {isCode(action.error, "no_op")
                ? "The Builder changed nothing, so no version was saved."
                : errorText(action.error)}
            </Notice>
          </div>
        ) : null}
        <div className="mt-4 flex justify-end">
          <Button
            variant="primary"
            data-testid="revise-submit"
            disabled={action.busy || empty}
            onClick={revise}
          >
            {action.busy ? "Revising…" : "Revise"}
          </Button>
        </div>
      </Card>
      <div className="flex flex-col gap-4">
        {result ? (
          <Card className="p-5" testId="revise-result">
            <SectionLabel action={<Badge tone="neutral">v{result.version.version} · draft</Badge>}>
              What changed
            </SectionLabel>
            <div className="flex flex-col gap-4">
              <Notice tone="ai" testId="revise-summary">
                {result.summary}
              </Notice>
              <ChangeList
                changes={result.diff.changes}
                labels={result.diff.labels}
                empty="No changes."
                testId="revise-changes"
              />
              <BuilderFindings gaps={result.gaps} notes={result.notes} errors={result.errors} />
              <div className="flex justify-end gap-3">
                <Link to={`${base}/versions`} className={buttonClass("ghost")}>
                  Versions
                </Link>
                <Link
                  to={first ? `${base}/workflows/${first}` : base}
                  className={buttonClass("primary")}
                  data-testid="revise-open-builder"
                >
                  Open in workflow builder
                </Link>
              </div>
            </div>
          </Card>
        ) : (
          <Card className="p-5">
            <SectionLabel>What changed</SectionLabel>
            <p className="text-sm text-ink-muted">
              The Builder's changes show here, step by step, before you test and publish them.
            </p>
          </Card>
        )}
      </div>
    </div>
  );
}
