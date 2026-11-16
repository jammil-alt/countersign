// `/ops/usage`'s tokens (docs/plan.md §1.115): every model call of the clients' agents, Sloan's
// included, with its tokens and cost, tallied per client (the account level) and by agent, model
// and action. Operator only, as all cost. The grouping lives in the URL (`?tokens=`) with the
// screen's other filters; the period, client and template are the screen's.
import {
  MODEL_PROVIDER_NAMES,
  type ModelProvider,
  providerModelName,
  TOKEN_ACTION_LABELS,
  type TokenFigures,
  type TokenReport,
  type TokenRow,
} from "@countersign/core";
import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { apiRoutes } from "../../api/routes";
import { useApi } from "../../api/useApi";
import { StatusFilter } from "../../inbox/StatusFilter";
import { Loaded, Section } from "../../ui/page";
import { Badge, EmptyState } from "../../ui/primitives";
import { cost, count, periodLabel, plural } from "../../usage/format";
import { TableCard } from "./business";

export const TOKEN_VIEWS = [
  ["clients", "Clients"],
  ["agents", "Agents"],
  ["models", "Models"],
  ["actions", "Actions"],
  ["detail", "Every combination"],
] as const;
export type TokenView = (typeof TOKEN_VIEWS)[number][0];

const providerName = (p: string) => MODEL_PROVIDER_NAMES[p as ModelProvider] ?? p;

function AgentName({ agent, clientId }: { agent: TokenRow["agent"]; clientId: string }) {
  if (!agent) return <span className="text-ink-muted">No agent (background use)</span>;
  return (
    <span className="flex flex-wrap items-center gap-2">
      <Link
        to={`/ops/clients/${clientId}/agents/${agent.slug}`}
        className="font-medium text-ink hover:underline"
      >
        {agent.name || agent.slug}
      </Link>
      {agent.account ? <Badge>Account agent</Badge> : null}
    </span>
  );
}

interface Line {
  key: string;
  name: ReactNode;
  sub?: ReactNode;
  figures: TokenFigures;
}

function linesFor(view: TokenView, data: TokenReport, label: (model: string) => string): Line[] {
  switch (view) {
    case "clients":
      return data.byClient.map((c) => ({
        key: c.id,
        name: (
          <Link to={`/ops/clients/${c.id}`} className="font-medium text-ink hover:underline">
            {c.name}
          </Link>
        ),
        figures: c,
      }));
    case "agents":
      return data.byAgent.map((a) => ({
        key: `${a.client.id}:${a.agent?.id ?? ""}`,
        name: <AgentName agent={a.agent} clientId={a.client.id} />,
        sub: <span className="text-sm text-ink-muted">{a.client.name}</span>,
        figures: a,
      }));
    case "models":
      return data.byModel.map((m) => ({
        key: m.model,
        name: <span className="text-ink">{label(m.model)}</span>,
        sub: <span className="text-sm text-ink-muted">{providerName(m.provider)}</span>,
        figures: m,
      }));
    case "actions":
      return data.byAction.map((a) => ({
        key: a.action,
        name: <span className="text-ink">{TOKEN_ACTION_LABELS[a.action]}</span>,
        figures: a,
      }));
    case "detail":
      return data.rows.map((r) => ({
        key: `${r.client.id}:${r.agent?.id ?? ""}:${r.model}:${r.action}`,
        name: <AgentName agent={r.agent} clientId={r.client.id} />,
        sub: (
          <span className="text-sm text-ink-muted">
            {r.client.name} · {TOKEN_ACTION_LABELS[r.action]} · {label(r.model)} (
            {providerName(r.provider)})
          </span>
        ),
        figures: r,
      }));
  }
}

const HEADINGS: Record<TokenView, string> = {
  clients: "Client",
  agents: "Agent",
  models: "Model",
  actions: "Action",
  detail: "Agent, action and model",
};

/** The tokens section: its own request over the screen's period, client and template. */
export function UsageTokens({
  from,
  to,
  client,
  template,
  view,
  onView,
}: {
  from: string;
  to: string;
  client: string;
  template: string;
  view: TokenView;
  onView: (view: TokenView) => void;
}) {
  const tokens = useApi(apiRoutes.opsUsageTokens, {
    query: { from, to, ...(client ? { client } : {}), ...(template ? { template } : {}) },
  });
  const models = useApi(apiRoutes.opsModels, {});
  const label = (id: string) =>
    models.data?.models.find((m) => m.id === id)?.label ?? providerModelName(id);
  return (
    <Section title="Tokens" testId="ops-usage-token-report">
      <div className="max-w-full overflow-x-auto">
        <StatusFilter
          value={view}
          onChange={(v) => onView(v as TokenView)}
          area="ops-usage-token-view"
          label="Tokens by"
          options={TOKEN_VIEWS.map(([v, l]) => [v, l])}
        />
      </div>
      <Loaded state={tokens}>
        {(data) => {
          const lines = linesFor(view, data, label);
          if (lines.length === 0) {
            return (
              <EmptyState>
                No model calls in this period. Tokens show here once agents run.
              </EmptyState>
            );
          }
          return (
            <TableCard
              title={`Tokens by ${HEADINGS[view].toLowerCase()}`}
              meta={`${plural(data.total.calls, "model call")}, ${count(
                data.total.tokensIn + data.total.tokensOut,
              )} tokens · ${periodLabel(data.from, data.to)}`}
            >
              <table data-testid={`ops-usage-token-${view}`}>
                <thead>
                  <tr className="dt-cols">
                    <th>{HEADINGS[view]}</th>
                    {["Calls", "Tokens in", "Tokens out", "Cost"].map((h) => (
                      <th key={h} className="n">
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {lines.map((l) => (
                    <tr key={l.key} data-testid={`ops-usage-token-row-${l.key}`}>
                      <td>
                        <span className="flex flex-col py-1">
                          {l.name}
                          {l.sub}
                        </span>
                      </td>
                      <td className="n">{count(l.figures.calls)}</td>
                      <td className="n">{count(l.figures.tokensIn)}</td>
                      <td className="n">{count(l.figures.tokensOut)}</td>
                      <td className="n text-ink">{cost(l.figures.costUsd)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </TableCard>
          );
        }}
      </Loaded>
    </Section>
  );
}
