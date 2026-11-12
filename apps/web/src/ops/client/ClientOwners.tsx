// v0.17 O4 (ARCHITECTURE §10.15, docs/plan.md §1.96): the client's area owners, at the top of the
// client page's Agents tab. One card per owner: its name (renamable), the area it owns and the
// processes in it, the model it reasons on (any priced provider, or each process's own), its notes
// (Markdown, the "memory file"), how closely it reviews processes that saved no setting, and the
// memory notes it saved from its own decisions, each deletable. Saving makes the owner's next
// version; renaming makes none.

import { type OpsOwnerView, OVERSIGHT_REVIEWS, type OversightReview } from "@countersign/core";
import { useState } from "react";
import { apiRoutes } from "../../api/routes";
import { useApi, useApiClient } from "../../api/useApi";
import { Field, Select, TextArea, TextInput } from "../../ui/forms";
import { Section } from "../../ui/page";
import { Button, Card, ErrorNotice, Tag } from "../../ui/primitives";
import { MODEL_OPTIONS, modelOptionLabel } from "../agents/definition-form";

const AREA_WORDS: Record<OpsOwnerView["area"], string> = {
  purchasing: "Purchasing",
  sales: "Sales",
  receivables: "Receivables",
  bookkeeping: "Bookkeeping",
  marketing: "Marketing",
  general: "Operations",
};

const REVIEW_WORDS: Record<OversightReview | "default", string> = {
  default: "The platform's default (new processes: failures; older ones: off)",
  off: "Off",
  failures: "Failures only",
  checkpoints: "Failures, and outputs a write uses",
  all: "Every step (about twice the model calls)",
};

export function OwnersSection({ clientId }: { clientId: string }) {
  const owners = useApi(apiRoutes.opsClientOwners, { params: { id: clientId } });
  return (
    <Section title="Owners" testId="ops-client-owners-section">
      <p className="mb-3 text-sm text-ink-muted">
        One owner per business area watches every process in it, fixes what it can within the plan,
        and suggests lasting changes for you to approve.
      </p>
      {owners.error ? <ErrorNotice error={owners.error} onRetry={owners.reload} /> : null}
      {owners.data?.owners.length === 0 ? (
        <p className="text-sm text-ink-muted">No owners yet: they appear with the first process.</p>
      ) : null}
      <div className="flex flex-col gap-4">
        {(owners.data?.owners ?? []).map((o) => (
          <OwnerCard key={o.id} owner={o} onSaved={owners.reload} />
        ))}
      </div>
    </Section>
  );
}

function OwnerCard({ owner, onSaved }: { owner: OpsOwnerView; onSaved: () => void }) {
  const api = useApiClient();
  const [name, setName] = useState(owner.name);
  const [model, setModel] = useState(owner.model?.id ?? "");
  const [notes, setNotes] = useState(owner.notes);
  const [review, setReview] = useState<OversightReview | "default">(
    owner.oversight?.review ?? "default",
  );
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const testId = `ops-owner-${owner.area}`;

  const act = async (work: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await work();
      onSaved();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };
  const changed =
    model !== (owner.model?.id ?? "") ||
    notes !== owner.notes ||
    review !== (owner.oversight?.review ?? "default");

  return (
    <Card
      pad
      testId={testId}
      title={
        <span className="flex items-center gap-2">
          <span className="font-semibold">{owner.name}</span>
          <Tag>{AREA_WORDS[owner.area]}</Tag>
        </span>
      }
      meta={<span className="text-sm text-ink-muted">Version {owner.version}</span>}
    >
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <Field label="Name" hint="2 to 12 letters. The client admin can rename it too.">
          <span className="flex gap-2">
            <TextInput
              value={name}
              data-testid={`${testId}-name`}
              onChange={(e) => setName(e.target.value)}
            />
            <Button
              disabled={busy || name.trim() === owner.name}
              data-testid={`${testId}-rename`}
              onClick={() =>
                act(() =>
                  api.call(apiRoutes.opsOwnerRename, {
                    params: { id: owner.id },
                    body: { name: name.trim() },
                  }),
                )
              }
            >
              Rename
            </Button>
          </span>
        </Field>
        <Field label="Model" hint="What it reasons on when it reviews a step.">
          <Select
            value={model}
            data-testid={`${testId}-model`}
            onChange={(e) => setModel(e.target.value)}
          >
            <option value="">Each process's own model</option>
            {[...new Set([...MODEL_OPTIONS, ...(owner.model ? [owner.model.id] : [])])].map((m) => (
              <option key={m} value={m}>
                {modelOptionLabel(m)}
              </option>
            ))}
          </Select>
        </Field>
        <Field
          label="Reviews"
          hint="For processes in this area that saved no setting of their own."
        >
          <Select
            value={review}
            data-testid={`${testId}-review`}
            onChange={(e) => setReview(e.target.value as OversightReview | "default")}
          >
            {(["default", ...OVERSIGHT_REVIEWS] as const).map((r) => (
              <option key={r} value={r}>
                {REVIEW_WORDS[r]}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Processes">
          <span className="flex flex-wrap gap-1 text-sm" data-testid={`${testId}-processes`}>
            {owner.processes.length === 0
              ? "None yet"
              : owner.processes.map((p) => <Tag key={p.agentId}>{p.name}</Tag>)}
          </span>
        </Field>
      </div>
      <Field
        className="mt-4"
        label="Notes"
        hint="Markdown. How this client's area works, what to watch for, who to ask. It reads them on every review."
      >
        <TextArea
          rows={6}
          value={notes}
          data-testid={`${testId}-notes`}
          onChange={(e) => setNotes(e.target.value)}
        />
      </Field>
      <div className="mt-3 flex items-center gap-3">
        <Button
          variant="primary"
          disabled={busy || !changed}
          data-testid={`${testId}-save`}
          onClick={() =>
            act(() =>
              api.call(apiRoutes.opsOwnerVersion, {
                params: { id: owner.id },
                body: {
                  model: model ? { id: model } : null,
                  notes,
                  oversight:
                    review === "default"
                      ? null
                      : {
                          review,
                          maxPerRun: owner.oversight?.maxPerRun ?? 3,
                          maxCostUsd: owner.oversight?.maxCostUsd ?? "0.25",
                        },
                },
              }),
            )
          }
        >
          Save as version {owner.version + 1}
        </Button>
        {error ? <ErrorNotice error={error} /> : null}
      </div>
      <div className="mt-5">
        <p className="text-sm font-medium text-ink">What it remembers</p>
        {owner.memory.length === 0 ? (
          <p className="text-sm text-ink-muted">
            Nothing yet. It saves notes from its own decisions.
          </p>
        ) : (
          <ul className="mt-1 flex flex-col gap-1" data-testid={`${testId}-memory`}>
            {owner.memory.map((m) => (
              <li key={m.id} className="flex items-start justify-between gap-3 text-sm">
                <span>{m.note}</span>
                <Button
                  size="sm"
                  disabled={busy}
                  onClick={() =>
                    act(() =>
                      api.call(apiRoutes.opsOwnerForget, {
                        params: { id: owner.id, noteId: m.id },
                      }),
                    )
                  }
                >
                  Forget
                </Button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Card>
  );
}
