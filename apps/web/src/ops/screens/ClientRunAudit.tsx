// The client settings' Run audit section (wave 6, docs/plan.md §1.86 "Run audit (wave 6)"): which
// of the client's finished runs join the audit queue. The client's rule (every run that wrote to
// its tools, and a percent of the rest; our default until set) and, per agent, an override that
// wins over it. The share is picked by a hash of the run id, so a run is always picked or not.
// Changes are logged. Ours only: the client never sees the queue (invariant 11).
import {
  type AuditRule,
  type AuditSettingsBody,
  type AuditSettingsView,
  DEFAULT_AUDIT_RULE,
} from "@countersign/core";
import { useState } from "react";
import { Link } from "react-router-dom";
import { apiRoutes } from "../../api/routes";
import { useApi, useApiClient } from "../../api/useApi";
import { Field, TextInput } from "../../ui/forms";
import { Loaded, Section } from "../../ui/page";
import { Badge, Button, Card, ErrorNotice } from "../../ui/primitives";
import { TableCard } from "./business";

/** "Every run that wrote, and 5% of the rest", "10% of runs", "No runs". */
export function ruleWords(rule: AuditRule): string {
  const share = `${rule.percent}%`;
  if (rule.writes) {
    return rule.percent === 0
      ? "Every run that wrote to their tools"
      : rule.percent === 100
        ? "Every run"
        : `Every run that wrote to their tools, and ${share} of the rest`;
  }
  return rule.percent === 0 ? "No runs" : `${share} of runs`;
}

/** A percent as typed: 0 to 100, at most two decimals; null when it isn't one. */
export function parsePercent(text: string): number | null {
  const t = text.trim();
  if (!/^\d{1,3}(\.\d{1,2})?$/.test(t)) return null;
  const n = Number(t);
  return n >= 0 && n <= 100 ? n : null;
}

// DECISION (wave 6): the rule is a section of its own in the client's settings ("Run audit",
// after Compliance), with each agent's override in a table under it; an agent shows its own rule
// or "the client's rule", and "Use the client's rule" clears its override (null).
export function ClientRunAuditSection({ clientId }: { clientId: string }) {
  const state = useApi(apiRoutes.opsAuditSettings, { params: { id: clientId } });
  const api = useApiClient();
  const [error, setError] = useState<unknown>(null);

  async function save(body: AuditSettingsBody): Promise<boolean> {
    setError(null);
    try {
      await api.call(apiRoutes.opsSetAuditSettings, { params: { id: clientId }, body });
      state.reload();
      return true;
    } catch (e) {
      setError(e);
      return false;
    }
  }

  return (
    <Section
      title="Run audit"
      meta="Which finished runs we check by hand"
      action={
        <Link
          to={`/ops/run-audit?client=${clientId}`}
          className="ds-btn ds-btn--link text-sm"
          data-testid="ops-client-run-audit-queue"
        >
          Open the audit queue
        </Link>
      }
      testId="ops-client-settings-run-audit"
    >
      {error ? <ErrorNotice error={error} /> : null}
      <Loaded state={state}>
        {(view) => (
          <div className="flex flex-col gap-4">
            {/* Keyed by the rule, so the fields start again from what was saved. */}
            <ClientRule key={JSON.stringify(view.effective)} view={view} onSave={save} />
            <AgentRules view={view} onSave={save} />
          </div>
        )}
      </Loaded>
    </Section>
  );
}

/** The writes tick and the percent, as typed; `rule` is null while the percent isn't valid. */
function useRuleDraft(initial: AuditRule) {
  const [writes, setWrites] = useState(initial.writes);
  const [percent, setPercent] = useState(String(initial.percent));
  const parsed = parsePercent(percent);
  const rule: AuditRule | null = parsed === null ? null : { writes, percent: parsed };
  return { writes, setWrites, percent, setPercent, rule };
}

function RuleFields({ draft, testId }: { draft: ReturnType<typeof useRuleDraft>; testId: string }) {
  return (
    <div className="flex flex-wrap items-end gap-4">
      <label className="flex items-center gap-2 pb-2 text-sm text-ink">
        <input
          className="size-4 accent-slate"
          type="checkbox"
          data-testid={`${testId}-writes`}
          checked={draft.writes}
          onChange={(e) => draft.setWrites(e.target.checked)}
        />
        Every run that wrote to their tools
      </label>
      <Field
        label="And this share of the rest"
        error={draft.rule ? undefined : "A percent from 0 to 100."}
        className="w-48"
        testId={`${testId}-percent`}
      >
        <span className="flex items-center gap-2">
          <TextInput
            data-testid={`${testId}-percent`}
            inputMode="decimal"
            value={draft.percent}
            invalid={!draft.rule}
            onChange={(e) => draft.setPercent(e.target.value)}
            className="w-24"
          />
          <span className="text-sm text-ink-muted">%</span>
        </span>
      </Field>
    </div>
  );
}

function ClientRule({
  view,
  onSave,
}: {
  view: AuditSettingsView;
  onSave: (body: AuditSettingsBody) => Promise<boolean>;
}) {
  const draft = useRuleDraft(view.effective);
  const [busy, setBusy] = useState(false);
  const run = async (body: AuditSettingsBody) => {
    setBusy(true);
    await onSave(body);
    setBusy(false);
  };
  return (
    <Card
      title="The client's rule"
      meta={
        <Badge tone="neutral" testId="ops-client-run-audit-source">
          {view.rule ? "Its own" : "Our default"}
        </Badge>
      }
      pad
      testId="ops-client-run-audit-rule"
    >
      <div className="flex flex-col gap-3">
        <p className="text-sm text-ink" data-testid="ops-client-run-audit-effective">
          {ruleWords(view.effective)}.
        </p>
        <p className="text-sm text-ink-muted">
          Our default is {ruleWords(view.default ?? DEFAULT_AUDIT_RULE).toLowerCase()}. Test runs
          are never queued. Which runs make the share is fixed by each run's id, so it never changes
          after the fact.
        </p>
        <RuleFields draft={draft} testId="ops-client-run-audit" />
        <div className="flex flex-wrap gap-2">
          <Button
            variant="primary"
            size="sm"
            data-testid="ops-client-run-audit-save"
            disabled={busy || !draft.rule}
            onClick={() => draft.rule && void run({ rule: draft.rule })}
          >
            Save the rule
          </Button>
          {view.rule ? (
            <Button
              variant="ghost"
              size="sm"
              data-testid="ops-client-run-audit-reset"
              disabled={busy}
              onClick={() => void run({ rule: null })}
            >
              Use our default
            </Button>
          ) : null}
        </div>
      </div>
    </Card>
  );
}

function AgentRules({
  view,
  onSave,
}: {
  view: AuditSettingsView;
  onSave: (body: AuditSettingsBody) => Promise<boolean>;
}) {
  if (view.agents.length === 0) return null;
  return (
    <TableCard
      title="Per agent"
      meta="An agent's own rule wins over the client's"
      testId="ops-client-run-audit-agents"
    >
      <table>
        <thead>
          <tr className="dt-cols">
            <th>Agent</th>
            <th>Rule</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {view.agents.map((a) => (
            <AgentRuleRow
              key={`${a.agentId}-${JSON.stringify(a.effective)}`}
              agent={a}
              onSave={onSave}
            />
          ))}
        </tbody>
      </table>
    </TableCard>
  );
}

function AgentRuleRow({
  agent,
  onSave,
}: {
  agent: AuditSettingsView["agents"][number];
  onSave: (body: AuditSettingsBody) => Promise<boolean>;
}) {
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const draft = useRuleDraft(agent.effective);
  const testId = `ops-client-run-audit-agent-${agent.agentId}`;
  const run = async (rule: AuditRule | null) => {
    setBusy(true);
    const ok = await onSave({ agents: { [agent.agentId]: rule } });
    setBusy(false);
    if (ok) setEditing(false);
  };
  return (
    <tr data-testid={testId}>
      <td className="align-top">{agent.name}</td>
      <td className="align-top">
        {editing ? (
          <RuleFields draft={draft} testId={testId} />
        ) : (
          <span className="flex flex-col">
            <span className="text-ink" data-testid={`${testId}-effective`}>
              {ruleWords(agent.effective)}
            </span>
            <span className="text-xs text-ink-muted">
              {agent.rule ? "Its own rule" : "The client's rule"}
            </span>
          </span>
        )}
      </td>
      <td className="align-top">
        <span className="flex flex-wrap justify-end gap-2">
          {editing ? (
            <>
              <Button variant="ghost" size="sm" disabled={busy} onClick={() => setEditing(false)}>
                Cancel
              </Button>
              <Button
                variant="primary"
                size="sm"
                data-testid={`${testId}-save`}
                disabled={busy || !draft.rule}
                onClick={() => draft.rule && void run(draft.rule)}
              >
                Save
              </Button>
            </>
          ) : (
            <>
              {agent.rule ? (
                <Button
                  variant="ghost"
                  size="sm"
                  data-testid={`${testId}-clear`}
                  disabled={busy}
                  onClick={() => void run(null)}
                >
                  Use the client's rule
                </Button>
              ) : null}
              <Button size="sm" data-testid={`${testId}-edit`} onClick={() => setEditing(true)}>
                {agent.rule ? "Change" : "Set its own rule"}
              </Button>
            </>
          )}
        </span>
      </td>
    </tr>
  );
}
