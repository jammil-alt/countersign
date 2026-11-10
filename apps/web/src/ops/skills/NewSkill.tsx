// O8 New skill (`#O8-NewSkill` → `/ops/skills/new`; ARCHITECTURE §9.6 "Draft the new skill",
// §9.10): a Builder conversation of kind `skill`. The operator says what the skill should do and
// attaches examples; the Builder drafts the definition and turns the examples into test cases,
// each change undoable on its own. Save draft makes the skill (or its next version) as a draft
// with its cases; Run tests and Publish are on the skill's page, since tests run on a saved
// version. The conversation lives at `?session=<id>`, so a reload picks it up again.
// `?by=hand` keeps the form for writing a skill without the Builder.
import { BuilderExample, type BuilderTurnView, SkillDefinition } from "@countersign/core";
import { useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { z } from "zod";
import { apiRoutes } from "../../api/routes";
import { useApi } from "../../api/useApi";
import { useSession } from "../../session/session";
import { AgentBadge } from "../../ui/badges";
import { Columns, Page } from "../../ui/page";
import {
  Badge,
  Button,
  buttonClass,
  Card,
  cx,
  EmptyState,
  ErrorNotice,
  Loading,
  PageHeader,
  Tabs,
  Tag,
} from "../../ui/primitives";
import { errorText, Field, Notice, Select, TextArea, useAction } from "../agents/ui";
import { toolTitle } from "../builder/model";
import { SchemaCard } from "./parts";
import { SkillEditor } from "./SkillEditor";
import { SKILLS_PATH, skillPath } from "./SkillsLibrary";
import {
  categoryLabel,
  clean,
  definitionFromForm,
  EMPTY_FORM,
  type SkillForm,
  validateSkillForm,
} from "./skill-form";
import { shortValue } from "./TestsPanel";

/** The skill draft a skill conversation holds (`{definition, cases}`), read leniently. */
const DraftCase = z.object({
  key: z.string(),
  name: z.string(),
  input: z.unknown(),
  expected: z.unknown(),
  required: z.boolean().default(true),
});
const SkillDraft = z.object({
  definition: SkillDefinition.nullable().catch(null),
  cases: z.array(DraftCase).catch([]),
});
type SkillDraft = z.infer<typeof SkillDraft>;

function readDraft(bundle: unknown): SkillDraft {
  const parsed = SkillDraft.safeParse(bundle ?? {});
  return parsed.success ? parsed.data : { definition: null, cases: [] };
}

const Examples = z.array(BuilderExample).max(50);

export function NewSkillScreen() {
  const [params] = useSearchParams();
  const sessionId = params.get("session");
  if (params.get("by") === "hand") return <HandSkillForm />;
  if (sessionId) return <SkillConversation key={sessionId} sessionId={sessionId} />;
  return <StartConversation />;
}

function Breadcrumb() {
  return (
    <p className="mb-2 text-sm text-ink-muted">
      <Link to={SKILLS_PATH} className="hover:underline">
        Library · Skills
      </Link>{" "}
      / New skill
    </p>
  );
}

/** Before the first turn: who the skill is for, and what it should do. */
function StartConversation() {
  const session = useSession();
  const navigate = useNavigate();
  const clients = [...new Map(session.tenants.map((t) => [t.id, t])).values()];
  const [clientId, setClientId] = useState("");
  const action = useAction();

  async function send(text: string, examples: z.infer<typeof Examples> | undefined) {
    const started = await action.call(apiRoutes.opsStartBuilderSession, {
      body: { kind: "skill", ...(clientId ? { clientId } : {}) },
    });
    if (!started.ok) return false;
    const id = started.data.session.id;
    const turn = await action.call(apiRoutes.opsBuilderTurn, {
      params: { id },
      body: { text, ...(examples ? { examples } : {}) },
    });
    // The conversation exists either way; its page shows the turn or lets you try again.
    navigate(`/ops/skills/new?session=${id}`, { replace: true });
    return turn.ok;
  }

  return (
    <Page width="narrow" testId="new-skill">
      <div>
        <Breadcrumb />
        <PageHeader
          title="New skill"
          subtitle="Tell the Builder what the skill should do and give it real examples. It drafts the skill and its tests; you decide."
          actions={
            <Link
              to="/ops/skills/new?by=hand"
              className={buttonClass("ghost")}
              data-testid="new-skill-by-hand"
            >
              Write it by hand
            </Link>
          }
        />
      </div>
      <Card pad>
        <div className="flex flex-col gap-4">
          <Field
            label="Who can use it"
            hint="A client's own skill is used only by that client's agents, and its examples stay that client's tests."
          >
            <Select
              data-testid="new-skill-scope"
              value={clientId}
              onChange={(e) => setClientId(e.target.value)}
            >
              <option value="">Every agent (shared)</option>
              {clients.map((c) => (
                <option key={c.id} value={c.id}>
                  Only {c.name}'s agents
                </option>
              ))}
            </Select>
          </Field>
          <Composer busy={action.busy} onSend={send} />
          {action.error ? (
            <Notice tone="warning" testId="new-skill-error">
              {errorText(action.error)}
            </Notice>
          ) : null}
        </div>
      </Card>
    </Page>
  );
}

/** The message box: text, and examples as JSON when attached. */
function Composer({
  busy,
  disabled,
  onSend,
}: {
  busy: boolean;
  disabled?: boolean;
  onSend(text: string, examples: z.infer<typeof Examples> | undefined): Promise<boolean>;
}) {
  const [text, setText] = useState("");
  const [attaching, setAttaching] = useState(false);
  const [examplesText, setExamplesText] = useState("");
  const [examplesError, setExamplesError] = useState<string | null>(null);

  async function send() {
    let examples: z.infer<typeof Examples> | undefined;
    if (attaching && examplesText.trim()) {
      let raw: unknown;
      try {
        raw = JSON.parse(examplesText);
      } catch {
        setExamplesError("The examples aren't valid JSON.");
        return;
      }
      const parsed = Examples.safeParse(Array.isArray(raw) ? raw : [raw]);
      if (!parsed.success) {
        setExamplesError(
          "Each example needs an input, and may have a name and an expected answer.",
        );
        return;
      }
      examples = parsed.data;
    }
    setExamplesError(null);
    if (await onSend(text.trim(), examples)) {
      setText("");
      setExamplesText("");
      setAttaching(false);
    }
  }

  return (
    <div className="flex flex-col gap-3 rounded-md border border-line p-3">
      <TextArea
        aria-label="Message to the Builder"
        data-testid="builder-input"
        rows={3}
        maxLength={4000}
        placeholder="Describe what the skill should do, or drop examples"
        className="border-0 p-1"
        value={text}
        disabled={disabled}
        onChange={(e) => setText(e.target.value)}
      />
      {attaching ? (
        <Field
          label="Examples"
          hint='JSON: a list of { "name", "input", "expected" }. They become test cases.'
          error={examplesError ?? undefined}
        >
          <TextArea
            data-testid="builder-examples"
            rows={5}
            className="reference"
            value={examplesText}
            invalid={examplesError !== null}
            onChange={(e) => setExamplesText(e.target.value)}
          />
        </Field>
      ) : null}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Button
          size="sm"
          variant="ghost"
          data-testid="builder-attach"
          aria-pressed={attaching}
          disabled={disabled}
          onClick={() => setAttaching((a) => !a)}
        >
          {attaching ? "No examples" : "Attach examples"}
        </Button>
        <Button
          size="sm"
          variant="primary"
          data-testid="builder-send"
          disabled={disabled || busy || !text.trim()}
          onClick={() => void send()}
        >
          {busy ? "Sending…" : "Send"}
        </Button>
      </div>
    </div>
  );
}

const DRAFT_TABS = ["definition", "tests", "settings"] as const;
type DraftTab = (typeof DRAFT_TABS)[number];

function SkillConversation({ sessionId }: { sessionId: string }) {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const detail = useApi(apiRoutes.opsBuilderSession, { params: { id: sessionId } });
  const turn = useAction();
  const undo = useAction();
  const save = useAction();
  const tab: DraftTab = (DRAFT_TABS as readonly string[]).includes(params.get("tab") ?? "")
    ? (params.get("tab") as DraftTab)
    : "definition";

  if (detail.error) return <ErrorNotice error={detail.error} onRetry={detail.reload} />;
  if (!detail.data) return <Loading />;
  const { session, turns } = detail.data;
  const draft = readDraft(session.bundle);
  const def = draft.definition;
  const open = session.status === "open";
  const base = `/ops/skills/new?session=${session.id}`;

  async function send(text: string, examples: z.infer<typeof Examples> | undefined) {
    const res = await turn.call(apiRoutes.opsBuilderTurn, {
      params: { id: sessionId },
      body: { text, ...(examples ? { examples } : {}) },
    });
    detail.reload();
    return res.ok;
  }

  async function undoChange(turnId: string, changeId: string) {
    await undo.call(apiRoutes.opsBuilderUndo, {
      params: { id: sessionId },
      body: { turnId, changeId },
    });
    detail.reload();
  }

  async function saveDraft() {
    const res = await save.call(apiRoutes.opsBuilderSave, { params: { id: sessionId }, body: {} });
    if (res.ok && res.data.skill) navigate(`${skillPath(res.data.skill.id)}?tab=tests`);
    else detail.reload();
  }

  return (
    <Page testId="new-skill-conversation">
      <div>
        <Breadcrumb />
        <PageHeader
          title={
            <span className="reference">{def ? def.id.replace(/^custom:/, "") : "New skill"}</span>
          }
          badge={<Tag>{session.skillId ? "New draft" : "Draft v0"}</Tag>}
          subtitle={
            [def?.description, session.clientName ? `Only ${session.clientName}'s agents.` : null]
              .filter(Boolean)
              .join(" ") || "Nothing drafted yet."
          }
          actions={
            open ? (
              <Button
                variant="primary"
                data-testid="new-skill-save"
                disabled={!def || save.busy}
                onClick={saveDraft}
              >
                {save.busy ? "Saving…" : "Save draft"}
              </Button>
            ) : session.skillId ? (
              <Link to={skillPath(session.skillId)} className={buttonClass("primary")}>
                Open the skill
              </Link>
            ) : null
          }
        />
      </div>
      {save.error ? (
        <Notice tone="warning" testId="new-skill-save-error">
          {errorText(save.error)}
        </Notice>
      ) : null}
      <div className="flex flex-wrap items-start gap-6">
        <section
          aria-label="Builder conversation"
          className="ds-card flex min-w-0 flex-[1_1_380px] flex-col md:max-w-[500px]"
        >
          <div className="ui-card__head">
            <span className="flex items-center gap-2">
              <AgentBadge name="Builder" size="sm" />
              <h2 className="type-subheading text-ink">Builder</h2>
            </span>
            <span className="text-sm text-ink-muted">Drafts the skill and its tests</span>
          </div>
          <ol className="flex flex-col gap-5 px-6 py-5" data-testid="builder-turns">
            {turns.length === 0 ? (
              <li className="text-sm text-ink-muted">
                Say what the skill should do. Attach real examples to get tests with them.
              </li>
            ) : null}
            {turns.map((t) => (
              <Turn
                key={t.id}
                turn={t}
                busy={undo.busy || !open}
                onUndo={(changeId) => void undoChange(t.id, changeId)}
              />
            ))}
          </ol>
          {[turn.error, undo.error].map((e, i) =>
            e ? (
              // biome-ignore lint/suspicious/noArrayIndexKey: two fixed slots.
              <div key={i} className="px-6 pb-4">
                <Notice tone="warning" testId="builder-error">
                  {errorText(e)}
                </Notice>
              </div>
            ) : null,
          )}
          <div className="border-t border-line px-6 py-4">
            {open ? (
              <Composer busy={turn.busy} onSend={send} />
            ) : (
              <p className="text-sm text-ink-muted">
                This conversation is {session.status === "saved" ? "saved" : "closed"}.
              </p>
            )}
          </div>
        </section>

        <section
          aria-label="Skill draft"
          className="flex min-w-0 flex-[999_1_560px] flex-col gap-6"
        >
          <Tabs
            items={[
              { to: base, label: "Definition", active: tab === "definition" },
              {
                to: `${base}&tab=tests`,
                label: "Tests",
                count: draft.cases.length,
                active: tab === "tests",
              },
              {
                to: `${base}&tab=settings`,
                label: "Settings",
                count: def?.settings.length ?? 0,
                active: tab === "settings",
              },
            ]}
          />
          {session.errors.length > 0 ? (
            <Notice tone="warning" testId="new-skill-checks">
              Before it can publish: {session.errors.map((e) => e.message).join("; ")}
            </Notice>
          ) : null}
          {!def ? (
            <EmptyState>Nothing drafted yet. Tell the Builder what the skill should do.</EmptyState>
          ) : tab === "definition" ? (
            <>
              <Columns count={2}>
                <SchemaCard
                  title="Takes in"
                  schema={def.input}
                  badge={<Tag>{categoryLabel(def.category)}</Tag>}
                  testId="draft-takes-in"
                />
                <SchemaCard title="Gives back" schema={def.output} testId="draft-gives-back" />
              </Columns>
              <Card
                title="How it works"
                meta={
                  // Skill model (2026-11-10): the Builder drafts AI skills.
                  def.mode === "tool"
                    ? "Deterministic: rule rows, no model"
                    : `AI: instructions on ${def.model?.id ?? "the agent's model"}`
                }
                pad
              >
                <p
                  className="text-sm whitespace-pre-wrap text-ink"
                  data-testid="draft-instructions"
                >
                  {def.instructions ?? "No instructions."}
                </p>
              </Card>
              <p className="text-sm text-ink-muted">
                {def.tools.length === 0
                  ? "Tools it may use: none. It only reads what the step gives it."
                  : `Tools it may use: ${def.tools.map((id) => toolTitle({ id }).toLowerCase()).join(", ")}.`}
              </p>
            </>
          ) : tab === "tests" ? (
            <Card
              title="Tests"
              meta={`${draft.cases.length} drafted`}
              footer={
                <span className="text-sm text-ink-muted">
                  They run once the skill is saved. Tests use saved examples only and never touch a
                  client's tools.
                </span>
              }
            >
              {draft.cases.length === 0 ? (
                <p className="ui-card__body text-sm text-ink-muted">
                  No tests yet. Attach examples and the Builder adds them with expected answers.
                </p>
              ) : (
                <div className="dt dt-ana overflow-x-auto">
                  <table data-testid="draft-tests">
                    <thead>
                      <tr className="dt-cols">
                        <th>Case</th>
                        <th>Input</th>
                        <th>Expected</th>
                      </tr>
                    </thead>
                    <tbody>
                      {draft.cases.map((c) => (
                        <tr key={c.key}>
                          <td>
                            <span className="block text-ink">{c.name}</span>
                            {c.required ? (
                              <span className="block text-sm text-ink-muted">required</span>
                            ) : null}
                          </td>
                          <td className="reference text-ink-muted">{shortValue(c.input)}</td>
                          <td className="reference text-ink">{shortValue(c.expected)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </Card>
          ) : (
            <Card title="Settings" meta="Each agent can change these" pad>
              {def.settings.length === 0 ? (
                <p className="text-sm text-ink-muted">No settings.</p>
              ) : (
                <ul className="flex flex-col gap-2 text-sm" data-testid="draft-settings">
                  {def.settings.map((s) => (
                    <li key={s.key} className="flex flex-wrap items-baseline justify-between gap-3">
                      <span>
                        <span className="text-ink">{s.label}</span>{" "}
                        <span className="reference text-ink-muted">{s.key}</span>
                      </span>
                      <span className="text-ink-muted">
                        {shortValue(s.default)}
                        {s.clientSpecific ? " · per client" : ""}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          )}
        </section>
      </div>
    </Page>
  );
}

/** One turn: the operator's words, or the Builder's answer with its changes and questions. */
function Turn({
  turn: t,
  busy,
  onUndo,
}: {
  turn: BuilderTurnView;
  busy: boolean;
  onUndo(changeId: string): void;
}) {
  if (t.role === "operator") {
    return (
      <li
        data-testid={`builder-turn-${t.seq}`}
        className="ml-8 rounded-md bg-surface-subtle px-4 py-3 text-sm whitespace-pre-wrap text-ink"
      >
        {t.text}
      </li>
    );
  }
  return (
    <li data-testid={`builder-turn-${t.seq}`} className="flex gap-3">
      <AgentBadge name="Builder" size="sm" />
      <div className="flex min-w-0 flex-1 flex-col gap-2 text-sm text-ink">
        <p className="whitespace-pre-wrap">{t.text}</p>
        {t.changes.map((c) => (
          <div
            key={c.id}
            className="flex items-center justify-between gap-3 rounded-sm border border-line px-3 py-2"
          >
            <span className={cx("min-w-0", c.undone && "text-ink-muted line-through")}>
              <span className="text-positive">+ </span>
              {c.label}
            </span>
            {c.undoes ? null : c.undone ? (
              <span className="text-ink-muted">Undone</span>
            ) : (
              <Button
                size="sm"
                variant="link"
                disabled={busy}
                data-testid={`builder-undo-${c.id}`}
                onClick={() => onUndo(c.id)}
              >
                Undo
              </Button>
            )}
          </div>
        ))}
        {t.questions.length > 0 ? (
          <ol className="list-decimal pl-5">
            {t.questions.map((q) => (
              <li key={q}>{q}</li>
            ))}
          </ol>
        ) : null}
        {t.gaps.length > 0 ? <p className="text-ink-muted">Missing: {t.gaps.join("; ")}</p> : null}
        {t.errors.length > 0 ? (
          <Badge tone="risk">
            {t.errors.length} {t.errors.length === 1 ? "problem" : "problems"} to fix
          </Badge>
        ) : null}
      </div>
    </li>
  );
}

/** Writing a skill without the Builder: the editor, then Save draft. */
function HandSkillForm() {
  const navigate = useNavigate();
  const session = useSession();
  const library = useApi(apiRoutes.opsSkills);
  const [form, setForm] = useState<SkillForm>(EMPTY_FORM);
  const [clientId, setClientId] = useState("");
  const [touched, setTouched] = useState(false);
  const action = useAction();
  const errors = validateSkillForm(form);
  const clients = [...new Map(session.tenants.map((t) => [t.id, t])).values()];

  async function create() {
    setTouched(true);
    if (Object.keys(errors).length > 0 || !library.data) return;
    const res = await action.call(apiRoutes.opsCreateSkill, {
      body: {
        definition: clean(definitionFromForm(form, library.data.tools)),
        ...(clientId ? { clientId } : {}),
        changeNote: "Created",
      },
    });
    if (res.ok) navigate(skillPath(res.data.skill.id));
  }

  if (library.error) return <ErrorNotice error={library.error} onRetry={library.reload} />;
  if (!library.data) return <Loading />;
  return (
    <Page testId="new-skill-by-hand">
      <div>
        <Breadcrumb />
        <PageHeader
          title="New skill"
          subtitle="Written by hand. It starts as a draft; publish it to let agents use it."
          actions={
            <Link to="/ops/skills/new" className={buttonClass("ghost")}>
              Use the Builder
            </Link>
          }
        />
      </div>
      <div className="flex flex-wrap items-start gap-6">
        <div className="min-w-0 flex-[999_1_560px]">
          <SkillEditor
            form={form}
            errors={touched ? errors : {}}
            tools={library.data.tools}
            connectors={library.data.connectors}
            slugLocked={false}
            onChange={setForm}
          />
        </div>
        <div className="flex min-w-0 flex-[1_1_300px] flex-col gap-4">
          <Card title="Who can use it" pad>
            <Field
              label="Agents"
              hint="A client's own skill is used only by that client's agents and never shared."
            >
              <Select
                data-testid="skill-scope-select"
                value={clientId}
                onChange={(e) => setClientId(e.target.value)}
              >
                <option value="">Every agent (shared)</option>
                {clients.map((c) => (
                  <option key={c.id} value={c.id}>
                    Only {c.name}'s agents
                  </option>
                ))}
              </Select>
            </Field>
          </Card>
          {touched && Object.keys(errors).length > 0 ? (
            <Notice tone="warning" testId="skill-form-errors">
              Some fields need a look before it can be saved.
            </Notice>
          ) : null}
          {action.error ? (
            <Notice tone="warning" testId="skill-create-error">
              {errorText(action.error)}
            </Notice>
          ) : null}
          <div className="flex justify-end gap-3">
            <Link to={SKILLS_PATH} className={buttonClass("ghost")}>
              Cancel
            </Link>
            <Button
              variant="primary"
              data-testid="skill-create"
              disabled={action.busy}
              onClick={create}
            >
              {action.busy ? "Saving…" : "Save draft"}
            </Button>
          </div>
        </div>
      </div>
    </Page>
  );
}
