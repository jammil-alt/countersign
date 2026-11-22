// Invite (docs/cases-plan.md §4.2; docs/plan.md §1.149): a side panel from a deal's page or the
// client page, in five steps. 1 Who (the people we know, the admin, the parts each is asked),
// 2 What it covers (a saved start, general, areas, agents; Reggie's suggestion when there is one),
// 3 The questions (the preview's guide: known, to confirm, to ask; drop, reword, add, ask later;
// the totals; how they start), 4 The email (the lead's note; the emails and the welcome page as
// they'll be seen), 5 Send, with the confirmation's words from the preview route. Nothing changes
// until the send, and the send is always a person's (cases-plan §6).
import {
  type Covers,
  coversAnything,
  EMPTY_COVERS,
  GENERAL_SECTION_KEY,
  GUIDE_FIELD_KINDS,
  type GuideField,
  type GuideFieldKind,
  type GuideSectionKey,
  InviteDraft,
  type InviteDraftInput,
  type InvitePreview,
  type InviteSent,
  inviteRoutes,
  LEAD_NOTE_MAX,
  LOCALE_NAMES,
  LOCALES,
  type Locale,
  type SalesStartView,
  type StartMode,
  sectionKeysOf,
  startRoutes,
} from "@countersign/core";
import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { apiRoutes } from "../../../api/routes";
import { useApi, useApiClient } from "../../../api/useApi";
import { EN } from "../../../i18n/i18n";
import { cx } from "../../../ui/cx";
import { ErrorNotice } from "../../../ui/ErrorState";
import { Field, Select, TextArea, TextInput } from "../../../ui/forms";
import { Button, Loading } from "../../../ui/primitives";
import { SheetSection, SideSheet } from "../../../ui/sheet";
import { OPS_PATHS } from "../../paths";
import { Check, CoversPicker, FlowSteps, RadioChoice, StartModePicker } from "./parts";
import {
  AREA_WORDS,
  coversLine,
  FIELD_KIND_WORDS,
  FIELD_STATE_WORDS,
  INVITE_STEPS,
  listWords,
  plural,
  totalsLine,
} from "./words";

/** Who the invite is for: a client file, a client, or a company by name (a file is made). */
export interface InviteTarget {
  fileId?: string | undefined;
  clientId?: string | undefined;
  company?: string | undefined;
  website?: string | undefined;
  dealId?: string | undefined;
}

export interface PersonRow {
  key: string;
  name: string;
  email: string;
  include: boolean;
  isAdmin: boolean;
  /** The parts they're asked; null for all of them. */
  sections: GuideSectionKey[] | null;
  /** Their language; "" for the client's. */
  language: Locale | "";
}

/** The operator's changes at step 3, as the contract's GuideEdits. */
export interface Edits {
  drop: string[];
  later: string[];
  reword: { key: string; label: string }[];
  add: { sectionKey: GuideSectionKey; label: string; kind: GuideFieldKind }[];
}

const NO_EDITS: Edits = { drop: [], later: [], reword: [], add: [] };

export interface InviteState {
  people: PersonRow[];
  covers: Covers;
  startId: string | null;
  edits: Edits;
  startMode: StartMode;
  note: string;
  /** A `datetime-local` value; "" sends now. */
  sendAt: string;
  agreedMrr: string | null;
  currency: string | null;
}

export interface InviteSetup {
  target: InviteTarget;
  /** The company or the client, in words. */
  name: string;
  /** People we know (the deal's, the file's), offered at step 1. */
  people: { name: string; email: string }[];
  /** An existing client: no account is made, and no admin is needed. */
  existingClient: boolean;
  /** What is already decided (Sign up now's "Review first"). */
  state?: Partial<InviteState>;
  /** The step to open at, from 0 (Who) to 4 (Send). */
  step?: number;
  /**
   * Reggie's suggestion of what to cover, with why (cases-plan §4.2 step 2). Next wave: Reggie
   * reads the file and fills it; empty until then.
   */
  suggestion?: { covers: Covers; why: string } | null;
}

let rowKeys = 0;
export function personRow(p: Partial<PersonRow> & { name: string; email: string }): PersonRow {
  rowKeys += 1;
  return {
    key: `p${rowKeys}`,
    include: true,
    isAdmin: false,
    sections: null,
    language: "",
    ...p,
  };
}

function initialState(setup: InviteSetup): InviteState {
  const people =
    setup.state?.people ??
    (setup.people.length > 0
      ? setup.people.map((p, i) =>
          personRow({ ...p, isAdmin: !setup.existingClient && i === 0, include: i === 0 }),
        )
      : [personRow({ name: "", email: "", isAdmin: !setup.existingClient })]);
  return {
    people,
    covers: setup.state?.covers ?? EMPTY_COVERS,
    startId: setup.state?.startId ?? null,
    edits: setup.state?.edits ?? NO_EDITS,
    // DECISION (cases-plan §8 q12): get to the point unless the operator picks Sloan.
    startMode: setup.state?.startMode ?? "point",
    note: setup.state?.note ?? "",
    sendAt: setup.state?.sendAt ?? "",
    agreedMrr: setup.state?.agreedMrr ?? null,
    currency: setup.state?.currency ?? null,
  };
}

const hasEdits = (e: Edits) => e.drop.length + e.later.length + e.reword.length + e.add.length > 0;

/** The draft the preview and the send take: the people ticked, the edits if any. */
export function inviteDraft(setup: InviteSetup, s: InviteState): InviteDraftInput {
  const t = setup.target;
  return {
    ...(t.fileId ? { fileId: t.fileId } : {}),
    ...(t.clientId ? { clientId: t.clientId } : {}),
    ...(t.company && !t.fileId && !t.clientId ? { company: t.company } : {}),
    ...(t.website && !t.clientId ? { website: t.website } : {}),
    ...(t.dealId ? { dealId: t.dealId } : {}),
    people: s.people
      .filter((p) => p.include)
      .map((p) => ({
        name: p.name.trim(),
        email: p.email.trim().toLowerCase(),
        isAdmin: p.isAdmin,
        ...(p.sections ? { sections: p.sections } : {}),
        ...(p.language ? { language: p.language } : {}),
      })),
    covers: s.covers,
    ...(s.startId ? { startId: s.startId } : {}),
    ...(hasEdits(s.edits) ? { edits: s.edits } : {}),
    startMode: s.startMode,
    note: s.note.trim(),
    ...(s.sendAt ? { sendAt: new Date(s.sendAt).toISOString() } : {}),
    ...(s.agreedMrr ? { agreedMrr: s.agreedMrr } : {}),
    ...(s.currency ? { currency: s.currency } : {}),
  };
}

/** The preview for a draft: asked again a moment after the draft stops changing. */
function usePreview(draft: InviteDraftInput | null) {
  const api = useApiClient();
  const [data, setData] = useState<InvitePreview | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState(false);
  const key = draft ? JSON.stringify(draft) : null;
  const seq = useRef(0);
  useEffect(() => {
    if (key === null) return;
    const n = ++seq.current;
    setLoading(true);
    const timer = setTimeout(() => {
      api
        .call(inviteRoutes.opsInvitePreview, { body: JSON.parse(key) as InviteDraftInput })
        .then((p) => {
          if (n !== seq.current) return;
          setData(p);
          setError(null);
        })
        .catch((e: unknown) => {
          if (n !== seq.current) return;
          setError(e);
        })
        .finally(() => {
          if (n === seq.current) setLoading(false);
        });
    }, 250);
    return () => clearTimeout(timer);
  }, [api, key]);
  return { data, error, loading };
}

/** The first thing wrong with the draft, in words, or null. */
function draftProblem(setup: InviteSetup, s: InviteState): string | null {
  const people = s.people.filter((p) => p.include);
  if (people.length === 0) return "Pick at least one person.";
  if (people.some((p) => !p.name.trim() || !p.email.trim()))
    return "Each person needs a name and an email.";
  if (!setup.existingClient && people.filter((p) => p.isAdmin).length !== 1)
    return "A new account needs one admin.";
  const parsed = InviteDraft.safeParse(inviteDraft(setup, s));
  return parsed.success ? null : (parsed.error.issues[0]?.message ?? "Something isn't right.");
}

export function InviteSheet({
  setup,
  onClose,
  onSent,
}: {
  setup: InviteSetup;
  onClose(): void;
  onSent?(sent: InviteSent): void;
}) {
  const api = useApiClient();
  const [state, setState] = useState<InviteState>(() => initialState(setup));
  const [step, setStep] = useState(setup.step ?? 0);
  const [busy, setBusy] = useState(false);
  const [sendError, setSendError] = useState<unknown>(null);
  const [sent, setSent] = useState<InviteSent | null>(null);
  // A dropped question's words, for "Put back" (the guide no longer has it).
  const [dropLabels, setDropLabels] = useState<Record<string, string>>({});
  const problem = draftProblem(setup, state);
  const draft = useMemo(
    () => (problem === null ? inviteDraft(setup, state) : null),
    [problem, setup, state],
  );
  // The preview is asked from step 3 on (and at step 1 for the refusals, once the draft is whole).
  const preview = usePreview(draft);
  const patch = (p: Partial<InviteState>) => setState((s) => ({ ...s, ...p }));

  async function send() {
    if (!draft) return;
    setBusy(true);
    setSendError(null);
    try {
      const out = await api.call(inviteRoutes.opsInviteSend, { body: draft });
      setSent(out);
      onSent?.(out);
    } catch (e) {
      setSendError(e);
    } finally {
      setBusy(false);
    }
  }

  const p = preview.data;
  const blocked = (p?.problems.length ?? 0) > 0;
  const last = INVITE_STEPS.length - 1;

  const footer = sent ? (
    <Button variant="primary" onClick={onClose} data-testid="invite-done">
      Done
    </Button>
  ) : (
    <div className="flex w-full flex-wrap items-center justify-between gap-2">
      <Button variant="ghost" onClick={() => (step === 0 ? onClose() : setStep(step - 1))}>
        {step === 0 ? "Cancel" : "Back"}
      </Button>
      {step < last ? (
        <Button
          variant="primary"
          disabled={step === 0 && problem !== null}
          onClick={() => setStep(step + 1)}
          data-testid="invite-next"
        >
          Next: {INVITE_STEPS[step + 1]}
        </Button>
      ) : (
        <Button
          variant="primary"
          disabled={busy || !draft || !p || preview.loading || blocked}
          onClick={() => void send()}
          data-testid="invite-send"
        >
          {busy ? "Sending…" : state.sendAt ? "Schedule the invite" : "Send the invite"}
        </Button>
      )}
    </div>
  );

  return (
    <SideSheet
      title={setup.existingClient ? `Invite to ${setup.name}` : `Invite ${setup.name}`}
      onClose={onClose}
      footer={footer}
      testId="invite"
      wide
      tabs={
        sent ? null : (
          <FlowSteps steps={INVITE_STEPS} current={step} onGo={setStep} testId="invite-steps" />
        )
      }
    >
      {sent ? (
        <Sent sent={sent} name={setup.name} />
      ) : step === 0 ? (
        <WhoStep setup={setup} state={state} patch={patch} problem={problem} preview={p} />
      ) : step === 1 ? (
        <CoversStep setup={setup} state={state} patch={patch} />
      ) : step === 2 ? (
        <QuestionsStep
          state={state}
          patch={patch}
          preview={preview}
          labels={dropLabels}
          onLabel={(key, label) => setDropLabels((d) => ({ ...d, [key]: label }))}
        />
      ) : step === 3 ? (
        <EmailStep state={state} patch={patch} preview={preview} />
      ) : (
        <SendStep problem={problem} preview={preview} error={sendError} />
      )}
    </SideSheet>
  );
}

type Patch = (p: Partial<InviteState>) => void;
type PreviewState = ReturnType<typeof usePreview>;

/** The titles of the parts a covers asks, for "only some parts". */
function useSectionTitles(covers: Covers): { key: GuideSectionKey; title: string }[] {
  const templates = useApi(apiRoutes.opsTemplates);
  const names = new Map(
    (templates.data?.templates ?? []).map((t) => [t.id, t.serviceName ?? t.name]),
  );
  return sectionKeysOf(covers).map((key) => ({
    key,
    title:
      key === GENERAL_SECTION_KEY
        ? "The business"
        : key.startsWith("area:")
          ? (AREA_WORDS[key.slice(5) as keyof typeof AREA_WORDS] ?? key.slice(5))
          : (names.get(key.slice(6)) ?? "An agent"),
  }));
}

function WhoStep({
  setup,
  state,
  patch,
  problem,
  preview,
}: {
  setup: InviteSetup;
  state: InviteState;
  patch: Patch;
  problem: string | null;
  preview: InvitePreview | null;
}) {
  const parts = useSectionTitles(state.covers);
  const set = (key: string, p: Partial<PersonRow>) =>
    patch({ people: state.people.map((r) => (r.key === key ? { ...r, ...p } : r)) });
  const admin = (key: string) =>
    patch({ people: state.people.map((r) => ({ ...r, isAdmin: r.key === key })) });
  const refusals = preview?.problems ?? [];
  return (
    <div className="flex flex-col gap-5" data-testid="invite-who">
      <p className="m-0 text-sm text-ink-muted">
        {setup.existingClient
          ? "They join as client users. Give someone only some parts if that's all they know."
          : "One person is the admin. Others join as client users, with all of it or only some parts."}
      </p>
      {state.people.map((r, i) => {
        const refused = refusals.find((x) => x.email && x.email === r.email.trim().toLowerCase());
        return (
          <section
            key={r.key}
            className={cx("ds-card flex flex-col gap-3 p-4", !r.include && "opacity-60")}
            data-testid={`invite-person-${i}`}
          >
            <div className="flex flex-wrap items-center justify-between gap-2">
              <Check
                checked={r.include}
                onChange={(include) => set(r.key, { include })}
                testId={`invite-person-${i}-include`}
              >
                Invite {r.name.trim() || "this person"}
              </Check>
              {setup.existingClient ? null : (
                <div role="radiogroup" aria-label="Admin">
                  <RadioChoice
                    checked={r.isAdmin}
                    onSelect={() => admin(r.key)}
                    testId={`invite-person-${i}-admin`}
                  >
                    The admin
                  </RadioChoice>
                </div>
              )}
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Name">
                <TextInput
                  value={r.name}
                  onChange={(e) => set(r.key, { name: e.target.value })}
                  data-testid={`invite-person-${i}-name`}
                />
              </Field>
              <Field label="Email" error={refused?.message}>
                <TextInput
                  type="email"
                  value={r.email}
                  invalid={Boolean(refused)}
                  onChange={(e) => set(r.key, { email: e.target.value })}
                  data-testid={`invite-person-${i}-email`}
                />
              </Field>
              <Field label="Language" hint="For the email and the welcome page">
                <Select
                  value={r.language}
                  onChange={(e) => set(r.key, { language: e.target.value as Locale | "" })}
                  data-testid={`invite-person-${i}-language`}
                >
                  <option value="">The client's</option>
                  {LOCALES.map((l) => (
                    <option key={l} value={l}>
                      {LOCALE_NAMES[l]}
                    </option>
                  ))}
                </Select>
              </Field>
            </div>
            {r.include ? (
              <div className="flex flex-col gap-2">
                <span className="text-sm font-medium text-ink">What they're asked</span>
                {parts.length === 0 ? (
                  <span className="text-sm text-ink-muted">
                    All of it. Choose what the invite covers (step 2) to give them only some parts.
                  </span>
                ) : (
                  <div className="flex flex-wrap gap-2">
                    <Check
                      checked={r.sections === null}
                      onChange={(all) => set(r.key, { sections: all ? null : [] })}
                      testId={`invite-person-${i}-all`}
                    >
                      All of it
                    </Check>
                    {r.sections !== null
                      ? parts.map((s) => (
                          <Check
                            key={s.key}
                            checked={r.sections?.includes(s.key) ?? false}
                            onChange={(on) =>
                              set(r.key, {
                                sections: on
                                  ? [...(r.sections ?? []), s.key]
                                  : (r.sections ?? []).filter((k) => k !== s.key),
                              })
                            }
                            testId={`invite-person-${i}-part-${s.key}`}
                          >
                            {s.title}
                          </Check>
                        ))
                      : null}
                  </div>
                )}
              </div>
            ) : null}
          </section>
        );
      })}
      <Button
        size="sm"
        variant="ghost"
        className="self-start"
        onClick={() => patch({ people: [...state.people, personRow({ name: "", email: "" })] })}
        data-testid="invite-person-add"
      >
        Add a person
      </Button>
      {problem ? (
        <p className="m-0 text-sm text-ink-muted" data-testid="invite-who-problem">
          {problem}
        </p>
      ) : null}
    </div>
  );
}

function CoversStep({
  setup,
  state,
  patch,
}: {
  setup: InviteSetup;
  state: InviteState;
  patch: Patch;
}) {
  const starts = useApi(startRoutes.opsStarts, { query: { archived: "false" } });
  function pickStart(s: SalesStartView) {
    patch({
      startId: s.id,
      covers: s.covers,
      startMode: s.startMode,
      ...(s.note && !state.note.trim() ? { note: s.note } : {}),
      edits: NO_EDITS,
    });
  }
  const suggestion = setup.suggestion ?? null;
  return (
    <div className="flex flex-col gap-5" data-testid="invite-covers">
      {suggestion ? (
        <div className="ds-card flex flex-col gap-2 p-4" data-testid="invite-suggestion">
          <span className="mz-agentline">Reggie suggests</span>
          <span className="text-sm text-ink">
            {coversLine(suggestion.covers)}. {suggestion.why}
          </span>
          <Button
            size="sm"
            className="self-start"
            onClick={() => patch({ covers: suggestion.covers, edits: NO_EDITS })}
            data-testid="invite-suggestion-use"
          >
            Use this
          </Button>
        </div>
      ) : null}
      <SheetSection label="Begin from a start">
        {starts.error ? (
          <ErrorNotice error={starts.error} onRetry={starts.reload} />
        ) : (
          <Select
            value={state.startId ?? ""}
            onChange={(e) => {
              const s = starts.data?.starts.find((x) => x.id === e.target.value);
              if (s) pickStart(s);
              else patch({ startId: null });
            }}
            data-testid="invite-start"
          >
            <option value="">None: choose below</option>
            {(starts.data?.starts ?? []).map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </Select>
        )}
      </SheetSection>
      <SheetSection label="What it covers">
        <CoversPicker
          value={state.covers}
          onChange={(covers) => patch({ covers, edits: NO_EDITS })}
          testId="invite-cover"
        />
      </SheetSection>
      <p className="m-0 text-sm text-ink-muted" data-testid="invite-covers-line">
        {coversAnything(state.covers)
          ? `The intake covers ${coversLine(state.covers)}.`
          : "Nothing ticked: just the account and the welcome email, no questions."}
      </p>
    </div>
  );
}

function QuestionsStep({
  state,
  patch,
  preview,
  labels,
  onLabel,
}: {
  state: InviteState;
  patch: Patch;
  preview: PreviewState;
  labels: Record<string, string>;
  onLabel(key: string, label: string): void;
}) {
  const e = state.edits;
  const setEdits = (p: Partial<Edits>) => patch({ edits: { ...e, ...p } });
  if (!coversAnything(state.covers)) {
    return (
      <p className="m-0 text-sm text-ink" data-testid="invite-questions-none">
        Just the account: no questions, the welcome email only. Go back to step 2 to add some.
      </p>
    );
  }
  const intake = preview.data?.intake ?? null;
  const field = {
    drop(f: GuideField) {
      if (f.origin === "operator") {
        setEdits({
          add: e.add.filter((a) => !(a.sectionKey === f.sectionKey && a.label === f.label)),
        });
        return;
      }
      onLabel(f.key, f.label);
      setEdits({ drop: [...e.drop, f.key], later: e.later.filter((k) => k !== f.key) });
    },
    later(f: GuideField, on: boolean) {
      setEdits({ later: on ? [...e.later, f.key] : e.later.filter((k) => k !== f.key) });
    },
    reword(f: GuideField, label: string) {
      setEdits({ reword: [...e.reword.filter((r) => r.key !== f.key), { key: f.key, label }] });
    },
  };
  return (
    <div className="flex flex-col gap-5" data-testid="invite-questions">
      <div className="flex flex-col gap-1">
        <p className="m-0 text-sm text-ink" data-testid="invite-totals">
          {intake ? `${capital(totalsLine(intake.totals))}.` : "Counting the questions…"}
        </p>
        <p className="m-0 text-xs text-ink-muted">
          Known answers aren't asked. "We think" lines are theirs to confirm. Only facts marked
          Theirs are used; our notes never are.
        </p>
      </div>
      <SheetSection label="How they start">
        <StartModePicker
          value={state.startMode}
          onChange={(startMode) => patch({ startMode })}
          testId="invite-mode"
        />
      </SheetSection>
      {preview.error && !intake ? <ErrorNotice error={preview.error} /> : null}
      {!intake && !preview.error ? <Loading /> : null}
      {intake?.guide.sections.map((s) => (
        <section key={s.key} className="ds-card" data-testid={`invite-section-${s.key}`}>
          <div className="ui-card__head">
            <h3 className="type-subheading text-ink">{s.title}</h3>
            <span className="text-xs text-ink-muted">{s.fields.length} questions</span>
          </div>
          <div className="ui-card__body flex flex-col gap-3">
            {s.intro ? <p className="m-0 text-sm text-ink-muted">{s.intro}</p> : null}
            <ul className="m-0 flex list-none flex-col gap-3 p-0">
              {s.fields.map((f) => (
                <FieldRow
                  key={f.key}
                  f={f}
                  laterOn={e.later.includes(f.key)}
                  onDrop={() => field.drop(f)}
                  onLater={(on) => field.later(f, on)}
                  onReword={(label) => field.reword(f, label)}
                />
              ))}
            </ul>
            <AddQuestion sectionKey={s.key} onAdd={(a) => setEdits({ add: [...e.add, a] })} />
          </div>
        </section>
      ))}
      {e.drop.length > 0 ? (
        <SheetSection label="Dropped">
          <ul className="m-0 flex list-none flex-col gap-1.5 p-0" data-testid="invite-dropped">
            {e.drop.map((key) => (
              <li key={key} className="flex flex-wrap items-center gap-2 text-sm text-ink-muted">
                <span className="line-through">{labels[key] ?? key}</span>
                <button
                  type="button"
                  className="ds-btn ds-btn--link"
                  onClick={() => setEdits({ drop: e.drop.filter((k) => k !== key) })}
                >
                  Put back
                </button>
              </li>
            ))}
          </ul>
        </SheetSection>
      ) : null}
    </div>
  );
}

const capital = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

function FieldRow({
  f,
  laterOn,
  onDrop,
  onLater,
  onReword,
}: {
  f: GuideField;
  laterOn: boolean;
  onDrop(): void;
  onLater(on: boolean): void;
  onReword(label: string): void;
}) {
  const [editing, setEditing] = useState(false);
  const [label, setLabel] = useState(f.label);
  const tone =
    f.state === "known"
      ? "ds-pill ds-pill--positive ds-pill--sm"
      : f.state === "to_confirm"
        ? "ds-pill ds-pill--neutral ds-pill--sm"
        : "ds-tag";
  return (
    <li
      className="flex flex-col gap-1.5 border-t border-line pt-3 first:border-t-0 first:pt-0"
      data-testid={`invite-field-${f.key}`}
    >
      {editing ? (
        <form
          className="flex flex-wrap items-center gap-2"
          onSubmit={(ev) => {
            ev.preventDefault();
            if (label.trim()) {
              onReword(label.trim());
              setEditing(false);
            }
          }}
        >
          <TextInput
            value={label}
            onChange={(ev) => setLabel(ev.target.value)}
            className="min-w-0 flex-1"
            aria-label="The question"
            data-testid={`invite-field-${f.key}-label`}
          />
          <Button type="submit" size="sm" variant="primary">
            Save
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>
            Cancel
          </Button>
        </form>
      ) : (
        <span className="text-sm text-ink">{f.label}</span>
      )}
      {f.weThink ? (
        <span className="text-sm text-ink-muted">
          {f.state === "known" ? "Known: " : "We think: "}
          {f.weThink.text}
        </span>
      ) : null}
      <div className="flex flex-wrap items-center gap-2 text-xs text-ink-muted">
        <span className={tone} data-testid={`invite-field-${f.key}-state`}>
          {FIELD_STATE_WORDS[f.state]}
        </span>
        <span className="ds-tag">{FIELD_KIND_WORDS[f.kind]}</span>
        {f.requiredToStart ? <span className="ds-tag">Needed to start</span> : null}
        {f.alsoIn.length > 0 ? (
          <span>Asked once for {plural(f.alsoIn.length + 1, "part")}</span>
        ) : null}
        <span className="ml-auto flex flex-wrap gap-3">
          {f.state === "known" ? null : (
            <>
              <button
                type="button"
                className="ds-btn ds-btn--link"
                onClick={() => setEditing(true)}
                data-testid={`invite-field-${f.key}-reword`}
              >
                Reword
              </button>
              <button
                type="button"
                className="ds-btn ds-btn--link"
                onClick={() => onLater(!laterOn)}
                data-testid={`invite-field-${f.key}-later`}
              >
                {laterOn ? "Ask now" : "Ask later"}
              </button>
            </>
          )}
          <button
            type="button"
            className="ds-btn ds-btn--link"
            onClick={onDrop}
            data-testid={`invite-field-${f.key}-drop`}
          >
            Drop
          </button>
        </span>
      </div>
    </li>
  );
}

function AddQuestion({
  sectionKey,
  onAdd,
}: {
  sectionKey: GuideSectionKey;
  onAdd(a: Edits["add"][number]): void;
}) {
  const [open, setOpen] = useState(false);
  const [label, setLabel] = useState("");
  const [kind, setKind] = useState<GuideFieldKind>("text");
  if (!open) {
    return (
      <Button
        size="sm"
        variant="ghost"
        className="self-start"
        onClick={() => setOpen(true)}
        data-testid={`invite-add-${sectionKey}`}
      >
        Add a question
      </Button>
    );
  }
  return (
    <form
      className="flex flex-wrap items-end gap-2"
      onSubmit={(ev) => {
        ev.preventDefault();
        if (!label.trim()) return;
        onAdd({ sectionKey, label: label.trim(), kind });
        setLabel("");
        setOpen(false);
      }}
    >
      <Field label="The question" className="min-w-0 flex-1">
        <TextInput
          value={label}
          onChange={(ev) => setLabel(ev.target.value)}
          data-testid={`invite-add-${sectionKey}-label`}
        />
      </Field>
      <Field label="Answer">
        <Select value={kind} onChange={(ev) => setKind(ev.target.value as GuideFieldKind)}>
          {GUIDE_FIELD_KINDS.filter((k) => k !== "choice" && k !== "choices" && k !== "tool").map(
            (k) => (
              <option key={k} value={k}>
                {FIELD_KIND_WORDS[k]}
              </option>
            ),
          )}
        </Select>
      </Field>
      <Button
        type="submit"
        size="sm"
        variant="primary"
        data-testid={`invite-add-${sectionKey}-save`}
      >
        Add
      </Button>
      <Button size="sm" variant="ghost" onClick={() => setOpen(false)}>
        Cancel
      </Button>
    </form>
  );
}

function EmailStep({
  state,
  patch,
  preview,
}: {
  state: InviteState;
  patch: Patch;
  preview: PreviewState;
}) {
  const [shown, setShown] = useState(0);
  const p = preview.data;
  const emails = p?.emails ?? [];
  const welcomeTab = emails.length;
  return (
    <div className="flex flex-col gap-5" data-testid="invite-email">
      <Field
        label="Your note"
        hint="It opens the email and their Getting started page. Written from you, in plain words."
      >
        <TextArea
          rows={5}
          value={state.note}
          maxLength={LEAD_NOTE_MAX}
          onChange={(e) => patch({ note: e.target.value })}
          data-testid="invite-note"
        />
      </Field>
      <div role="radiogroup" aria-label="When" className="flex flex-wrap items-start gap-3">
        <RadioChoice
          checked={state.sendAt === ""}
          onSelect={() => patch({ sendAt: "" })}
          testId="invite-when-now"
        >
          Send now
        </RadioChoice>
        <RadioChoice
          checked={state.sendAt !== ""}
          onSelect={() => patch({ sendAt: state.sendAt || tomorrowAtNine() })}
          testId="invite-when-later"
        >
          At a time
        </RadioChoice>
        {state.sendAt ? (
          <TextInput
            type="datetime-local"
            value={state.sendAt}
            onChange={(e) => patch({ sendAt: e.target.value })}
            className="w-56"
            aria-label="Send at"
            data-testid="invite-send-at"
          />
        ) : null}
      </div>
      <SheetSection label="As they'll see it">
        {preview.error && !p ? <ErrorNotice error={preview.error} /> : null}
        {!p && !preview.error ? <Loading /> : null}
        {p ? (
          <div className="flex flex-col gap-3">
            <div className="ds-tabs" role="tablist">
              {emails.map((m, i) => (
                <button
                  key={m.to}
                  type="button"
                  role="tab"
                  aria-selected={shown === i}
                  onClick={() => setShown(i)}
                  data-testid={`invite-preview-email-${i}`}
                >
                  Email to {m.to}
                </button>
              ))}
              <button
                type="button"
                role="tab"
                aria-selected={shown === welcomeTab}
                onClick={() => setShown(welcomeTab)}
                data-testid="invite-preview-welcome"
              >
                Welcome page
              </button>
            </div>
            {shown < welcomeTab && emails[shown] ? (
              <EmailPreview email={emails[shown]} />
            ) : (
              <WelcomePreview welcome={p.welcome} />
            )}
          </div>
        ) : null}
      </SheetSection>
    </div>
  );
}

function tomorrowAtNine(): string {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  d.setHours(9, 0, 0, 0);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T09:00`;
}

function EmailPreview({ email }: { email: InvitePreview["emails"][number] }) {
  return (
    <div className="flex flex-col gap-2" data-testid="invite-email-preview">
      <dl className="m-0 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
        <dt className="text-ink-muted">From</dt>
        <dd className="m-0 text-ink">{email.from}</dd>
        {email.replyTo ? (
          <>
            <dt className="text-ink-muted">Replies to</dt>
            <dd className="m-0 text-ink">{email.replyTo}</dd>
          </>
        ) : null}
        <dt className="text-ink-muted">To</dt>
        <dd className="m-0 text-ink">{email.to}</dd>
        <dt className="text-ink-muted">Subject</dt>
        <dd className="m-0 text-ink" data-testid="invite-email-subject">
          {email.subject}
        </dd>
      </dl>
      {/* The email's own HTML, in a frame with no scripts and nothing it can reach. */}
      <iframe
        title={`The email to ${email.to}`}
        sandbox=""
        srcDoc={email.html}
        className="h-[28rem] w-full rounded-sm border border-line bg-surface"
        data-testid="invite-email-html"
      />
    </div>
  );
}

function WelcomePreview({ welcome }: { welcome: InvitePreview["welcome"] }) {
  const s = welcome.summary;
  return (
    <div className="ds-card flex flex-col gap-3 p-4 text-sm" data-testid="invite-welcome-preview">
      <span className="eyebrow text-ink-muted">app.mezonas.com/start/…</span>
      <h3 className="type-subheading text-ink">{welcome.client}</h3>
      <span className="ds-pill ds-pill--person ds-pill--sm self-start">
        From {welcome.lead.name}
      </span>
      {welcome.note ? <p className="m-0 whitespace-pre-wrap text-ink">{welcome.note}</p> : null}
      {s ? (
        <p className="m-0 text-ink-muted">
          {listWords([
            ...(s.general ? ["the business"] : []),
            ...s.areas.map((a) => AREA_WORDS[a]),
            ...(s.agents > 0 ? [plural(s.agents, "agent")] : []),
          ])}
          {`; about ${plural(s.minutes, "minute")}`}
        </p>
      ) : (
        <p className="m-0 text-ink-muted">The account and the welcome email only.</p>
      )}
      {welcome.email ? (
        <p className="m-0 text-ink-muted">Sign-in is filled in with {welcome.email}.</p>
      ) : null}
      <p className="m-0 text-xs text-ink-muted">
        In {LOCALE_NAMES[welcome.language]}. The link works until {EN.fmt.day(welcome.expiresAt)}.
      </p>
    </div>
  );
}

function SendStep({
  problem,
  preview,
  error,
}: {
  problem: string | null;
  preview: PreviewState;
  error: unknown;
}) {
  const p = preview.data;
  if (problem) {
    return (
      <p className="m-0 text-sm text-ink" data-testid="invite-send-problem">
        {problem} Go back to step 1.
      </p>
    );
  }
  return (
    <div className="flex flex-col gap-5" data-testid="invite-confirm">
      {preview.error && !p ? <ErrorNotice error={preview.error} /> : null}
      {!p && !preview.error ? <Loading /> : null}
      {p ? (
        <>
          <SheetSection label="Sending this">
            <ul
              className="m-0 flex list-disc flex-col gap-1.5 pl-5 text-sm text-ink"
              data-testid="invite-confirm-lines"
            >
              {p.confirm.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          </SheetSection>
          {p.todos.length > 0 ? (
            <SheetSection label="Adds to Your call">
              <ul
                className="m-0 flex list-none flex-col gap-1 p-0 text-sm"
                data-testid="invite-todos"
              >
                {p.todos.map((t) => (
                  <li key={t.title} className="text-ink">
                    {t.title}
                    <span className="ml-2 text-xs text-ink-muted">due {t.dueOn}</span>
                  </li>
                ))}
              </ul>
            </SheetSection>
          ) : null}
          {p.problems.length > 0 ? (
            <div
              className="ds-banner flex flex-col gap-1 text-sm"
              role="alert"
              data-testid="invite-problems"
            >
              <b>It can't go yet.</b>
              {p.problems.map((x) => (
                <span key={`${x.code}:${x.email ?? ""}`}>{x.message}</span>
              ))}
            </div>
          ) : null}
        </>
      ) : null}
      {error ? <ErrorNotice error={error} /> : null}
    </div>
  );
}

function Sent({ sent, name }: { sent: InviteSent; name: string }) {
  const queued = sent.emails.filter((e) => e.status !== "skipped");
  return (
    <div className="flex flex-col gap-4 text-sm" data-testid="invite-sent">
      <p className="m-0 text-ink">
        {sent.emails.some((e) => e.status === "scheduled")
          ? `Done. The invite for ${name} is scheduled.`
          : `Done. ${queued.length === 1 ? "The invite is" : `${queued.length} invites are`} on the way.`}
      </p>
      <ul className="m-0 flex list-none flex-col gap-1 p-0">
        {sent.emails.map((e) => (
          <li key={e.to} className="text-ink-muted">
            {e.to}:{" "}
            {e.status === "queued"
              ? "sending"
              : e.status === "scheduled"
                ? "scheduled"
                : "not sent (no mailer here)"}
          </li>
        ))}
      </ul>
      <div className="flex flex-wrap gap-3">
        <Link to={OPS_PATHS.client(sent.clientId)} className="ds-btn ds-btn--secondary ds-btn--sm">
          Open {name}
        </Link>
        {sent.dealId ? (
          <Link to={OPS_PATHS.deal(sent.dealId)} className="ds-btn ds-btn--ghost ds-btn--sm">
            Open the deal
          </Link>
        ) : null}
      </div>
    </div>
  );
}
