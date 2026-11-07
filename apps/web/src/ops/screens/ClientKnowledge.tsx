// `/ops/clients/:clientId/knowledge`: the client's knowledge base (docs/plan.md §1.21). Its FAQs and
// policies (add, edit, archive, history), a search as an agent would run it, which documents are
// indexed, and what its agents have noted. Agents reach all of it through `knowledge.search`.
import type { KnowledgeEntry, KnowledgeHit } from "@countersign/core";
import { type FormEvent, useState } from "react";
import { useParams } from "react-router-dom";
import { apiRoutes } from "../../api/routes";
import { useApi, useApiClient } from "../../api/useApi";
import { StatusFilter } from "../../inbox/StatusFilter";
import { type EntryActions, EntryForm, EntryList, KIND_LABEL, when } from "../../knowledge/Entries";
import { TextInput } from "../../ui/forms";
import {
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorNotice,
  Loading,
  SectionLabel,
} from "../../ui/primitives";
import { ClientFrame } from "../client/ClientFrame";

type Show = "active" | "all";

export function ClientKnowledgeRoute() {
  const { clientId = "" } = useParams();
  return <ClientKnowledgeScreen clientId={clientId} />;
}

const HIT_LABEL: Record<KnowledgeHit["kind"], string> = {
  ...KIND_LABEL,
  document: "Document",
  memory: "Memory note",
};

export function ClientKnowledgeScreen({ clientId }: { clientId: string }) {
  const api = useApiClient();
  const [show, setShow] = useState<Show>("active");
  const { data, error, loading, reload } = useApi(apiRoutes.opsKnowledge, {
    params: { id: clientId },
    query: { show },
  });

  const actions: EntryActions = {
    create: (body) => api.call(apiRoutes.opsKnowledgeCreate, { params: { id: clientId }, body }),
    edit: (entryId, body) =>
      api.call(apiRoutes.opsKnowledgeEdit, { params: { id: clientId, entryId }, body }),
    archive: (entryId, baseVersion) =>
      api.call(apiRoutes.opsKnowledgeArchive, {
        params: { id: clientId, entryId },
        body: { baseVersion },
      }),
  };

  const indexed = data?.documents.filter((d) => d.indexed).length ?? 0;
  return (
    <ClientFrame
      clientId={clientId}
      intro={
        data
          ? `${data.entries.length} FAQs and policies · ${indexed} of ${data.documents.length} documents indexed · ${data.memoryNotes.count} memory notes`
          : undefined
      }
    >
      {loading && !data ? <Loading /> : null}
      {error ? <ErrorNotice error={error} onRetry={reload} /> : null}
      {data ? (
        <div className="grid grid-cols-1 gap-8 xl:grid-cols-[minmax(0,1fr)_380px]">
          <div className="flex min-w-0 flex-col gap-8">
            <section>
              <SectionLabel
                action={
                  <StatusFilter
                    value={show}
                    onChange={setShow}
                    area="ops-knowledge"
                    label="Which entries"
                    options={[
                      ["active", "In use"],
                      ["all", "All, with archived"],
                    ]}
                  />
                }
              >
                FAQs and policies
              </SectionLabel>
              <EntryList
                entries={data.entries}
                actions={actions}
                onChanged={reload}
                us="Mezonas"
                area="ops-knowledge"
                empty="No FAQs or policies yet. Add what this client's agents should know."
                extra={(entry) => <History clientId={clientId} entry={entry} />}
              />
            </section>
            <section>
              <SectionLabel>Documents</SectionLabel>
              {data.documents.length === 0 ? (
                <EmptyState>
                  No documents yet. Uploaded and forwarded documents are indexed here.
                </EmptyState>
              ) : (
                <div className="dt dt-ana overflow-x-auto">
                  <table data-testid="ops-knowledge-documents">
                    <thead>
                      <tr className="dt-cols">
                        <th>Document</th>
                        <th>Received</th>
                        <th>Passages</th>
                        <th>Search</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.documents.map((d) => (
                        <tr key={d.id} data-testid={`ops-knowledge-document-${d.id}`}>
                          <td>
                            <span className="block text-ink">{d.title ?? d.filename}</span>
                            {d.title && d.title !== d.filename ? (
                              <span className="block text-sm text-ink-muted">{d.filename}</span>
                            ) : null}
                          </td>
                          <td className="text-ink-muted">{when(d.receivedAt)}</td>
                          <td className="figures">{d.passages}</td>
                          <td>
                            <Badge tone={d.indexed ? "positive" : "neutral"}>
                              {d.indexed ? "Indexed" : "Not indexed yet"}
                            </Badge>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>
            <section>
              <SectionLabel>Memory notes</SectionLabel>
              {data.memoryNotes.recent.length === 0 ? (
                <EmptyState>
                  No notes yet. Agents write them as they learn this client's ways; each agent
                  searches its own.
                </EmptyState>
              ) : (
                <ul className="flex flex-col gap-2" data-testid="ops-knowledge-notes">
                  {data.memoryNotes.recent.map((n) => (
                    <li key={n.id} className="ds-card p-4">
                      <p className="whitespace-pre-wrap text-ink">{n.note}</p>
                      <p className="mt-1 text-sm text-ink-muted">
                        {n.agent.name} · {when(n.createdAt)}
                      </p>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </div>
          <div className="flex flex-col gap-6">
            <Card className="p-5" testId="ops-knowledge-add">
              <SectionLabel>Add an FAQ or policy</SectionLabel>
              <EntryForm
                submitLabel="Add"
                testId="ops-knowledge-new"
                onSubmit={async (v) => {
                  await actions.create(v);
                  reload();
                }}
              />
            </Card>
            <SearchPreview clientId={clientId} />
          </div>
        </div>
      ) : null}
    </ClientFrame>
  );
}

function History({ clientId, entry }: { clientId: string; entry: KnowledgeEntry }) {
  const [open, setOpen] = useState(false);
  const { data, error } = useApi(
    apiRoutes.opsKnowledgeVersions,
    open ? { params: { id: clientId, entryId: entry.id } } : null,
  );
  return (
    <>
      <Button
        size="sm"
        variant="ghost"
        data-testid="ops-knowledge-entry-history"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        {open ? "Hide history" : `History (${entry.version})`}
      </Button>
      {open ? (
        <div className="mt-2 w-full border-t border-line pt-3">
          {error ? <ErrorNotice error={error} /> : null}
          {data ? (
            <ol className="flex flex-col gap-3" data-testid="ops-knowledge-versions">
              {[...data.versions].reverse().map((v) => (
                <li key={v.id}>
                  <p className="text-sm text-ink-muted">
                    Version {v.version} · {v.author.name ?? v.author.role} · {when(v.createdAt)}
                    {v.status === "archived" ? " · archived" : ""}
                  </p>
                  <p className="font-medium text-ink">{v.title}</p>
                  <p className="whitespace-pre-wrap text-sm text-ink">{v.body}</p>
                </li>
              ))}
            </ol>
          ) : (
            <Loading />
          )}
        </div>
      ) : null}
    </>
  );
}

function SearchPreview({ clientId }: { clientId: string }) {
  const api = useApiClient();
  const [q, setQ] = useState("");
  const [results, setResults] = useState<KnowledgeHit[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  async function search(e: FormEvent) {
    e.preventDefault();
    if (!q.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const out = await api.call(apiRoutes.opsKnowledgeSearch, {
        params: { id: clientId },
        query: { q: q.trim(), limit: 10 },
      });
      setResults(out.results);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className="p-5" testId="ops-knowledge-search">
      <SectionLabel>Try a search</SectionLabel>
      <p className="mb-3 text-sm text-ink-muted">
        What an agent finds with knowledge.search. Here every agent's notes are included; an agent
        searches only its own.
      </p>
      <form className="flex gap-2" onSubmit={(e) => void search(e)}>
        <TextInput
          data-testid="ops-knowledge-search-input"
          aria-label="Question"
          value={q}
          placeholder="e.g. When do you deliver?"
          onChange={(e) => setQ(e.target.value)}
        />
        <Button type="submit" data-testid="ops-knowledge-search-go" disabled={busy || !q.trim()}>
          Search
        </Button>
      </form>
      {error ? (
        <div className="mt-3">
          <ErrorNotice error={error} />
        </div>
      ) : null}
      {results ? (
        results.length === 0 ? (
          <p className="mt-3 text-ink-muted" data-testid="ops-knowledge-search-none">
            Nothing found.
          </p>
        ) : (
          <ol className="mt-3 flex flex-col gap-3" data-testid="ops-knowledge-search-results">
            {results.map((r) => (
              <li key={r.id} className="border-t border-line pt-3">
                <div className="flex items-center justify-between gap-2">
                  <span className="font-medium text-ink">{r.title}</span>
                  <Badge tone="neutral">{HIT_LABEL[r.kind]}</Badge>
                </div>
                <p className="mt-1 text-sm text-ink">{r.excerpt}</p>
                <p className="mt-1 reference text-xs text-ink-muted">{r.sources.join(" · ")}</p>
              </li>
            ))}
          </ol>
        )
      ) : null}
    </Card>
  );
}
