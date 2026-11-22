// Round 4 D (docs/plan.md §1.211): the client's dollar thresholds, beside "Who approves". At or over
// an amount, every change to the client's tools waits for a person, whatever else would let it go
// ahead; below it nothing changes. We can only lower or add one; the client's admin may also raise
// or remove their own. Everyone else reads them.
//
// Loaded on its own with its words (six languages), so it is not in the app's first load.

import { evidenceRoutes, type WriteThreshold } from "@countersign/core";
import { useState } from "react";
import { useApi, useApiClient } from "../api/useApi";
import { useI18n } from "../i18n/i18n";
import { Field, TextInput } from "../ui/forms";
import { Button, ErrorNotice, SectionLabel } from "../ui/primitives";

type WordKey =
  | "title"
  | "lead"
  | "none"
  | "from"
  | "currency"
  | "add"
  | "remove"
  | "save"
  | "onlyLower";
const WORDS: Record<string, Record<WordKey, string>> & { en: Record<WordKey, string> } = {
  en: {
    title: "Amounts that always wait for a person",
    lead: "From these amounts, every change to your tools waits for a person to approve it.",
    none: "No amounts set.",
    from: "From",
    currency: "Currency",
    add: "Add an amount",
    remove: "Remove",
    save: "Save",
    onlyLower: "We can only lower an amount or add one.",
  },
  es: {
    title: "Importes que siempre esperan a una persona",
    lead: "A partir de estos importes, cada cambio en sus herramientas espera la aprobación de una persona.",
    none: "No hay importes.",
    from: "Desde",
    currency: "Moneda",
    add: "Añadir un importe",
    remove: "Quitar",
    save: "Guardar",
    onlyLower: "Solo podemos bajar un importe o añadir uno.",
  },
  fr: {
    title: "Montants qui attendent toujours une personne",
    lead: "À partir de ces montants, chaque changement dans vos outils attend l'accord d'une personne.",
    none: "Aucun montant.",
    from: "À partir de",
    currency: "Devise",
    add: "Ajouter un montant",
    remove: "Retirer",
    save: "Enregistrer",
    onlyLower: "Nous pouvons seulement baisser un montant ou en ajouter un.",
  },
  de: {
    title: "Beträge, die immer auf eine Person warten",
    lead: "Ab diesen Beträgen wartet jede Änderung an Ihren Tools auf die Freigabe einer Person.",
    none: "Keine Beträge festgelegt.",
    from: "Ab",
    currency: "Währung",
    add: "Betrag hinzufügen",
    remove: "Entfernen",
    save: "Speichern",
    onlyLower: "Wir können einen Betrag nur senken oder einen hinzufügen.",
  },
  it: {
    title: "Importi che attendono sempre una persona",
    lead: "Da questi importi, ogni modifica ai vostri strumenti attende l'approvazione di una persona.",
    none: "Nessun importo.",
    from: "Da",
    currency: "Valuta",
    add: "Aggiungi un importo",
    remove: "Rimuovi",
    save: "Salva",
    onlyLower: "Possiamo solo abbassare un importo o aggiungerne uno.",
  },
  "pt-BR": {
    title: "Valores que sempre aguardam uma pessoa",
    lead: "A partir destes valores, toda alteração nas suas ferramentas aguarda a aprovação de uma pessoa.",
    none: "Nenhum valor definido.",
    from: "A partir de",
    currency: "Moeda",
    add: "Adicionar um valor",
    remove: "Remover",
    save: "Salvar",
    onlyLower: "Só podemos baixar um valor ou adicionar um.",
  },
};

export default function WriteThresholds({
  surface,
  clientId,
  canEdit,
}: {
  surface: "portal" | "ops";
  /** The back office's client. */
  clientId?: string;
  /** The portal: only the client's admin saves. */
  canEdit: boolean;
}) {
  const { locale, fmt } = useI18n();
  const w = WORDS[locale] ?? WORDS.en;
  const client = useApiClient();
  // One hook either way: both routes answer the same view.
  const state = useApi(
    (surface === "ops"
      ? evidenceRoutes.opsWriteThresholds
      : evidenceRoutes.portalWriteThresholds) as typeof evidenceRoutes.opsWriteThresholds,
    (surface === "ops" ? { params: { id: clientId ?? "" } } : {}) as never,
  );
  const [draft, setDraft] = useState<WriteThreshold[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  const data = state.data;
  const rows = draft ?? data?.thresholds ?? [];

  async function save() {
    if (!data || !draft) return;
    setError(null);
    try {
      const body = { thresholds: draft, revision: data.revision };
      if (surface === "ops") {
        await client.call(evidenceRoutes.opsSaveWriteThresholds, {
          params: { id: clientId ?? "" },
          body,
        });
      } else {
        await client.call(evidenceRoutes.portalSaveWriteThresholds, { body });
      }
      setDraft(null);
      state.reload();
    } catch (e) {
      setError(e);
    }
  }

  const edit = (i: number, change: Partial<WriteThreshold>) =>
    setDraft(rows.map((r, j) => (j === i ? { ...r, ...change } : r)));

  return (
    <section className="flex flex-col gap-3" data-testid="write-thresholds">
      <SectionLabel>{w.title}</SectionLabel>
      <p className="text-sm text-ink-muted">
        {w.lead}
        {surface === "ops" ? ` ${w.onlyLower}` : ""}
      </p>
      {state.error ? <ErrorNotice error={state.error} onRetry={state.reload} /> : null}
      {error ? <ErrorNotice error={error} /> : null}
      {data && !canEdit ? (
        rows.length === 0 ? (
          <p className="text-sm text-ink-muted">{w.none}</p>
        ) : (
          <ul className="flex flex-col gap-1 text-sm text-ink figures">
            {rows.map((r) => (
              <li key={r.currency}>
                {w.from} {fmt.money(r.approveFrom, r.currency)}
              </li>
            ))}
          </ul>
        )
      ) : null}
      {data && canEdit ? (
        <div className="flex flex-col gap-3">
          {rows.map((r, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: a row's currency is what it edits.
            <div key={i} className="flex flex-wrap items-end gap-3">
              <Field label={w.currency}>
                <TextInput
                  value={r.currency}
                  maxLength={3}
                  className="w-24"
                  onChange={(e) => edit(i, { currency: e.target.value.toUpperCase() })}
                />
              </Field>
              <Field label={w.from}>
                <TextInput
                  value={r.approveFrom}
                  inputMode="decimal"
                  className="w-40 figures"
                  onChange={(e) => edit(i, { approveFrom: e.target.value.trim() })}
                />
              </Field>
              {surface === "portal" ? (
                <Button variant="ghost" onClick={() => setDraft(rows.filter((_, j) => j !== i))}>
                  {w.remove}
                </Button>
              ) : null}
            </div>
          ))}
          <div className="flex flex-wrap gap-2">
            <Button
              variant="secondary"
              onClick={() => setDraft([...rows, { currency: "USD", approveFrom: "" }])}
            >
              {w.add}
            </Button>
            {draft ? (
              <Button variant="primary" onClick={() => void save()}>
                {w.save}
              </Button>
            ) : null}
          </div>
        </div>
      ) : null}
    </section>
  );
}
