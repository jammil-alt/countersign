// The client file (docs/cases-plan.md §4.1; docs/plan.md §1.149): what we know about a prospect or
// a client, by section, each fact with where it came from, how sure we are and who may see it.
// Our notes are marked "Only us" in copper, as the deal's internal notes are: they never leave the
// back office (invariant 11). Facts are only added to: a correction is a new fact that replaces the
// old one, and the history shows what each replaced. A tab on the client page and on a deal's page.
import {
  type ClientFactView,
  type ClientFileDetail,
  clientFileRoutes,
  FACT_AUDIENCES,
  FACT_SECTION_WORDS,
  FACT_SECTIONS,
  FACT_SOURCE_KINDS,
  FACT_SURENESS,
  type FactAudience,
  type FactSection,
  type FactSourceKind,
  type FactSureness,
  type NewClientFactInput,
  shortDay,
} from "@countersign/core";
import { useState } from "react";
import { Link } from "react-router-dom";
import { useApi, useApiClient } from "../../../api/useApi";
import { cx } from "../../../ui/cx";
import { ErrorNotice } from "../../../ui/ErrorState";
import { Field, Select, TextArea } from "../../../ui/forms";
import { Button, Loading } from "../../../ui/primitives";
import { OPS_PATHS } from "../../paths";
import { RadioChoice } from "./parts";
import {
  AUDIENCE_HELP,
  AUDIENCE_WORDS,
  INTAKE_STATUS_WORDS,
  plural,
  SOURCE_WORDS,
  SURENESS_HELP,
  SURENESS_WORDS,
} from "./words";

/** A fact's badges: where it came from, how sure, and "Only us" for our notes. */
export function FactBadges({
  fact,
}: {
  fact: Pick<ClientFactView, "sourceKind" | "sureness" | "audience">;
}) {
  return (
    <span className="flex flex-wrap items-center gap-1.5">
      {fact.audience === "ours" ? (
        <span
          className="ds-pill ds-pill--person ds-pill--sm"
          title={AUDIENCE_HELP.ours}
          data-testid="fact-ours"
        >
          {AUDIENCE_WORDS.ours}
        </span>
      ) : (
        <span className="ds-tag" title={AUDIENCE_HELP.theirs}>
          {AUDIENCE_WORDS.theirs}
        </span>
      )}
      {fact.sureness === "confirmed" ? (
        <span className="ds-pill ds-pill--positive ds-pill--sm" title={SURENESS_HELP.confirmed}>
          {SURENESS_WORDS.confirmed}
        </span>
      ) : (
        <span className="ds-tag" title={SURENESS_HELP[fact.sureness]}>
          {SURENESS_WORDS[fact.sureness]}
        </span>
      )}
      <span className="ds-tag">{SOURCE_WORDS[fact.sourceKind]}</span>
    </span>
  );
}

/** The facts each current fact replaced, newest first (the chain behind a correction). */
export function earlierVersions(
  fact: ClientFactView,
  all: readonly ClientFactView[],
): ClientFactView[] {
  const byId = new Map(all.map((f) => [f.id, f]));
  const out: ClientFactView[] = [];
  let at = fact.replacesId ? byId.get(fact.replacesId) : undefined;
  while (at && out.length < 50) {
    out.push(at);
    at = at.replacesId ? byId.get(at.replacesId) : undefined;
  }
  return out;
}

/** A file by id: its facts by section, add, correct, history. */
export function ClientFileView({ fileId, compact }: { fileId: string; compact?: boolean }) {
  const [history, setHistory] = useState(false);
  const res = useApi(clientFileRoutes.opsClientFile, {
    params: { id: fileId },
    query: { history: history ? "true" : "false" },
    keep: true,
  });
  if (res.loading && !res.data) return <Loading />;
  if (!res.data) return res.error ? <ErrorNotice error={res.error} onRetry={res.reload} /> : null;
  return (
    <FileBody
      detail={res.data}
      history={history}
      onHistory={setHistory}
      onChanged={res.reload}
      compact={compact}
    />
  );
}

function FileBody({
  detail,
  history,
  onHistory,
  onChanged,
  compact,
}: {
  detail: ClientFileDetail;
  history: boolean;
  onHistory(v: boolean): void;
  onChanged(): void;
  compact?: boolean | undefined;
}) {
  const f = detail.file;
  const current = detail.facts.filter((x) => x.replacedById === null);
  const [adding, setAdding] = useState<FactSection | null>(null);
  const [correcting, setCorrecting] = useState<string | null>(null);
  const shown = FACT_SECTIONS.filter(
    (s) => current.some((x) => x.section === s) || adding === s || !compact,
  );
  return (
    <div className="flex flex-col gap-4" data-testid="client-file">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <h2 className="type-subheading text-ink" data-testid="client-file-name">
            {f.name}
          </h2>
          <p className="m-0 text-sm text-ink-muted">
            {[
              f.website,
              f.status === "prospect" ? "Prospect" : f.status === "client" ? "Client" : "Lost",
              plural(f.facts, "fact"),
              f.lastFactAt ? `last added ${shortDay(f.lastFactAt)}` : null,
            ]
              .filter(Boolean)
              .join(" · ")}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            size="sm"
            variant="ghost"
            aria-pressed={history}
            onClick={() => onHistory(!history)}
            data-testid="client-file-history"
          >
            {history ? "Hide the history" : "Show the history"}
          </Button>
          <Button
            size="sm"
            variant="primary"
            onClick={() => setAdding("business")}
            data-testid="client-file-add"
          >
            Add a fact
          </Button>
        </div>
      </div>
      <p className="m-0 text-xs text-ink-muted">
        Facts are only added to. A correction replaces a fact and keeps the old one in the history.
        Only facts marked Theirs are ever shown to the client, to confirm.
      </p>
      {adding !== null ? (
        <FactForm
          fileId={f.id}
          initial={{ section: adding }}
          onDone={() => {
            setAdding(null);
            onChanged();
          }}
          onCancel={() => setAdding(null)}
        />
      ) : null}
      {current.length === 0 && adding === null ? (
        <p className="m-0 text-sm text-ink-muted" data-testid="client-file-empty">
          Nothing filed yet. Add what you heard on the first call.
        </p>
      ) : null}
      {shown.map((s) => {
        const facts = current.filter((x) => x.section === s);
        if (facts.length === 0 && compact) return null;
        return (
          <section key={s} className="ds-card" data-testid={`client-file-section-${s}`}>
            <div className="ui-card__head">
              <h3 className="type-subheading text-ink">{FACT_SECTION_WORDS[s]}</h3>
              <button
                type="button"
                className="ds-btn ds-btn--link text-sm"
                onClick={() => setAdding(s)}
                data-testid={`client-file-add-${s}`}
              >
                Add
              </button>
            </div>
            <div className="ui-card__body">
              {facts.length === 0 ? (
                <p className="m-0 text-sm text-ink-muted">Nothing yet.</p>
              ) : (
                <ul className="m-0 flex list-none flex-col gap-3 p-0">
                  {facts.map((fact) => (
                    <li key={fact.id} data-testid={`fact-${fact.id}`}>
                      {correcting === fact.id ? (
                        <FactForm
                          fileId={f.id}
                          initial={fact}
                          replaces={fact}
                          onDone={() => {
                            setCorrecting(null);
                            onChanged();
                          }}
                          onCancel={() => setCorrecting(null)}
                        />
                      ) : (
                        <FactLine
                          fact={fact}
                          earlier={history ? earlierVersions(fact, detail.facts) : []}
                          onCorrect={() => setCorrecting(fact.id)}
                        />
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </section>
        );
      })}
      {!compact && (detail.deals.length > 0 || detail.intakes.length > 0) ? (
        <section className="ds-card" data-testid="client-file-links">
          <div className="ui-card__head">
            <h3 className="type-subheading text-ink">Deals and intakes</h3>
          </div>
          <ul className="ui-card__body m-0 flex list-none flex-col gap-1.5 text-sm">
            {detail.deals.map((d) => (
              <li key={d.id}>
                <Link to={OPS_PATHS.deal(d.id)} className="text-ink hover:underline">
                  {d.title}
                </Link>
                <span className="ml-2 text-xs text-ink-muted">
                  {d.kind === "new" ? "New account" : "Expansion"}
                  {d.outcome !== "open" ? ` · ${d.outcome}` : ""}
                </span>
              </li>
            ))}
            {detail.intakes.map((i) => (
              <li key={i.id} className="text-ink">
                Intake from {shortDay(i.createdAt)}
                <span className="ml-2 text-xs text-ink-muted">{INTAKE_STATUS_WORDS[i.status]}</span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}

function FactLine({
  fact,
  earlier,
  onCorrect,
}: {
  fact: ClientFactView;
  earlier: ClientFactView[];
  onCorrect(): void;
}) {
  return (
    <div className="flex flex-col gap-1">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <p className="m-0 min-w-0 flex-1 whitespace-pre-wrap text-sm text-ink">{fact.text}</p>
        <button
          type="button"
          className="ds-btn ds-btn--link text-sm"
          onClick={onCorrect}
          data-testid={`fact-correct-${fact.id}`}
        >
          Correct
        </button>
      </div>
      <div className="flex flex-wrap items-center gap-2 text-xs text-ink-muted">
        <FactBadges fact={fact} />
        <span>
          {fact.by ? `${fact.by.name}, ` : ""}
          {shortDay(fact.createdAt)}
          {fact.replacesId ? " · a correction" : ""}
        </span>
      </div>
      {earlier.length > 0 ? (
        <ol
          className="m-0 mt-1 flex list-none flex-col gap-1 border-l border-line pl-3"
          aria-label="Replaced"
          data-testid={`fact-history-${fact.id}`}
        >
          {earlier.map((e) => (
            <li key={e.id} className="text-xs text-ink-muted">
              <span className="line-through">{e.text}</span>{" "}
              <span>
                · replaced · {e.by ? `${e.by.name}, ` : ""}
                {shortDay(e.createdAt)}
              </span>
            </li>
          ))}
        </ol>
      ) : null}
    </div>
  );
}

function FactForm({
  fileId,
  initial,
  replaces,
  onDone,
  onCancel,
}: {
  fileId: string;
  initial: Partial<
    Pick<ClientFactView, "section" | "text" | "sourceKind" | "sureness" | "audience">
  >;
  /** A correction: the fact this one replaces. */
  replaces?: ClientFactView;
  onDone(): void;
  onCancel(): void;
}) {
  const api = useApiClient();
  const [section, setSection] = useState<FactSection>(initial.section ?? "business");
  const [text, setText] = useState(initial.text ?? "");
  const [sourceKind, setSourceKind] = useState<FactSourceKind>(
    replaces ? "note" : (initial.sourceKind ?? "call"),
  );
  const [sureness, setSureness] = useState<FactSureness>(initial.sureness ?? "heard");
  // DECISION (cases-plan §8 q13): a new fact starts Only us; marking it Theirs is a choice.
  const [audience, setAudience] = useState<FactAudience>(initial.audience ?? "ours");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const changed = !replaces || text.trim() !== replaces.text || audience !== replaces.audience;

  async function save() {
    setBusy(true);
    setError(null);
    try {
      const fact: NewClientFactInput = {
        section,
        text: text.trim(),
        sourceKind,
        sureness,
        audience,
        ...(replaces ? { replacesId: replaces.id } : {}),
      };
      await api.call(clientFileRoutes.opsAddClientFacts, {
        params: { id: fileId },
        body: { facts: [fact] },
      });
      onDone();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form
      className={cx("flex flex-col gap-3", replaces ? "" : "ds-card p-4")}
      data-testid={replaces ? "fact-correct-form" : "fact-form"}
      onSubmit={(e) => {
        e.preventDefault();
        if (text.trim() && changed) void save();
      }}
    >
      {replaces ? (
        <p className="m-0 text-xs text-ink-muted">
          Your correction replaces this fact; the old one stays in the history.
        </p>
      ) : null}
      <Field label="The fact">
        <TextArea
          rows={2}
          value={text}
          onChange={(e) => setText(e.target.value)}
          maxLength={2000}
          data-testid="fact-text"
          assist={{ field: "clientFile.fact", context: { fileId } }}
        />
      </Field>
      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="Section">
          <Select
            value={section}
            onChange={(e) => setSection(e.target.value as FactSection)}
            data-testid="fact-section"
          >
            {FACT_SECTIONS.map((s) => (
              <option key={s} value={s}>
                {FACT_SECTION_WORDS[s]}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Where it came from">
          <Select
            value={sourceKind}
            onChange={(e) => setSourceKind(e.target.value as FactSourceKind)}
            data-testid="fact-source"
          >
            {FACT_SOURCE_KINDS.map((s) => (
              <option key={s} value={s}>
                {SOURCE_WORDS[s]}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="How sure">
          <Select
            value={sureness}
            onChange={(e) => setSureness(e.target.value as FactSureness)}
            data-testid="fact-sureness"
          >
            {FACT_SURENESS.map((s) => (
              <option key={s} value={s}>
                {SURENESS_WORDS[s]}: {SURENESS_HELP[s].toLowerCase()}
              </option>
            ))}
          </Select>
        </Field>
      </div>
      <div role="radiogroup" aria-label="Who may see it" className="flex flex-col gap-2">
        {FACT_AUDIENCES.map((a) => (
          <RadioChoice
            key={a}
            checked={audience === a}
            onSelect={() => setAudience(a)}
            testId={`fact-audience-${a}`}
          >
            <span className="block text-ink">
              {a === "ours" ? "Only us" : "About their business"}
            </span>
            <span className="block text-sm text-ink-muted">{AUDIENCE_HELP[a]}</span>
          </RadioChoice>
        ))}
      </div>
      {error ? <ErrorNotice error={error} /> : null}
      <div className="flex gap-2">
        <Button
          type="submit"
          size="sm"
          variant="primary"
          disabled={busy || !text.trim() || !changed}
          data-testid="fact-save"
        >
          {replaces ? "Save the correction" : "Add the fact"}
        </Button>
        <Button size="sm" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

/**
 * A file that doesn't exist yet: "Start the file" makes one for the company (pointing the deal at
 * it, or naming the client), then shows it.
 */
export function StartFile({
  name,
  dealId,
  clientId,
  onMade,
}: {
  name: string;
  dealId?: string;
  clientId?: string;
  onMade(fileId: string): void;
}) {
  const api = useApiClient();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  async function make() {
    setBusy(true);
    setError(null);
    try {
      const out = await api.call(clientFileRoutes.opsCreateClientFile, {
        body: { name, ...(dealId ? { dealId } : {}), ...(clientId ? { clientId } : {}) },
      });
      onMade(out.file.id);
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="ds-card flex flex-col gap-3 p-4" data-testid="client-file-none">
      <p className="m-0 text-sm text-ink">
        No file for {name} yet. It keeps what we learn about them, from the first call on.
      </p>
      {error ? <ErrorNotice error={error} /> : null}
      <Button
        size="sm"
        variant="primary"
        className="self-start"
        disabled={busy}
        onClick={() => void make()}
        data-testid="client-file-start"
      >
        Start the file
      </Button>
    </div>
  );
}
