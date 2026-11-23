// Round 4 D (docs/plan.md §1.211; ARCHITECTURE §10.18): the evidence on a proposed change, in both
// inboxes: what it rests on (the document or feed line the run read), the step and the rule that
// produced it, how sure the reading was, and the second check (agrees, disagrees with both
// answers, or couldn't check). The values before and after are already the card's own table.
//
// Loaded on its own (React.lazy from the card), with its words in this file, so neither its code,
// its route specs nor its six languages' words are in the app's first load (scripts/web-size.mjs).
// The evidence itself is asked for only when the person opens it.

import { evidenceRoutes, type OpsWriteEvidence, type WriteEvidence } from "@countersign/core";
import { useState } from "react";
import { Link } from "react-router-dom";
import { useApi } from "../api/useApi";
import { useI18n } from "../i18n/i18n";
import { Badge, type Tone } from "../ui/primitives";

type WordKey =
  | "title"
  | "loading"
  | "failed"
  | "source"
  | "noSource"
  | "step"
  | "after"
  | "rule"
  | "confidence"
  | "fromDocument"
  | "fromStep"
  | "check"
  | "agreed"
  | "disagreed"
  | "cannot"
  | "field"
  | "proposed"
  | "derived"
  | "no_sources"
  | "not_derivable"
  | "nothing_compared"
  | "review_failed"
  | "threshold"
  | "version";
type Words = Record<WordKey, string>;

// The five languages other than English are drafts for the owner's fluent speakers, as elsewhere.
const WORDS: Record<string, Words> & { en: Words } = {
  en: {
    title: "Evidence",
    loading: "Reading the evidence…",
    failed: "We couldn't load the evidence. Try again in a moment.",
    source: "Rests on",
    noSource: "Nothing the run read is kept for this change.",
    step: "Proposed by",
    after: "from",
    rule: "Rule",
    confidence: "Confidence",
    fromDocument: "reading the document",
    fromStep: "the step's own",
    check: "Second check",
    agreed: "Agrees",
    disagreed: "Disagrees: check this",
    cannot: "Couldn't check: we look at it",
    field: "Field",
    proposed: "Proposed",
    derived: "Second check",
    no_sources: "The run kept nothing to check it against.",
    not_derivable: "The sources don't say what this change should be.",
    nothing_compared: "The check found nothing to compare.",
    review_failed: "The check didn't finish.",
    threshold: "Waits for a person: it is {amount} or more.",
    version: "Agent version",
  },
  es: {
    title: "Pruebas",
    loading: "Leyendo las pruebas…",
    failed: "No pudimos cargar las pruebas. Inténtelo de nuevo en un momento.",
    source: "Se basa en",
    noSource: "No se guardó nada de lo que leyó la ejecución para este cambio.",
    step: "Propuesto por",
    after: "a partir de",
    rule: "Regla",
    confidence: "Confianza",
    fromDocument: "lectura del documento",
    fromStep: "la del paso",
    check: "Segunda revisión",
    agreed: "Coincide",
    disagreed: "No coincide: revíselo",
    cannot: "No se pudo revisar: lo vemos nosotros",
    field: "Campo",
    proposed: "Propuesto",
    derived: "Segunda revisión",
    no_sources: "La ejecución no guardó nada con qué revisarlo.",
    not_derivable: "Las fuentes no dicen cuál debe ser este cambio.",
    nothing_compared: "La revisión no encontró nada que comparar.",
    review_failed: "La revisión no terminó.",
    threshold: "Espera a una persona: es de {amount} o más.",
    version: "Versión del agente",
  },
  fr: {
    title: "Justificatifs",
    loading: "Lecture des justificatifs…",
    failed: "Nous n'avons pas pu charger les justificatifs. Réessayez dans un instant.",
    source: "Repose sur",
    noSource: "Rien de ce que l'exécution a lu n'est conservé pour ce changement.",
    step: "Proposé par",
    after: "à partir de",
    rule: "Règle",
    confidence: "Confiance",
    fromDocument: "lecture du document",
    fromStep: "celle de l'étape",
    check: "Second contrôle",
    agreed: "Concorde",
    disagreed: "Ne concorde pas : à vérifier",
    cannot: "Contrôle impossible : nous regardons",
    field: "Champ",
    proposed: "Proposé",
    derived: "Second contrôle",
    no_sources: "L'exécution n'a rien conservé pour le contrôler.",
    not_derivable: "Les sources ne disent pas ce que doit être ce changement.",
    nothing_compared: "Le contrôle n'a rien trouvé à comparer.",
    review_failed: "Le contrôle ne s'est pas terminé.",
    threshold: "Attend une personne : {amount} ou plus.",
    version: "Version de l'agent",
  },
  de: {
    title: "Nachweise",
    loading: "Nachweise werden gelesen…",
    failed: "Die Nachweise konnten nicht geladen werden. Versuchen Sie es gleich noch einmal.",
    source: "Beruht auf",
    noSource: "Für diese Änderung ist nichts gespeichert, was der Lauf gelesen hat.",
    step: "Vorgeschlagen von",
    after: "aus",
    rule: "Regel",
    confidence: "Sicherheit",
    fromDocument: "Lesen des Dokuments",
    fromStep: "die des Schritts",
    check: "Zweite Prüfung",
    agreed: "Stimmt überein",
    disagreed: "Weicht ab: bitte prüfen",
    cannot: "Nicht prüfbar: wir sehen es uns an",
    field: "Feld",
    proposed: "Vorgeschlagen",
    derived: "Zweite Prüfung",
    no_sources: "Der Lauf hat nichts gespeichert, womit es sich prüfen ließe.",
    not_derivable: "Die Quellen sagen nicht, wie diese Änderung lauten muss.",
    nothing_compared: "Die Prüfung fand nichts zum Vergleichen.",
    review_failed: "Die Prüfung wurde nicht abgeschlossen.",
    threshold: "Wartet auf eine Person: {amount} oder mehr.",
    version: "Agentenversion",
  },
  it: {
    title: "Prove",
    loading: "Lettura delle prove…",
    failed: "Non siamo riusciti a caricare le prove. Riprovi tra un momento.",
    source: "Si basa su",
    noSource: "Per questa modifica non è conservato nulla di ciò che l'esecuzione ha letto.",
    step: "Proposto da",
    after: "a partire da",
    rule: "Regola",
    confidence: "Affidabilità",
    fromDocument: "lettura del documento",
    fromStep: "quella del passaggio",
    check: "Secondo controllo",
    agreed: "Concorda",
    disagreed: "Non concorda: da verificare",
    cannot: "Controllo non possibile: lo guardiamo noi",
    field: "Campo",
    proposed: "Proposto",
    derived: "Secondo controllo",
    no_sources: "L'esecuzione non ha conservato nulla con cui controllarlo.",
    not_derivable: "Le fonti non dicono quale debba essere questa modifica.",
    nothing_compared: "Il controllo non ha trovato nulla da confrontare.",
    review_failed: "Il controllo non è terminato.",
    threshold: "Attende una persona: {amount} o più.",
    version: "Versione dell'agente",
  },
  "pt-BR": {
    title: "Evidências",
    loading: "Lendo as evidências…",
    failed: "Não conseguimos carregar as evidências. Tente de novo em instantes.",
    source: "Baseia-se em",
    noSource: "Nada do que a execução leu foi guardado para esta alteração.",
    step: "Proposto por",
    after: "a partir de",
    rule: "Regra",
    confidence: "Confiança",
    fromDocument: "leitura do documento",
    fromStep: "a da etapa",
    check: "Segunda verificação",
    agreed: "Confere",
    disagreed: "Não confere: verifique",
    cannot: "Não foi possível verificar: nós olhamos",
    field: "Campo",
    proposed: "Proposto",
    derived: "Segunda verificação",
    no_sources: "A execução não guardou nada para verificar.",
    not_derivable: "As fontes não dizem qual deve ser esta alteração.",
    nothing_compared: "A verificação não encontrou nada para comparar.",
    review_failed: "A verificação não terminou.",
    threshold: "Aguarda uma pessoa: {amount} ou mais.",
    version: "Versão do agente",
  },
};

function text(v: unknown): string {
  if (v === null || v === undefined) return "—";
  return typeof v === "string" ? v : JSON.stringify(v);
}

const CHECK_TONE: Record<string, Tone> = {
  agreed: "positive",
  disagreed: "risk",
  cannot_verify: "warning",
};

/** The evidence a card's change rests on; loaded when the person opens it. */
export default function EvidencePanel({
  itemId,
  surface,
  verification,
  documentHref,
}: {
  itemId: string;
  surface: "portal" | "ops";
  /** The card's own `payload.verification` outcome, so the summary says it before loading. */
  verification?: string | null;
  /**
   * The document's page, where its file (the PDF) opens, for a source's id, in this surface.
   */
  // DECISION (QA WR3): a document the change rests on links to its own page, one click from the
  // PDF, not to the record page (two clicks, and it doesn't read as the PDF).
  documentHref?: ((id: string) => string) | null;
}) {
  const { locale, fmt } = useI18n();
  const w: Words = WORDS[locale] ?? WORDS.en;
  const [open, setOpen] = useState(false);
  const route =
    surface === "ops" ? evidenceRoutes.opsInboxEvidence : evidenceRoutes.portalInboxEvidence;
  const state = useApi(route, open ? { params: { id: itemId } } : null);
  const evidence = state.data?.evidence as (WriteEvidence & Partial<OpsWriteEvidence>) | undefined;
  const outcome = evidence?.verification?.outcome ?? verification ?? null;
  const outcomeWord =
    outcome === "agreed"
      ? w.agreed
      : outcome === "disagreed"
        ? w.disagreed
        : outcome === "cannot_verify"
          ? w.cannot
          : null;

  return (
    <details
      className="border-t border-line pt-3 text-sm"
      data-testid="inbox-evidence"
      onToggle={(e) => setOpen((e.target as HTMLDetailsElement).open)}
    >
      <summary className="flex cursor-pointer flex-wrap items-center gap-2 font-medium text-ink">
        {w.title}
        {outcome && outcomeWord ? (
          <Badge tone={CHECK_TONE[outcome] ?? "neutral"} testId="inbox-evidence-check">
            {w.check}: {outcomeWord}
          </Badge>
        ) : null}
      </summary>
      <div className="mt-3 flex flex-col gap-3">
        {state.error && !evidence ? (
          <p className="text-ink-muted">{w.failed}</p>
        ) : !evidence ? (
          <p className="text-ink-muted">{w.loading}</p>
        ) : (
          <dl
            className="grid grid-cols-[max-content_1fr] gap-x-6 gap-y-2"
            data-testid="inbox-evidence-facts"
          >
            <dt className="text-ink-muted">{w.source}</dt>
            <dd className="min-w-0 break-words text-ink">
              {evidence.sources.length === 0 ? (
                <span className="text-ink-muted">{w.noSource}</span>
              ) : (
                <ul className="flex flex-col gap-1">
                  {evidence.sources.map((s, i) => {
                    const line = [
                      s.label,
                      s.number,
                      s.amount && s.currency ? fmt.money(s.amount, s.currency) : (s.amount ?? null),
                    ]
                      .filter(Boolean)
                      .join(" · ");
                    return (
                      <li key={`${s.recordId ?? i}:${s.kind}`} className="figures">
                        {s.recordId && documentHref && s.kind === "document" ? (
                          <Link
                            to={documentHref(s.recordId)}
                            data-testid={`inbox-evidence-document-${s.recordId}`}
                          >
                            {line || s.kind}
                          </Link>
                        ) : (
                          line || s.kind
                        )}
                      </li>
                    );
                  })}
                </ul>
              )}
            </dd>
            {evidence.producedBy.step ? (
              <>
                <dt className="text-ink-muted">{w.step}</dt>
                <dd className="text-ink">
                  {evidence.producedBy.step.name}
                  {evidence.producedBy.from.length > 0 ? (
                    <span className="text-ink-muted">
                      {" "}
                      ({w.after} {evidence.producedBy.from.map((f) => f.name).join(", ")})
                    </span>
                  ) : null}
                </dd>
              </>
            ) : null}
            {evidence.producedBy.rule ? (
              <>
                <dt className="text-ink-muted">{w.rule}</dt>
                <dd className="text-ink">{evidence.producedBy.rule}</dd>
              </>
            ) : null}
            {evidence.confidence.value ? (
              <>
                <dt className="text-ink-muted">{w.confidence}</dt>
                <dd className="text-ink figures" data-testid="inbox-evidence-confidence">
                  {Math.round(Number(evidence.confidence.value) * 100)}%
                  <span className="text-ink-muted">
                    {" "}
                    ({evidence.confidence.basis === "document" ? w.fromDocument : w.fromStep})
                  </span>
                </dd>
              </>
            ) : null}
            {evidence.threshold ? (
              <>
                <dt className="text-ink-muted">{w.check}</dt>
                <dd className="text-ink" data-testid="inbox-evidence-threshold">
                  {w.threshold.replace(
                    "{amount}",
                    fmt.money(evidence.threshold.approveFrom, evidence.threshold.currency),
                  )}
                </dd>
              </>
            ) : null}
            {evidence.verification?.reason ? (
              <>
                <dt className="text-ink-muted">{w.check}</dt>
                <dd className="text-ink">{w[evidence.verification.reason]}</dd>
              </>
            ) : null}
            {surface === "ops" && evidence.agentVersionId ? (
              <>
                <dt className="text-ink-muted">{w.version}</dt>
                <dd className="reference">{evidence.agentVersionId}</dd>
              </>
            ) : null}
          </dl>
        )}
        {evidence?.verification && evidence.verification.differences.length > 0 ? (
          <div className="mz-sign__side overflow-x-auto" data-testid="inbox-evidence-differences">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-line text-left text-ink-muted">
                  <th className="px-1 py-2 font-normal">{w.field}</th>
                  <th className="px-1 py-2 font-normal">{w.proposed}</th>
                  <th className="px-1 py-2 font-normal">{w.derived}</th>
                </tr>
              </thead>
              <tbody>
                {evidence.verification.differences.map((d) => (
                  <tr key={d.path} className="border-b border-line last:border-b-0">
                    <td className="px-1 py-2 align-top text-ink-muted">{d.path}</td>
                    <td className="px-1 py-2 align-top break-words text-ink figures">
                      {text(d.proposed)}
                    </td>
                    <td className="px-1 py-2 align-top break-words font-medium text-ink figures">
                      {text(d.derived)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
      </div>
    </details>
  );
}
