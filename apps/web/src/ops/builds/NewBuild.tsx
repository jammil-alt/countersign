// New in the Agent lab (owner, 2026-11-17: "make the builder board and new item as the New Template
// in the agent lab ... they do the same thing now"): every new template, client agent or skill
// starts as a build (docs/plan.md §1.108), so it gets its brief, fit-gap, draft and tests. The
// build's page takes it from there.
import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { apiRoutes } from "../../api/routes";
import { useApi, useApiClient } from "../../api/useApi";
import { ErrorNotice } from "../../ui/ErrorState";
import { Field, Select, TextInput } from "../../ui/forms";
import { Button, Card } from "../../ui/primitives";
import { buildPath } from "./words";

/** What a new build makes: a template (an agent for every client), one client's agent, a skill. */
export const NEW_KINDS = ["template", "client", "skill"] as const;
export type NewKind = (typeof NEW_KINDS)[number];

const KIND_WORDS: Record<NewKind, string> = {
  template: "Template",
  client: "Client agent",
  skill: "Skill",
};

const PLACEHOLDER: Record<NewKind, string> = {
  template: "Invoice intake reviewer",
  client: "Harbor Millwork's bill review",
  skill: "Group invoices by customer",
};

export function isNewKind(v: string | null): v is NewKind {
  return (NEW_KINDS as readonly string[]).includes(v ?? "");
}

export function NewBuild({
  initial = "template",
  onCancel,
}: {
  initial?: NewKind;
  onCancel(): void;
}) {
  const api = useApiClient();
  const navigate = useNavigate();
  const clients = useApi(apiRoutes.opsClients, { query: { view: "names" } });
  const [kind, setKind] = useState<NewKind>(initial);
  const [title, setTitle] = useState("");
  const [clientId, setClientId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  // A client agent is for one client; a template is for every client; a skill may be either.
  const needsClient = kind === "client" && !clientId;
  const ready = !!title.trim() && !needsClient;
  const clientList = clients.data?.clients ?? [];
  // FLOW-8 (QA 2026-11-19): Start was off for a client agent with no client picked, and the only
  // word why was a tooltip. Said on the form: the clients couldn't be read, there's none to pick,
  // or none is picked yet.
  const clientsFailed = kind !== "template" && !!clients.error;
  const why =
    !needsClient || clientsFailed || clients.loading ? null : clientList.length === 0 ? (
      <>
        There's no client to build it for yet.{" "}
        <Link to="/ops/clients/new" className="font-medium text-slate hover:underline">
          Add a client
        </Link>{" "}
        first.
      </>
    ) : (
      "Pick the client it's for."
    );
  async function start() {
    setBusy(true);
    setError(null);
    try {
      const out = await api.call(apiRoutes.opsStartBuild, {
        body: {
          kind: kind === "skill" ? "skill" : "agent",
          title: title.trim(),
          ...(kind !== "template" && clientId ? { clientId } : {}),
        },
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
          if (ready) void start();
        }}
      >
        <p className="text-sm text-ink-muted">
          It starts as a build: the brief, the fit-gap, the draft, a test on synthetic data, a
          client's trial and QA. It shows under Drafts until it goes live.
        </p>
        <div className="flex flex-wrap gap-4">
          <fieldset className="ds-seg self-end" aria-label="What it builds">
            {NEW_KINDS.map((k) => (
              <button
                key={k}
                type="button"
                aria-pressed={kind === k}
                data-testid={`builds-start-kind-${k}`}
                onClick={() => setKind(k)}
              >
                {KIND_WORDS[k]}
              </button>
            ))}
          </fieldset>
          <Field label="What it's called" className="min-w-0 flex-1">
            <TextInput
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder={PLACEHOLDER[kind]}
              data-testid="builds-start-title"
            />
          </Field>
          {kind === "template" ? null : (
            <Field label="For">
              <Select
                value={clientId}
                onChange={(e) => setClientId(e.target.value)}
                data-testid="builds-start-client"
              >
                <option value="">
                  {kind === "skill" ? "Every agent (shared)" : "Pick a client"}
                </option>
                {clientList.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name} only
                  </option>
                ))}
              </Select>
            </Field>
          )}
        </div>
        {clientsFailed ? <ErrorNotice error={clients.error} onRetry={clients.reload} /> : null}
        {error ? <ErrorNotice error={error} /> : null}
        <div className="flex flex-wrap items-center gap-2">
          <Button
            type="submit"
            variant="primary"
            disabled={busy || !ready}
            data-testid="builds-start-go"
          >
            {busy ? "Starting…" : "Start the build"}
          </Button>
          <Button variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
          {why ? (
            <span className="text-sm text-ink-muted" data-testid="builds-start-why">
              {why}
            </span>
          ) : null}
        </div>
      </form>
    </Card>
  );
}
