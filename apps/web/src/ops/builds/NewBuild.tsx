// New in the Agent lab (owner, 2026-11-17: "make the builder board and new item as the New Template
// in the agent lab ... they do the same thing now"): every new template, client agent or skill
// starts as a build (docs/plan.md §1.108), so it gets its brief, fit-gap, draft and tests. The
// build's page takes it from there.
// Owner (2026-11-21, docs/plan.md §1.165): "we are taking a few simple steps and making it into a
// huge challenge". An agent described here is drafted at once: the build opens on its page and the
// Builder drafts it from these words, with no questions first. Left empty, the build starts with
// the Builder's questions as before.
// Owner (2026-11-21, docs/plan.md §1.170): a new template or client agent opens on Describe it
// (../flow/DescribeScreen), then Check the steps, then the chart.
// Owner (2026-11-24, "the skill process uses the old flow"): a skill opens on Describe the skill
// (../flow/SkillDescribe): a sample file and, in words, what it gets and gives back.
import { useState } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { apiRoutes } from "../../api/routes";
import { useApi, useApiClient } from "../../api/useApi";
import { ErrorNotice } from "../../ui/ErrorState";
import { Field, Select } from "../../ui/forms";
import { DescribeScreen, readDescribeAgain } from "../flow/DescribeScreen";
import { SkillDescribe } from "../flow/SkillDescribe";

/** What a new build makes: a template (an agent for every client), one client's agent, a skill. */
export const NEW_KINDS = ["template", "client", "skill"] as const;
export type NewKind = (typeof NEW_KINDS)[number];

const KIND_WORDS: Record<NewKind, string> = {
  template: "Template",
  client: "Client agent",
  skill: "Skill",
};

/**
 * What the build's page reads from the router to draft at once (`BuildView`'s intake). New agent
 * builds draft on Describe it now (../flow/DescribeScreen); the page still honours it.
 */
export interface DraftNowState {
  draftNow: string;
}

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
  const _api = useApiClient();
  const _navigate = useNavigate();
  // "Back to the description" from Check the steps: the words, and the client, as they were.
  const again = readDescribeAgain(useLocation().state);
  const clients = useApi(apiRoutes.opsClients, { query: { view: "names" } });
  const [kind, setKind] = useState<NewKind>(initial);
  const [clientId, setClientId] = useState(again?.clientId ?? "");
  // A client agent is for one client; a template is for every client; a skill may be either.
  const needsClient = kind === "client" && !clientId;
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
  const kindSwitch = (
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
  );
  const clientPicker =
    kind === "template" ? null : (
      <Field label="For">
        <Select
          value={clientId}
          onChange={(e) => setClientId(e.target.value)}
          data-testid="builds-start-client"
        >
          <option value="">{kind === "skill" ? "Every agent (shared)" : "Pick a client"}</option>
          {clientList.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name} only
            </option>
          ))}
        </Select>
      </Field>
    );
  if (kind === "skill") {
    return (
      <section data-testid="builds-start">
        <SkillDescribe
          clientId={clientId || null}
          onCancel={onCancel}
          header={
            <div className="flex flex-col gap-2">
              <div className="flex flex-wrap items-end gap-4">
                {kindSwitch}
                {clientPicker}
              </div>
              {clientsFailed ? (
                <ErrorNotice error={clients.error} onRetry={clients.reload} />
              ) : null}
            </div>
          }
        />
      </section>
    );
  }
  return (
    <section data-testid="builds-start">
      <DescribeScreen
        kind={kind}
        clientId={clientId || null}
        blocked={needsClient}
        initialName={again?.name}
        initialWords={again?.words}
        buildId={again?.buildId ?? null}
        onCancel={onCancel}
        header={
          <div className="flex flex-col gap-2">
            <div className="flex flex-wrap items-end gap-4">
              {kindSwitch}
              {clientPicker}
            </div>
            {why ? (
              <span className="text-sm text-ink-muted" data-testid="builds-start-why">
                {why}
              </span>
            ) : null}
            {clientsFailed ? <ErrorNotice error={clients.error} onRetry={clients.reload} /> : null}
          </div>
        }
      />
    </section>
  );
}
