// New in the Agent lab (owner, 2026-11-17: "make the builder board and new item as the New Template
// in the agent lab ... they do the same thing now"): every new template, client agent or skill
// starts as a build (docs/plan.md §1.108), so it gets its brief, fit-gap, draft and tests. The
// build's page takes it from there.
// Owner (2026-11-21, docs/plan.md §1.165): "we are taking a few simple steps and making it into a
// huge challenge". An agent described here is drafted at once: the build opens on its page and the
// Builder drafts it from these words, with no questions first. Left empty, the build starts with
// the Builder's questions as before.
import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { apiRoutes } from "../../api/routes";
import { useApi, useApiClient } from "../../api/useApi";
import { ErrorNotice } from "../../ui/ErrorState";
import { Field, Select, TextArea, TextInput } from "../../ui/forms";
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

/** What the build's page reads from the router to draft at once (`BuildView`'s intake). */
export interface DraftNowState {
  draftNow: string;
}

export const DESCRIPTION_MAX = 4000;

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
  const [description, setDescription] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  // A client agent is for one client; a template is for every client; a skill may be either.
  const needsClient = kind === "client" && !clientId;
  const ready = !!title.trim() && !needsClient;
  // A skill is drafted in its own Builder conversation, so it has no description here.
  const describes = kind !== "skill";
  const words = describes ? description.trim() : "";
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
      navigate(
        buildPath(out.build.id),
        words ? { state: { draftNow: words } satisfies DraftNowState } : undefined,
      );
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
          {describes
            ? "List the steps. The Builder drafts them at once and you change them after."
            : "It starts as a build: the brief, the fit-gap, the draft and a test."}
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
        {describes ? (
          <Field
            label="What should it do?"
            hint="A few steps, in order. Leave it empty to start with questions."
          >
            <TextArea
              rows={5}
              className="w-full"
              maxLength={DESCRIPTION_MAX}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="1. Every weekday at 4 pm, text each field person. 2. Ask how their open tasks are going. 3. Turn each answer into a task update. 4. The project manager approves it."
              data-testid="builds-start-description"
            />
          </Field>
        ) : null}
        {clientsFailed ? <ErrorNotice error={clients.error} onRetry={clients.reload} /> : null}
        {error ? <ErrorNotice error={error} /> : null}
        <div className="flex flex-wrap items-center gap-2">
          <Button
            type="submit"
            variant="primary"
            disabled={busy || !ready}
            data-testid="builds-start-go"
          >
            {busy
              ? "Starting…"
              : words
                ? "Build it"
                : describes
                  ? "Start with questions"
                  : "Start the build"}
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
