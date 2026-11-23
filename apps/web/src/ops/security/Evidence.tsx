// The security checks' evidence for an auditor (`/ops/security/evidence`, docs/agent-assurance-plan.md
// §5, A4; §1.231.3): every stored result over a chosen period, per agent and client, with its
// evidence ids, as a printable page and as CSV; and the rollup on the Overview, per register
// control, of how many agents' checks were verified. Loaded lazily (routes.tsx and the Overview), so
// none of it is in the app's first load. Back office only: the portal has neither (§5).

import {
  type AssuranceRollup,
  assuranceRoutes,
  type EvidenceRow,
  RESULT_WORDS,
} from "@countersign/core";
import { Link, useSearchParams } from "react-router-dom";
import { apiRoutes } from "../../api/routes";
import { useApi } from "../../api/useApi";
import { EN } from "../../i18n/i18n";
import { useSession } from "../../session/session";
import { Field, Select, TextInput } from "../../ui/forms";
import { Loaded } from "../../ui/page";
import { Badge, Button, buttonClass, EmptyState, type Tone } from "../../ui/primitives";
import { TableCard } from "../screens/business";
import { SECURITY_PATHS } from "./paths";
import { SecurityPage } from "./SecurityScreens";

const TONE: Record<EvidenceRow["result"], Tone> = {
  verified: "positive",
  in_review: "warning",
  not_applicable: "neutral",
};

/** "23 Nov 2026": a period's bound is a UTC day, so it reads as that calendar day (S5.1). */
const day = (iso: string) => EN.fmt.date(iso.slice(0, 10));
/** The period's last day: its end is the start of the day after. */
const lastDay = (endIso: string) => day(new Date(new Date(endIso).getTime() - 1).toISOString());

export default function EvidenceScreen() {
  const [params, setParams] = useSearchParams();
  const query = {
    ...(params.get("from") ? { from: params.get("from") as string } : {}),
    ...(params.get("to") ? { to: params.get("to") as string } : {}),
    ...(params.get("client") ? { client: params.get("client") as string } : {}),
    ...(params.get("agent") ? { agent: params.get("agent") as string } : {}),
  };
  const state = useApi(assuranceRoutes.opsAssuranceEvidence, { query });
  // S6.4: the clients this operator serves, and the chosen client's agents (not test copies).
  // DECISION: an agent is picked within a client, so the agent list is that client's alone.
  const session = useSession();
  const clients = session.tenants.filter((t) => t.role === "operator");
  const agents = useApi(
    apiRoutes.opsClientAgents,
    query.client ? { params: { id: query.client } } : null,
  );
  const clientAgents = (agents.data?.agents ?? []).filter((a) => !a.testCopy);
  const set = (patch: Record<string, string>) => {
    const next = new URLSearchParams(params);
    for (const [k, v] of Object.entries(patch)) {
      if (v) next.set(k, v);
      else next.delete(k);
    }
    setParams(next, { replace: true });
  };
  const csv = `/api/ops/assurance/evidence.csv?${new URLSearchParams(query).toString()}`;
  return (
    <SecurityPage
      testId="ops-security-evidence"
      title="Evidence of agents' checks"
      subtitle="Every security check's result over the period, per agent and client, with the ids of the records it read. Never their contents."
      actions={
        <div className="flex flex-wrap items-end gap-2" data-print="hide">
          <Field label="Client" className="w-48">
            <Select
              data-testid="evidence-client"
              value={query.client ?? ""}
              onChange={(e) => set({ client: e.target.value, agent: "" })}
              className="h-8 w-48 text-sm"
            >
              <option value="">All clients</option>
              {clients.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Agent" className="w-48">
            <Select
              data-testid="evidence-agent"
              value={query.agent ?? ""}
              disabled={!query.client}
              title={query.client ? undefined : "Choose a client first"}
              onChange={(e) => set({ agent: e.target.value })}
              className="h-8 w-48 text-sm"
            >
              <option value="">{query.client ? "All agents" : "Choose a client first"}</option>
              {clientAgents.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="From" className="w-40">
            <TextInput
              type="date"
              data-testid="evidence-from"
              value={query.from ?? ""}
              onChange={(e) => set({ from: e.target.value })}
              className="h-8 w-40 text-sm"
            />
          </Field>
          <Field label="To" className="w-40">
            <TextInput
              type="date"
              data-testid="evidence-to"
              value={query.to ?? ""}
              onChange={(e) => set({ to: e.target.value })}
              className="h-8 w-40 text-sm"
            />
          </Field>
          <a href={csv} download className={buttonClass("secondary")} data-testid="evidence-csv">
            Download CSV
          </a>
          <Button variant="secondary" onClick={() => window.print()} data-testid="evidence-print">
            Print
          </Button>
        </div>
      }
    >
      <Loaded state={state}>
        {(data) => (
          <div className="flex flex-col gap-4">
            <p className="text-sm text-ink-muted" data-testid="evidence-period">
              {day(data.period.start)} to {lastDay(data.period.end)} · {data.rows.length} results
              {data.truncated ? ", the first shown: narrow the period or pick one agent" : ""}. The
              SOC 2 criteria are the ones each check's controls answer, in our own mapping; we hold
              no SOC 2 report yet.
            </p>
            {data.rows.length === 0 ? (
              <EmptyState title="No results in this period">
                The checks run every night for each live client agent.
              </EmptyState>
            ) : (
              <TableCard title="Results" meta={`${data.rows.length}`} testId="evidence-table">
                <table>
                  <thead>
                    <tr>
                      <th>Checked</th>
                      <th>Client and agent</th>
                      <th>Check</th>
                      <th>Result</th>
                      <th>Found</th>
                      <th>Evidence</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.rows.map((r) => (
                      <tr key={r.id} data-testid={`evidence-row-${r.id}`}>
                        <td className="figures whitespace-nowrap">{EN.fmt.date(r.checkedAt)}</td>
                        <td>
                          <span className="text-ink">{r.client.name}</span>
                          <br />
                          {r.agent.name}
                          {r.version === null ? "" : ` v${r.version}`}
                        </td>
                        <td>
                          <span className="font-mono text-ink-muted">{r.number}</span> {r.name}
                          <br />
                          <span className="text-xs text-ink-muted">
                            {r.controls.join(", ")}
                            {r.soc2.length > 0 ? ` · SOC 2 ${r.soc2.join(", ")}` : ""}
                          </span>
                        </td>
                        <td>
                          <Badge tone={TONE[r.result]}>{RESULT_WORDS[r.result]}</Badge>
                        </td>
                        <td>{r.found}</td>
                        <td className="font-mono text-xs break-all">
                          {JSON.stringify(r.evidence)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </TableCard>
            )}
          </div>
        )}
      </Loaded>
    </SecurityPage>
  );
}

/** The Overview's rollup: per register control an agent check proves, over the last 30 days. */
export function AssuranceRollupCard() {
  const state = useApi(assuranceRoutes.opsAssuranceRollup, { query: {} });
  return (
    <Loaded state={state}>
      {(data: AssuranceRollup) => (
        <TableCard
          title="Agents' checks, last 30 days"
          meta={`${data.agents} agents, ${data.clients} clients`}
          testId="ops-security-rollup"
          footer={
            <Link to={SECURITY_PATHS.evidence} className="hover:underline">
              Evidence for an auditor
            </Link>
          }
        >
          <table>
            <thead>
              <tr>
                <th>Control</th>
                <th>Agents checked</th>
                <th>Verified</th>
                <th>In review</th>
                <th>Not applicable</th>
              </tr>
            </thead>
            <tbody>
              {data.controls.map((c) => (
                <tr key={c.id} data-testid={`ops-security-rollup-${c.id}`}>
                  <td className="text-ink">
                    <span className="font-mono text-ink-muted">{c.id}</span> {c.title}
                  </td>
                  <td className="figures">{c.agents}</td>
                  <td className="figures">{c.verified}</td>
                  <td className="figures">
                    {c.inReview > 0 ? <Badge tone="warning">{c.inReview} in review</Badge> : 0}
                  </td>
                  <td className="figures">{c.notApplicable}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableCard>
      )}
    </Loaded>
  );
}
