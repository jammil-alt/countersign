// `/start`: Getting started (docs/cases-plan.md §4.5 "Get to the point", §4.6; docs/plan.md
// §1.126.2), the client's home while an intake is open and no agent is live. The lead's note, then
// a card per part (the business, each area, each agent): what an agent would do, "We think" lines
// to say yes to or change, at most about five questions (the rest one click away), a Connect card
// for each tool (the Accounts page's own connect flow), Start with this or Not now, and Ask someone
// else. Under the cards: Different process in mind?, Rather talk it through? (Sloan, next wave),
// and every question as one plain form. Read from and written to `/api/intake`; never a fact's id,
// a question's origin or anything of ours (invariant 11). Answers are the client's words: data.
import {
  GENERAL_SECTION,
  type GENERIC_AREA_SUFFIXES,
  genericAreaSection,
  INTAKE_AREA_TITLES,
  type IntakeAnswerView,
  type IntakeArea,
  type PortalGuideField,
  type PortalGuideSection,
  type PortalIntakeView,
  portalIntakeRoutes,
  type SectionProgress,
} from "@countersign/core";
import { type ReactNode, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import type { ResponseOf } from "../../api/client";
import { apiRoutes } from "../../api/routes";
import { attachToMessage } from "../../api/upload";
import { useApi, useApiClient } from "../../api/useApi";
import { ConnectorMark } from "../../connections/ConnectorMark";
import type { PlainKey } from "../../i18n/catalog";
import { type I18n, useI18n } from "../../i18n/i18n";
import { useSession } from "../../session/session";
import { Field, Select, TextArea, TextInput } from "../../ui/forms";
import { Loaded, Page } from "../../ui/page";
import { Badge, Button, Card, EmptyState, ErrorNotice, PageHeader, Tag } from "../../ui/primitives";
import { startConnect } from "./Accounts";

type View = PortalIntakeView;
type Offered = ResponseOf<typeof apiRoutes.portalConnections>["connections"][number];
type Member = ResponseOf<typeof apiRoutes.portalTeam>["members"][number];

/** At most this many questions show on a card before "Show more" (cases-plan: about five). */
export const CARD_QUESTIONS = 5;

export function GettingStartedScreen() {
  const state = useApi(portalIntakeRoutes.portalCurrentIntake);
  return (
    <Page width="narrow" testId="portal-start">
      <Loaded state={state}>
        {(d) => (d.intake ? <GettingStarted initial={d.intake} /> : <NothingToAnswer />)}
      </Loaded>
    </Page>
  );
}

function NothingToAnswer() {
  const { t } = useI18n();
  return (
    <>
      <PageHeader title={t("start.title")} />
      <EmptyState title={t("start.none")}>{t("start.noneBody")}</EmptyState>
    </>
  );
}

// ── Words: core's own questions in the reader's language ────────────────────────────────────────

const GENERAL_WORDS: Record<string, { label: PlainKey; hint?: PlainKey }> = {
  "general.what": { label: "start.q.general.what" },
  "general.team": { label: "start.q.general.team" },
  "general.approver": { label: "start.q.general.approver", hint: "start.q.general.approver.hint" },
  "general.systems": { label: "start.q.general.systems", hint: "start.q.general.systems.hint" },
  "general.first": { label: "start.q.general.first" },
  "general.limits": { label: "start.q.general.limits", hint: "start.q.general.limits.hint" },
};
const AREA_WORDS: Record<
  (typeof GENERIC_AREA_SUFFIXES)[number],
  { label: PlainKey; hint?: PlainKey }
> = {
  today: { label: "start.q.area.today" },
  who: { label: "start.q.area.who" },
  tools: { label: "start.q.area.tools" },
  volume: { label: "start.q.area.volume", hint: "start.q.area.volume.hint" },
  wrong: { label: "start.q.area.wrong" },
};
const AREA_TITLE_WORDS: Record<IntakeArea, PlainKey> = {
  purchasing: "start.area.purchasing",
  sales: "start.area.sales",
  receivables: "start.area.receivables",
  bookkeeping: "start.area.bookkeeping",
  marketing: "start.area.marketing",
};
const FACT_WORDS: Record<string, PlainKey> = {
  business: "start.fact.business",
  people: "start.fact.people",
  systems: "start.fact.systems",
  volumes: "start.fact.volumes",
  processes: "start.fact.processes",
  pains: "start.fact.pains",
  limits: "start.fact.limits",
  notes: "start.fact.notes",
};

/** Core's English words for a question, to know it hasn't been reworded by the lead. */
function coreWords(key: string): { label: string; hint: string } | null {
  const general = GENERAL_SECTION.fields.find((f) => f.key === key);
  if (general) return { label: general.label, hint: general.hint };
  const m = /^area\.([a-z_]+)\.([a-z]+)$/.exec(key);
  if (m?.[1] && m[1] in INTAKE_AREA_TITLES) {
    const f = genericAreaSection(m[1] as IntakeArea).fields.find((x) => x.key === key);
    if (f) return { label: f.label, hint: f.hint };
  }
  return null;
}

/**
 * A question's words for the reader: core's own in their language (unless the lead reworded it);
 * a pack's, a template's or the lead's as written.
 */
// DECISION: core's general and generic area questions, the cards' names and a fact line's name are
// translated here; a pack's and a template's questions show as written (English today), as their
// reports do.
export function fieldWords(
  f: PortalGuideField,
  { t }: Pick<I18n, "t">,
): { label: string; hint: string } {
  if (f.kind === "tool" && f.connector && /^Connect /.test(f.label)) {
    return { label: t("start.connect", { name: f.label.slice("Connect ".length) }), hint: "" };
  }
  if (f.key.startsWith("fact.") && f.fileSection && FACT_WORDS[f.fileSection]) {
    return { label: t(FACT_WORDS[f.fileSection] as PlainKey), hint: "" };
  }
  const core = coreWords(f.key);
  if (!core || core.label !== f.label) return { label: f.label, hint: f.hint };
  const words =
    GENERAL_WORDS[f.key] ??
    AREA_WORDS[f.key.split(".").at(-1) as (typeof GENERIC_AREA_SUFFIXES)[number]];
  if (!words) return { label: f.label, hint: f.hint };
  return {
    label: t(words.label),
    hint: core.hint === f.hint ? (words.hint ? t(words.hint) : "") : f.hint,
  };
}

export function sectionWords(s: PortalGuideSection, { t }: Pick<I18n, "t">) {
  if (s.kind === "general" && s.title === GENERAL_SECTION.title) {
    return { title: t("start.section.general"), intro: t("start.section.general.intro") };
  }
  if (s.kind === "area" && s.area && s.title === INTAKE_AREA_TITLES[s.area]) {
    const generic = s.intro === genericAreaSection(s.area).intro;
    return { title: t(AREA_TITLE_WORDS[s.area]), intro: generic ? t("start.area.intro") : s.intro };
  }
  return { title: s.title, intro: s.intro };
}

// ── Values: what a person types, as the field's kind wants it ──────────────────────────────────

type Draft = string | string[];

/** A draft as the answer's value, or undefined when there is nothing (or nothing valid) to send. */
export function draftValue(f: PortalGuideField, draft: Draft | undefined): unknown {
  if (draft === undefined) return undefined;
  if (Array.isArray(draft)) return draft.length > 0 ? draft : undefined;
  const v = draft.trim();
  if (!v) return undefined;
  switch (f.kind) {
    case "number": {
      const n = Number(v.replace(/,/g, ""));
      return Number.isFinite(n) ? n : undefined;
    }
    case "yes_no":
      return v === "yes" ? true : v === "no" ? false : undefined;
    case "money":
      return /^\d+(\.\d{1,4})?$/.test(v) ? { amount: v, currency: "USD" } : undefined;
    default:
      return v;
  }
}

/** An answer in words, as the card shows it once given. */
function answerWords(a: IntakeAnswerView, { t }: Pick<I18n, "t">): string {
  const v = a.value;
  if (typeof v === "boolean") return v ? t("start.yes") : t("start.no");
  if (typeof v === "string" || typeof v === "number") return String(v);
  if (Array.isArray(v)) return v.join(", ");
  if (v && typeof v === "object" && "amount" in v) return String((v as { amount: string }).amount);
  if (v && typeof v === "object" && "documentIds" in v) {
    return t("start.files.added", { count: (v as { documentIds: string[] }).documentIds.length });
  }
  return "";
}

const ANSWERED = new Set(["answered", "confirmed", "corrected"]);

// ── The page ────────────────────────────────────────────────────────────────────────────────────

function GettingStarted({ initial }: { initial: View }) {
  const i18n = useI18n();
  const { t } = i18n;
  const api = useApiClient();
  const [view, setView] = useState(initial);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const needsTools = view.sections.some((s) => s.fields.some((f) => f.kind === "tool"));
  const connections = useApi(apiRoutes.portalConnections, needsTools ? {} : null);
  useEffect(() => setView(initial), [initial]);

  const answers = new Map(view.answers.map((a) => [a.fieldKey, a]));
  const total = view.progress.reduce((n, p) => n + p.total, 0);
  const answered = view.progress.reduce((n, p) => n + p.answered, 0);

  /** One write; the answer is the intake as it now is. */
  async function act(run: () => Promise<View | null>): Promise<boolean> {
    setBusy(true);
    setError(null);
    try {
      const next = await run();
      if (next) setView(next);
      return true;
    } catch (e) {
      setError(e);
      return false;
    } finally {
      setBusy(false);
    }
  }
  const id = view.intake.id;
  const ctx: CardCtx = {
    view,
    answers,
    busy,
    offered: connections.data?.connections ?? [],
    answer: (items) =>
      act(() =>
        api.call(portalIntakeRoutes.portalIntakeAnswer, {
          params: { id },
          body: { answers: items },
        }),
      ),
    confirm: (body) =>
      act(() => api.call(portalIntakeRoutes.portalIntakeConfirm, { params: { id }, body })),
    reload: () =>
      act(async () => (await api.call(portalIntakeRoutes.portalCurrentIntake)).intake ?? null),
  };

  return (
    <div className="flex flex-col gap-6" data-testid="start-page">
      <PageHeader
        title={t("start.title")}
        subtitle={
          <span data-testid="start-progress">
            {t("start.subtitle", { answered: String(answered), total: String(total) })}
          </span>
        }
      />
      {view.intake.leadNote ? <LeadNote view={view} /> : null}
      {error ? <ErrorNotice error={error} /> : null}
      {view.sections.map((s) => (
        <SectionCard key={s.key} section={s} ctx={ctx} />
      ))}
      <DifferentProcess view={view} />
      <Card pad testId="start-talk">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-sm text-ink">{t("start.talk")}</p>
          <span className="flex items-center gap-2">
            <Button size="sm" disabled data-testid="start-talk-button">
              {t("start.talk.button")}
            </Button>
            <Badge>{t("start.talkSoon")}</Badge>
          </span>
        </div>
      </Card>
      <PlainForm ctx={ctx} />
      <p className="text-sm text-ink-muted" data-testid="start-never">
        {t("start.never")}
      </p>
    </div>
  );
}

function LeadNote({ view }: { view: View }) {
  const { t } = useI18n();
  const name = view.intake.lead?.name ?? "";
  const initials = name
    .split(/\s+/)
    .map((w) => w[0] ?? "")
    .join("")
    .slice(0, 2)
    .toUpperCase();
  return (
    <Card pad testId="start-lead-note">
      <div className="flex items-start gap-3">
        <span
          aria-hidden
          className="inline-flex size-9 shrink-0 items-center justify-center rounded-full border border-copper-tint bg-copper-tint text-sm font-medium text-copper-ink"
        >
          {initials || "M"}
        </span>
        <div className="min-w-0">
          {name ? <p className="text-sm text-ink-muted">{t("start.from", { name })}</p> : null}
          <p className="whitespace-pre-line text-ink">{view.intake.leadNote}</p>
        </div>
      </div>
    </Card>
  );
}

interface CardCtx {
  view: View;
  answers: Map<string, IntakeAnswerView>;
  busy: boolean;
  offered: readonly Offered[];
  answer(
    items: { fieldKey: string; state: "answered" | "not_sure" | "later"; value?: unknown }[],
  ): Promise<boolean>;
  confirm(body: {
    sectionKey: string;
    fields?: { fieldKey: string; value?: unknown }[];
    decision?: "start" | "not_now";
  }): Promise<boolean>;
  reload(): Promise<boolean>;
}

function progressPill(p: SectionProgress | undefined, { t }: Pick<I18n, "t">): ReactNode {
  if (!p || p.total === 0) return null;
  const done = p.answered + p.notSure >= p.total;
  return done ? (
    <Badge tone="positive" testId="start-card-done">
      {t("start.done")}
    </Badge>
  ) : (
    <Badge testId="start-card-progress">
      {t("start.cardProgress", { answered: String(p.answered), total: String(p.total) })}
    </Badge>
  );
}

function SectionCard({ section, ctx }: { section: PortalGuideSection; ctx: CardCtx }) {
  const i18n = useI18n();
  const { t } = i18n;
  const [more, setMore] = useState(false);
  const [asking, setAsking] = useState(false);
  const words = sectionWords(section, i18n);
  const progress = ctx.view.progress.find((p) => p.sectionKey === section.key);
  // A question asked on another card the person also sees: named here, answered there.
  const visible = new Set(ctx.view.sections.map((s) => s.key));
  const elsewhere = ctx.view.sections
    .filter((s) => s.key !== section.key)
    .flatMap((s) =>
      s.fields.filter((f) => f.alsoIn.includes(section.key) && f.sectionKey === s.key),
    )
    .filter((f) => visible.has(f.sectionKey));
  const confirmLines = section.fields.filter((f) => f.state === "to_confirm" && f.weThink);
  const tools = section.fields.filter((f) => f.kind === "tool" && f.state !== "to_confirm");
  const questions = section.fields.filter((f) => f.kind !== "tool" && f.state === "to_ask");
  const shown = more ? questions : questions.slice(0, CARD_QUESTIONS);
  const later = section.fields.filter((f) => f.state === "later");

  return (
    <Card
      testId={`start-card-${section.key}`}
      title={words.title}
      meta={progressPill(progress, i18n)}
      footer={
        <CardFoot section={section} progress={progress} ctx={ctx} onAsk={() => setAsking(true)} />
      }
    >
      <div className="ui-card__body flex flex-col gap-5">
        {words.intro ? <p className="text-ink-muted">{words.intro}</p> : null}
        {confirmLines.length > 0 ? (
          <ul className="flex flex-col gap-3" data-testid="start-we-think">
            {confirmLines.map((f) => (
              <WeThinkLine key={f.key} field={f} section={section} ctx={ctx} />
            ))}
          </ul>
        ) : null}
        {tools.map((f) => (
          <ConnectCard key={f.key} field={f} ctx={ctx} />
        ))}
        {shown.length > 0 ? (
          <QuestionList fields={shown} ctx={ctx} testId={`start-questions-${section.key}`} />
        ) : null}
        {questions.length > shown.length ? (
          <div>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setMore(true)}
              data-testid="start-more"
            >
              {t("start.more", { count: questions.length - shown.length })}
            </Button>
          </div>
        ) : null}
        {elsewhere.length > 0 ? (
          <ul className="flex flex-col gap-1 text-sm text-ink-muted">
            {elsewhere.map((f) => {
              const home = ctx.view.sections.find((s) => s.key === f.sectionKey);
              return (
                <li key={f.key} data-testid={`start-asked-in-${f.key}`}>
                  {fieldWords(f, i18n).label}{" "}
                  {t("start.askedIn", { card: home ? sectionWords(home, i18n).title : "" })}
                </li>
              );
            })}
          </ul>
        ) : null}
        {later.length > 0 ? (
          <p className="text-sm text-ink-muted">{t("start.laterNote", { count: later.length })}</p>
        ) : null}
        {asking ? (
          <AskSomeoneElse section={section} ctx={ctx} onClose={() => setAsking(false)} />
        ) : null}
      </div>
    </Card>
  );
}

function CardFoot({
  section,
  progress,
  ctx,
  onAsk,
}: {
  section: PortalGuideSection;
  progress: SectionProgress | undefined;
  ctx: CardCtx;
  onAsk: () => void;
}) {
  const { t } = useI18n();
  const decision = progress?.decision ?? null;
  return (
    <div className="flex flex-wrap items-center justify-between gap-3">
      <Button size="sm" variant="ghost" onClick={onAsk} data-testid="start-ask-open">
        {t("start.ask.button")}
      </Button>
      <span className="flex flex-wrap items-center gap-2">
        {decision ? (
          <span className="text-sm text-ink-muted" data-testid="start-decision">
            {decision === "start" ? t("start.started") : t("start.notNowChosen")}
          </span>
        ) : null}
        {decision !== "not_now" ? (
          <Button
            size="sm"
            variant="ghost"
            disabled={ctx.busy}
            data-testid="start-not-now"
            onClick={() => void ctx.confirm({ sectionKey: section.key, decision: "not_now" })}
          >
            {t("start.notNow")}
          </Button>
        ) : null}
        {decision !== "start" ? (
          <Button
            size="sm"
            variant="primary"
            disabled={ctx.busy}
            data-testid="start-start"
            onClick={() => void ctx.confirm({ sectionKey: section.key, decision: "start" })}
          >
            {t("start.startThis")}
          </Button>
        ) : null}
      </span>
    </div>
  );
}

function WeThinkLine({
  field,
  section,
  ctx,
}: {
  field: PortalGuideField;
  section: PortalGuideSection;
  ctx: CardCtx;
}) {
  const i18n = useI18n();
  const { t } = i18n;
  const [changing, setChanging] = useState(false);
  const [draft, setDraft] = useState<Draft | undefined>(undefined);
  const given = ctx.answers.get(field.key);
  const words = fieldWords(field, i18n);
  return (
    <li className="flex flex-col gap-2" data-testid={`start-line-${field.key}`}>
      <span className="text-sm text-ink-muted">{words.label}</span>
      <span className="text-ink">
        {given && ANSWERED.has(given.state)
          ? answerWords(given, i18n)
          : t("start.weThink", { text: field.weThink?.text ?? "" })}
      </span>
      {given && ANSWERED.has(given.state) ? (
        <span>
          <Badge tone="positive">
            {given.state === "corrected" ? t("start.changed") : t("start.confirmed")}
          </Badge>
        </span>
      ) : changing ? (
        <div className="flex flex-col gap-2">
          <ValueInput field={field} draft={draft} onChange={setDraft} />
          <span className="flex gap-2">
            <Button
              size="sm"
              variant="primary"
              disabled={ctx.busy || draftValue(field, draft) === undefined}
              data-testid="start-change-save"
              onClick={() =>
                void ctx
                  .confirm({
                    sectionKey: section.key,
                    fields: [{ fieldKey: field.key, value: draftValue(field, draft) }],
                  })
                  .then((ok) => ok && setChanging(false))
              }
            >
              {t("start.save")}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setChanging(false)}>
              {t("start.cancel")}
            </Button>
          </span>
        </div>
      ) : (
        <span className="flex gap-2">
          <Button
            size="sm"
            variant="primary"
            disabled={ctx.busy}
            data-testid="start-yes"
            onClick={() =>
              void ctx.confirm({ sectionKey: section.key, fields: [{ fieldKey: field.key }] })
            }
          >
            {t("start.yes")}
          </Button>
          <Button
            size="sm"
            disabled={ctx.busy}
            data-testid="start-change"
            onClick={() => setChanging(true)}
          >
            {t("start.change")}
          </Button>
        </span>
      )}
    </li>
  );
}

function ConnectCard({ field, ctx }: { field: PortalGuideField; ctx: CardCtx }) {
  const i18n = useI18n();
  const { t } = i18n;
  const api = useApiClient();
  const session = useSession();
  const [error, setError] = useState<unknown>(null);
  const isAdmin =
    (session.tenants.find((c) => c.id === session.activeTenantId) ?? session.tenants[0])?.role ===
    "client_admin";
  const given = ctx.answers.get(field.key);
  const offered = ctx.offered.find((o) => o.connector === field.connector);
  const name = offered?.name ?? fieldWords(field, i18n).label.replace(/^\S+\s/, "");
  const connected = given?.state === "answered";
  return (
    <div
      className="flex flex-col gap-2 rounded-md border border-line px-4 py-3"
      data-testid={`start-connect-${field.connector}`}
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <span className="flex min-w-0 items-center gap-3">
          <ConnectorMark name={name} connector={field.connector ?? ""} />
          <span className="font-medium text-ink">{fieldWords(field, i18n).label}</span>
        </span>
        {connected ? (
          <Badge tone="positive" testId="start-connected">
            {t("start.connected")}
          </Badge>
        ) : given?.state === "not_sure" ? (
          <Badge>{t("start.notSure")}</Badge>
        ) : null}
      </div>
      {connected ? null : (
        <>
          <p className="text-sm text-ink-muted">{t("start.connectHow")}</p>
          <span className="flex flex-wrap items-center gap-2">
            {isAdmin || offered?.personal === true ? (
              offered?.credentialForm ? (
                <Link className="ds-btn ds-btn--primary ds-btn--sm" to="/accounts#vault">
                  {t("start.enterKey")}
                </Link>
              ) : (
                <Button
                  size="sm"
                  variant="primary"
                  disabled={ctx.busy || !offered?.available}
                  data-testid="start-connect"
                  onClick={() => {
                    setError(null);
                    void startConnect(api, field.connector ?? "")
                      .then(() => ctx.reload())
                      .catch(setError);
                  }}
                >
                  {fieldWords(field, i18n).label}
                </Button>
              )
            ) : (
              <span className="text-sm text-ink-muted">{t("start.adminConnects")}</span>
            )}
            {given?.state !== "not_sure" ? (
              <Button
                size="sm"
                variant="ghost"
                disabled={ctx.busy}
                data-testid="start-cant-connect"
                onClick={() => void ctx.answer([{ fieldKey: field.key, state: "not_sure" }])}
              >
                {t("start.cantConnect")}
              </Button>
            ) : null}
          </span>
          {error ? <ErrorNotice error={error} /> : null}
        </>
      )}
    </div>
  );
}

function QuestionList({
  fields,
  ctx,
  testId,
}: {
  fields: readonly PortalGuideField[];
  ctx: CardCtx;
  testId: string;
}) {
  const i18n = useI18n();
  const { t } = i18n;
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const ready = fields.flatMap((f) => {
    const value = draftValue(f, drafts[f.key]);
    return value === undefined ? [] : [{ fieldKey: f.key, state: "answered" as const, value }];
  });
  return (
    <div className="flex flex-col gap-4" data-testid={testId}>
      {fields.map((f) => {
        const given = ctx.answers.get(f.key);
        const words = fieldWords(f, i18n);
        return (
          <div key={f.key} className="flex flex-col gap-1" data-testid={`start-field-${f.key}`}>
            <Field label={words.label} hint={words.hint || undefined}>
              <ValueInput
                field={f}
                draft={drafts[f.key] ?? draftOf(given)}
                onChange={(d) => setDrafts((all) => ({ ...all, [f.key]: d }))}
              />
            </Field>
            <span className="flex flex-wrap items-center gap-2">
              {given && ANSWERED.has(given.state) ? (
                <Tag>{t("start.answered")}</Tag>
              ) : given?.state === "not_sure" || given?.state === "later" ? (
                <Tag>{t("start.notSure")}</Tag>
              ) : (
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={ctx.busy}
                  data-testid={`start-not-sure-${f.key}`}
                  onClick={() => void ctx.answer([{ fieldKey: f.key, state: "not_sure" }])}
                >
                  {t("start.notSure")}
                </Button>
              )}
            </span>
          </div>
        );
      })}
      <div>
        <Button
          variant="primary"
          size="sm"
          disabled={ctx.busy || ready.length === 0}
          data-testid="start-save"
          onClick={() => void ctx.answer(ready).then((ok) => ok && setDrafts({}))}
        >
          {t("start.save")}
        </Button>
      </div>
    </div>
  );
}

/** A given answer as a draft, so the box shows it. */
function draftOf(a: IntakeAnswerView | undefined): Draft | undefined {
  if (!a || !ANSWERED.has(a.state)) return undefined;
  const v = a.value;
  if (typeof v === "boolean") return v ? "yes" : "no";
  if (typeof v === "string" || typeof v === "number") return String(v);
  if (Array.isArray(v)) return v.map(String);
  if (v && typeof v === "object" && "amount" in v) return String((v as { amount: string }).amount);
  return undefined;
}

function ValueInput({
  field,
  draft,
  onChange,
}: {
  field: PortalGuideField;
  draft: Draft | undefined;
  onChange: (d: Draft) => void;
}) {
  const { t } = useI18n();
  const text = typeof draft === "string" ? draft : "";
  const testId = `start-input-${field.key}`;
  switch (field.kind) {
    case "long_text":
      return (
        <TextArea
          rows={3}
          value={text}
          data-testid={testId}
          onChange={(e) => onChange(e.target.value)}
        />
      );
    case "number":
    case "money":
      return (
        <TextInput
          inputMode="decimal"
          value={text}
          data-testid={testId}
          onChange={(e) => onChange(e.target.value)}
        />
      );
    case "date":
      return (
        <TextInput
          type="date"
          value={text}
          data-testid={testId}
          onChange={(e) => onChange(e.target.value)}
        />
      );
    case "yes_no":
      return (
        <Select value={text} data-testid={testId} onChange={(e) => onChange(e.target.value)}>
          <option value="">{t("start.choose")}</option>
          <option value="yes">{t("start.yes")}</option>
          <option value="no">{t("start.no")}</option>
        </Select>
      );
    case "choice":
      return (
        <Select value={text} data-testid={testId} onChange={(e) => onChange(e.target.value)}>
          <option value="">{t("start.choose")}</option>
          {(field.choices ?? []).map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </Select>
      );
    case "choices": {
      const picked = Array.isArray(draft) ? draft : [];
      return (
        <span className="flex flex-col gap-1" data-testid={testId}>
          {(field.choices ?? []).map((c) => (
            <label key={c} className="flex items-center gap-2 text-sm text-ink">
              <input
                type="checkbox"
                checked={picked.includes(c)}
                onChange={(e) =>
                  onChange(e.target.checked ? [...picked, c] : picked.filter((x) => x !== c))
                }
              />
              {c}
            </label>
          ))}
        </span>
      );
    }
    case "files":
      return <FilesInput field={field} onChange={onChange} />;
    default:
      return (
        <TextInput value={text} data-testid={testId} onChange={(e) => onChange(e.target.value)} />
      );
  }
}

/** Files go up quietly (as a chat's do), and the answer is their ids. */
function FilesInput({
  field,
  onChange,
}: {
  field: PortalGuideField;
  onChange: (d: Draft) => void;
}) {
  const { t } = useI18n();
  const [ids, setIds] = useState<string[]>([]);
  const [problem, setProblem] = useState<string | null>(null);
  return (
    <span className="flex flex-col gap-1">
      <input
        type="file"
        multiple
        accept="application/pdf,image/*"
        data-testid={`start-input-${field.key}`}
        onChange={(e) => {
          const files = [...(e.target.files ?? [])];
          if (files.length === 0) return;
          setProblem(null);
          void attachToMessage(files, (name) => t("attach.refused", { name }))
            .then((out) => {
              const next = [...ids, ...out.files.map((f) => f.id)].slice(0, 20);
              setIds(next);
              onChange(next);
              if (out.refused.length > 0) setProblem(out.refused.join(" "));
            })
            .catch(() => setProblem(t("attach.failed")));
        }}
      />
      {ids.length > 0 ? (
        <span className="text-sm text-ink-muted">
          {t("start.files.added", { count: ids.length })}
        </span>
      ) : null}
      {problem ? <span className="ds-error text-sm">{problem}</span> : null}
    </span>
  );
}

function AskSomeoneElse({
  section,
  ctx,
  onClose,
}: {
  section: PortalGuideSection;
  ctx: CardCtx;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const api = useApiClient();
  const isAdmin = ctx.view.you.isAdmin;
  const team = useApi(apiRoutes.portalTeam);
  const session = useSession();
  const [who, setWho] = useState("");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [fieldKey, setFieldKey] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [done, setDone] = useState<string | null>(null);
  const members = (team.data?.members ?? []).filter((m: Member) => m.userId !== session.user.id);
  const isNew = who === "new";
  const canSend = isNew ? name.trim() && email.trim() : who !== "";
  const i18n = useI18n();
  if (done) {
    return (
      <p className="text-sm text-ink" data-testid="start-ask-done">
        {done}
      </p>
    );
  }
  return (
    <div
      className="flex flex-col gap-3 rounded-md border border-line px-4 py-3"
      data-testid="start-ask"
    >
      <Field label={t("start.ask.who")}>
        <Select value={who} data-testid="start-ask-who" onChange={(e) => setWho(e.target.value)}>
          <option value="">{t("start.ask.pick")}</option>
          {members.map((m) => (
            <option key={m.userId} value={m.userId}>
              {m.name ?? m.email}
            </option>
          ))}
          {isAdmin ? <option value="new">{t("start.ask.new")}</option> : null}
        </Select>
      </Field>
      {isNew ? (
        <>
          <Field label={t("start.ask.name")}>
            <TextInput
              value={name}
              data-testid="start-ask-name"
              onChange={(e) => setName(e.target.value)}
            />
          </Field>
          <Field label={t("start.ask.email")}>
            <TextInput
              type="email"
              value={email}
              data-testid="start-ask-email"
              onChange={(e) => setEmail(e.target.value)}
            />
          </Field>
        </>
      ) : null}
      {isAdmin ? null : <p className="text-sm text-ink-muted">{t("start.ask.onlyAdmin")}</p>}
      <Field label={t("start.ask.what")}>
        <Select
          value={fieldKey}
          data-testid="start-ask-what"
          onChange={(e) => setFieldKey(e.target.value)}
        >
          <option value="">{t("start.ask.wholeCard")}</option>
          {section.fields
            .filter((f) => f.sectionKey === section.key)
            .map((f) => (
              <option key={f.key} value={f.key}>
                {fieldWords(f, i18n).label}
              </option>
            ))}
        </Select>
      </Field>
      <Field label={t("start.ask.note")}>
        <TextInput
          value={note}
          data-testid="start-ask-note"
          onChange={(e) => setNote(e.target.value)}
        />
      </Field>
      {error ? <ErrorNotice error={error} /> : null}
      <span className="flex gap-2">
        <Button
          size="sm"
          variant="primary"
          disabled={busy || !canSend}
          data-testid="start-ask-send"
          onClick={() => {
            setBusy(true);
            setError(null);
            void api
              .call(portalIntakeRoutes.portalIntakeAsk, {
                params: { id: ctx.view.intake.id },
                body: {
                  ...(fieldKey ? { fieldKey } : { sectionKey: section.key }),
                  ...(isNew ? { name: name.trim(), email: email.trim() } : { userId: who }),
                  ...(note.trim() ? { note: note.trim() } : {}),
                },
              })
              .then((out) => {
                setDone(
                  out.emailed
                    ? t("start.ask.sent", { name: out.person.name })
                    : t("start.ask.added", { name: out.person.name }),
                );
                void ctx.reload();
              })
              .catch(setError)
              .finally(() => setBusy(false));
          }}
        >
          {t("start.ask.send")}
        </Button>
        <Button size="sm" variant="ghost" onClick={onClose}>
          {t("start.cancel")}
        </Button>
      </span>
    </div>
  );
}

function DifferentProcess({ view }: { view: View }) {
  const { t } = useI18n();
  const api = useApiClient();
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const lead = view.intake.lead?.name;
  return (
    <Card pad testId="start-different">
      <div className="flex flex-col gap-3">
        <h3 className="type-subheading text-ink">{t("start.different.title")}</h3>
        <p className="text-sm text-ink-muted">
          {lead ? t("start.different.body", { lead }) : t("start.different.bodyNoLead")}
        </p>
        {sent ? (
          <p className="text-sm text-ink" data-testid="start-different-sent">
            {t("start.different.sent")}
          </p>
        ) : (
          <>
            <TextArea
              rows={3}
              value={text}
              data-testid="start-different-text"
              onChange={(e) => setText(e.target.value)}
            />
            {error ? <ErrorNotice error={error} /> : null}
            <div>
              <Button
                size="sm"
                variant="primary"
                disabled={busy || !text.trim()}
                data-testid="start-different-send"
                onClick={() => {
                  setBusy(true);
                  setError(null);
                  void api
                    .call(portalIntakeRoutes.portalIntakeDifferentProcess, {
                      params: { id: view.intake.id },
                      body: { text: text.trim() },
                    })
                    .then(() => setSent(true))
                    .catch(setError)
                    .finally(() => setBusy(false));
                }}
              >
                {t("start.different.send")}
              </Button>
            </div>
          </>
        )}
      </div>
    </Card>
  );
}

/** Every question on the person's cards as one plain form: always works, with no model. */
function PlainForm({ ctx }: { ctx: CardCtx }) {
  const { t } = useI18n();
  const seen = new Set<string>();
  const fields = ctx.view.sections.flatMap((s) =>
    s.fields.filter((f) => {
      if (seen.has(f.key) || f.kind === "tool" || f.state === "later") return false;
      seen.add(f.key);
      return true;
    }),
  );
  if (fields.length === 0) return null;
  return (
    <details className="ds-card" data-testid="start-plain-form">
      <summary className="ui-card__head cursor-pointer">
        <span className="type-subheading text-ink">{t("start.form.title")}</span>
      </summary>
      <div className="ui-card__body">
        <QuestionList fields={fields} ctx={ctx} testId="start-plain-questions" />
      </div>
    </details>
  );
}
