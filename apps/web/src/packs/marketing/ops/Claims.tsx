// Claims (M46, docs/plan.md §1.76): the client's claims list, what its public text may say, may
// say on a condition, and must never say, which every guide's checks read (its newest version).
// The list is kept as versions: saving makes a new one. It is edited as JSON (the shape of
// fixtures/marketing/mezonas-claims.json, from docs/marketing/claims.md); the first list of a
// client can be loaded from that file.
import { useEffect, useState } from "react";
import { useApiClient } from "../../../api/useApi";
import { Field, TextArea } from "../../../ui/forms";
import {
  Button,
  Card,
  EmptyState,
  ErrorNotice,
  Loading,
  SectionLabel,
  Tag,
} from "../../../ui/primitives";
import { runMarketingAction, useMarketingReport } from "./api";
import { dayOf } from "./Content";
import { MarketingLayout, useMarketingClientId } from "./layout";

export interface ClaimsList {
  title: string;
  status: "draft" | "approved";
  approved: { id: string; text: string; why?: string; note?: string }[];
  conditional: { id: string; text: string; condition: string; phrases: string[] }[];
  never: { id: string; text: string; why?: string; phrases: string[] }[];
}

export interface ClaimsReport {
  latest: {
    id: string;
    version: number;
    list: ClaimsList;
    createdByUserId: string | null;
    createdAt: string;
  } | null;
  versions: { id: string; version: number; createdByUserId: string | null; createdAt: string }[];
}

const errorText = (e: unknown) => (e instanceof Error ? e.message : "That didn't work.");

function ListView({ list }: { list: ClaimsList }) {
  return (
    <div className="flex flex-col gap-6" data-testid="marketing-claims-list">
      <section>
        <SectionLabel>Approved</SectionLabel>
        {list.approved.length === 0 ? (
          <EmptyState>Nothing approved yet.</EmptyState>
        ) : (
          <ul className="flex flex-col gap-2">
            {list.approved.map((c) => (
              <li key={c.id} className="flex flex-col">
                <span className="text-ink">{c.text}</span>
                {c.why ? <span className="text-sm text-ink-muted">{c.why}</span> : null}
              </li>
            ))}
          </ul>
        )}
      </section>
      <section>
        <SectionLabel>Approved with a condition</SectionLabel>
        {list.conditional.length === 0 ? (
          <EmptyState>No conditions.</EmptyState>
        ) : (
          <ul className="flex flex-col gap-2">
            {list.conditional.map((c) => (
              <li key={c.id} className="flex flex-col">
                <span className="text-ink">{c.text}</span>
                <span className="text-sm ui-tone-signal">Only if {c.condition}</span>
                {c.phrases.length > 0 ? (
                  <span className="text-sm text-ink-muted">Flags: {c.phrases.join(", ")}</span>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </section>
      <section>
        <SectionLabel>Never</SectionLabel>
        {list.never.length === 0 ? (
          <EmptyState>Nothing ruled out yet.</EmptyState>
        ) : (
          <ul className="flex flex-col gap-2">
            {list.never.map((c) => (
              <li key={c.id} className="flex flex-col">
                <span className="text-ink">{c.text}</span>
                {c.phrases.length > 0 ? (
                  <span className="text-sm text-ink-muted">Refuses: {c.phrases.join(", ")}</span>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </section>
      <p className="text-sm text-ink-muted">
        Every list also refuses exclamation marks and "AI-powered", whatever it says.
      </p>
    </div>
  );
}

export function MarketingClaimsScreen() {
  const clientId = useMarketingClientId();
  const api = useApiClient();
  const state = useMarketingReport<ClaimsReport>(clientId, "claims");
  const data = state.data;
  const [text, setText] = useState("");
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  useEffect(() => {
    if (data?.latest && !editing) setText(JSON.stringify(data.latest.list, null, 2));
  }, [data?.latest, editing]);

  const save = async () => {
    setProblem(null);
    setDone(null);
    let list: unknown;
    try {
      list = JSON.parse(text);
    } catch {
      setProblem("That isn't valid JSON.");
      return;
    }
    setBusy(true);
    try {
      const r = await runMarketingAction<{ claims: { version: number } }>(
        api,
        clientId,
        data?.latest ? "save-claims" : "seed-claims",
        { list },
      );
      setDone(`Saved as version ${r.claims.version}. Checks use it from now on.`);
      setEditing(false);
      state.reload();
    } catch (e) {
      setProblem(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <MarketingLayout
      title="Claims"
      subtitle="What your public text may say, may say on a condition, and must never say."
      testId="marketing-claims"
      actions={
        data && !editing ? (
          <Button
            variant="primary"
            onClick={() => setEditing(true)}
            data-testid="marketing-claims-edit"
          >
            {data.latest ? "Change the list" : "Load a list"}
          </Button>
        ) : null
      }
    >
      {state.loading && !data ? <Loading /> : null}
      {state.error ? <ErrorNotice error={state.error} onRetry={state.reload} /> : null}
      {done ? (
        <p className="text-ink" role="status" data-testid="marketing-claims-done">
          {done}
        </p>
      ) : null}
      {data && !data.latest && !editing ? (
        <EmptyState
          testId="marketing-claims-empty"
          title="No claims list yet"
          line="Guides are checked only against the house rules until there is one. For Mezonas, load fixtures/marketing/mezonas-claims.json (the draft in docs/marketing/claims.md)."
        />
      ) : null}
      {editing ? (
        <Card title="The list, as JSON" testId="marketing-claims-editor" pad>
          <div className="flex flex-col gap-3">
            <Field
              label="List"
              hint='{ "title", "status": "draft" or "approved", "approved": [{ "id", "text", "why" }], "conditional": [{ "id", "text", "condition", "phrases" }], "never": [{ "id", "text", "phrases" }] }. Phrases are matched as whole words.'
            >
              <TextArea
                rows={20}
                value={text}
                onChange={(e) => setText(e.target.value)}
                className="font-mono"
                data-testid="marketing-claims-json-input"
              />
            </Field>
            {problem ? (
              <p className="ui-tone-risk" role="alert" data-testid="marketing-claims-error">
                {problem}
              </p>
            ) : null}
            <div className="flex flex-wrap gap-2">
              <Button
                variant="primary"
                disabled={busy || text.trim() === ""}
                onClick={save}
                data-testid="marketing-claims-save"
              >
                Save as a new version
              </Button>
              <Button
                disabled={busy}
                onClick={() => {
                  setEditing(false);
                  setProblem(null);
                }}
                data-testid="marketing-claims-cancel"
              >
                Not now
              </Button>
            </div>
          </div>
        </Card>
      ) : null}
      {data?.latest && !editing ? (
        <div className="flex flex-col gap-6">
          <Card
            title={data.latest.list.title}
            meta={
              <span className="flex items-center gap-2">
                {data.latest.list.status === "draft" ? <Tag>Draft</Tag> : <Tag>Approved</Tag>}
                <span className="text-sm text-ink-muted">
                  Version {data.latest.version} · {dayOf(data.latest.createdAt)}
                </span>
              </span>
            }
            pad
          >
            <ListView list={data.latest.list} />
          </Card>
          <section data-testid="marketing-claims-versions">
            <SectionLabel>Versions</SectionLabel>
            <ul className="flex flex-col gap-1">
              {data.versions.map((v) => (
                <li key={v.id} className="text-ink">
                  Version {v.version} · {dayOf(v.createdAt)}
                  {v.createdByUserId ? "" : " · installed"}
                </li>
              ))}
            </ul>
          </section>
        </div>
      ) : null}
    </MarketingLayout>
  );
}
