// `/ops/builds` (docs/plan.md §1.108): every open build by phase, a card each with what holds it,
// the open items across them, and New build: an agent or a skill, for a client or for everyone.
// `/ops/builds/:id` is the build itself (BuildView).
import { type BuildKind, type BuildPhase, PHASE_WORDS } from "@countersign/core";
import { useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { apiRoutes } from "../../api/routes";
import { useApi, useApiClient } from "../../api/useApi";
import { ErrorNotice } from "../../ui/ErrorState";
import { Field, Select, TextInput } from "../../ui/forms";
import { Page } from "../../ui/page";
import { Badge, Button, Card, EmptyState, Loading, PageHeader } from "../../ui/primitives";
import { BuildView } from "./BuildView";
import { buildPath, ITEM_TONE, plural } from "./words";

const COLUMNS: BuildPhase[] = ["intake", "fitgap", "draft", "poc", "client_test", "qa"];

export function BuildsScreen() {
  const list = useApi(apiRoutes.opsBuilds, { query: { status: "open" } });
  const [starting, setStarting] = useState(false);
  const builds = list.data?.builds ?? [];
  const waitingOnYou = list.data?.items.filter((i) => i.owner === "operator").length ?? 0;
  const waitingOnClients = list.data?.items.filter((i) => i.owner === "client").length ?? 0;
  return (
    <Page testId="builds">
      <PageHeader
        eyebrow="Build"
        title="Builds"
        subtitle={
          list.data
            ? `${plural(builds.length, "build")}. ${plural(waitingOnYou, "open item")} with you, ${waitingOnClients} with clients.`
            : "Every new agent and skill, from intake to go-live."
        }
        actions={
          <Button variant="primary" onClick={() => setStarting((s) => !s)} data-testid="builds-new">
            New build
          </Button>
        }
      />
      {starting ? <NewBuild onCancel={() => setStarting(false)} /> : null}
      {list.error ? <ErrorNotice error={list.error} onRetry={list.reload} /> : null}
      {list.loading && !list.data ? <Loading /> : null}
      {list.data && builds.length === 0 && !starting ? (
        <EmptyState
          title="No builds yet"
          action={{ label: "New build", onClick: () => setStarting(true) }}
        >
          A build takes a new agent or skill from intake to go-live: the brief, the fit-gap, the
          draft, a test on synthetic data, a client's trial and QA.
        </EmptyState>
      ) : null}
      {builds.length > 0 ? (
        <div
          className="grid gap-4 overflow-x-auto pb-2 md:grid-cols-3 xl:grid-cols-6"
          data-testid="builds-board"
        >
          {COLUMNS.map((phase) => {
            const here = builds.filter((b) => b.phase === phase);
            return (
              <section
                key={phase}
                className="flex min-w-0 flex-col gap-3"
                aria-label={PHASE_WORDS[phase].label}
              >
                <h2 className="flex items-center justify-between px-1 text-sm font-medium text-ink">
                  {PHASE_WORDS[phase].label}
                  <span className="text-ink-muted">{here.length}</span>
                </h2>
                {here.map((b) => (
                  <Link
                    key={b.id}
                    to={buildPath(b.id)}
                    data-testid={`builds-card-${b.id}`}
                    className="flex flex-col gap-2 rounded-md border border-line bg-surface p-4 text-sm hover:border-line-strong"
                  >
                    <span className="font-medium text-ink">{b.title}</span>
                    <span className="text-ink-muted">
                      {b.kind === "skill" ? "Skill" : b.client ? "Client agent" : "Template"} ·{" "}
                      {b.client?.name ??
                        (b.testClient ? `tested at ${b.testClient.name}` : "everyone")}
                    </span>
                    <span className="flex flex-wrap gap-1.5">
                      {b.openItems > 0 ? (
                        <Badge tone="warning">{plural(b.openItems, "open item")}</Badge>
                      ) : (
                        <Badge tone="positive">Nothing open</Badge>
                      )}
                      {b.waitingOnClient > 0 ? (
                        <Badge tone="person">{b.waitingOnClient} with the client</Badge>
                      ) : null}
                    </span>
                  </Link>
                ))}
              </section>
            );
          })}
        </div>
      ) : null}
      {list.data && list.data.items.length > 0 ? (
        <Card
          titleAbove
          title="Open items across builds"
          meta={plural(list.data.items.length, "open item")}
          testId="builds-items"
        >
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-line bg-surface-subtle text-left text-xs text-ink-muted">
                  <th className="px-4 py-2.5 font-medium">Item</th>
                  <th className="px-4 py-2.5 font-medium">Build</th>
                  <th className="px-4 py-2.5 font-medium">From</th>
                  <th className="px-4 py-2.5 font-medium">State</th>
                </tr>
              </thead>
              <tbody>
                {list.data.items.map((i) => (
                  <tr key={i.id} className="border-b border-line last:border-b-0">
                    <td className="px-4 py-3 text-ink">{i.title}</td>
                    <td className="px-4 py-3">
                      <Link to={buildPath(i.buildId)} className="text-slate hover:underline">
                        {i.buildTitle}
                      </Link>
                    </td>
                    <td className="px-4 py-3 text-ink-muted">{PHASE_WORDS[i.phase].label}</td>
                    <td className="px-4 py-3">
                      <Badge tone={ITEM_TONE[i.state]}>
                        {i.owner === "client"
                          ? "With the client"
                          : i.state === "in_progress"
                            ? "In progress"
                            : i.state === "waiting"
                              ? "Waiting"
                              : "Open"}
                      </Badge>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      ) : null}
    </Page>
  );
}

function NewBuild({ onCancel }: { onCancel(): void }) {
  const api = useApiClient();
  const navigate = useNavigate();
  const clients = useApi(apiRoutes.opsClients, { query: { view: "names" } });
  const [kind, setKind] = useState<BuildKind>("agent");
  const [title, setTitle] = useState("");
  const [clientId, setClientId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  async function start() {
    setBusy(true);
    setError(null);
    try {
      const out = await api.call(apiRoutes.opsStartBuild, {
        body: { kind, title: title.trim(), ...(clientId ? { clientId } : {}) },
      });
      navigate(buildPath(out.build.id));
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Card pad testId="builds-start">
      <form
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          if (title.trim()) void start();
        }}
      >
        <div className="flex flex-wrap gap-4">
          <fieldset className="ds-seg self-end" aria-label="What it builds">
            {(["agent", "skill"] as const).map((k) => (
              <button key={k} type="button" aria-pressed={kind === k} onClick={() => setKind(k)}>
                {k === "agent" ? "An agent" : "A skill"}
              </button>
            ))}
          </fieldset>
          <Field label="What it's called" className="min-w-0 flex-1">
            <TextInput
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Invoice intake reviewer"
              data-testid="builds-start-title"
            />
          </Field>
          <Field label="For">
            <Select
              value={clientId}
              onChange={(e) => setClientId(e.target.value)}
              data-testid="builds-start-client"
            >
              <option value="">
                {kind === "agent" ? "Every client (a template)" : "Every agent (shared)"}
              </option>
              {(clients.data?.clients ?? []).map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name} only
                </option>
              ))}
            </Select>
          </Field>
        </div>
        {error ? <ErrorNotice error={error} /> : null}
        <div className="flex gap-2">
          <Button
            type="submit"
            variant="primary"
            disabled={busy || !title.trim()}
            data-testid="builds-start-go"
          >
            {busy ? "Starting…" : "Start the build"}
          </Button>
          <Button variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
        </div>
      </form>
    </Card>
  );
}

export function BuildScreen() {
  const { id } = useParams();
  if (!id) return null;
  return (
    <Page testId="build">
      <BuildView key={id} id={id} />
    </Page>
  );
}
