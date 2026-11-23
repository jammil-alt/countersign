// What one client person can do (docs/plan.md §1.122): their role, whether they approve changes,
// and which of the client's agents they work on (all, or only some). Shared by the portal's Team
// screen (the client admin) and the invite form. A client admin always approves and works on every
// agent, so those choices show only for a user. Words come from the portal's message files.
import type { AssignableAgent, InvitableRole } from "@countersign/core";
import { useState } from "react";
import { isApiError } from "../api/client";
import { useI18n } from "../i18n/i18n";
import { Field, Select } from "../ui/forms";
import { Button, Card } from "../ui/primitives";
import { type AccessChoice, accessReady } from "./access-core";

/** The design system's checkbox: a button with role=checkbox. */
function Check({
  checked,
  disabled,
  onToggle,
  testId,
  children,
}: {
  checked: boolean;
  disabled?: boolean;
  onToggle: () => void;
  testId: string;
  children: React.ReactNode;
}) {
  return (
    // biome-ignore lint/a11y/useSemanticElements: the design system's Checkbox is a button with role=checkbox.
    <button
      type="button"
      role="checkbox"
      aria-checked={checked}
      disabled={disabled}
      data-testid={testId}
      onClick={onToggle}
      className="ds-choice disabled:opacity-60"
    >
      <span className="ds-check">{checked ? "✓" : ""}</span>
      {children}
    </button>
  );
}

/** The design system's radio: a button with role=radio. */
function Radio({
  checked,
  onPick,
  testId,
  children,
}: {
  checked: boolean;
  onPick: () => void;
  testId: string;
  children: React.ReactNode;
}) {
  return (
    // biome-ignore lint/a11y/useSemanticElements: the design system's Radio is a button with role=radio.
    <button
      type="button"
      role="radio"
      aria-checked={checked}
      data-testid={testId}
      onClick={onPick}
      className="ds-choice"
    >
      <span className="ds-radio" />
      {children}
    </button>
  );
}

/**
 * Approves, and which agents: the parts of a person's access below their role. Controlled; a
 * client admin sees a line saying they approve and work on every agent.
 */
export function AccessFields({
  value,
  onChange,
  agents,
  testId,
  showRole = true,
}: {
  value: AccessChoice;
  onChange: (next: AccessChoice) => void;
  agents: readonly AssignableAgent[];
  testId: string;
  showRole?: boolean;
}) {
  const { t } = useI18n();
  const admin = value.role === "client_admin";
  const some = value.agentIds !== null;
  const picked = new Set(value.agentIds ?? []);
  return (
    <div className="flex flex-col gap-3">
      {showRole ? (
        <Field label={t("people.role")} className="w-48">
          <Select
            data-testid={`${testId}-role`}
            value={value.role}
            onChange={(e) => {
              const role = e.target.value as InvitableRole;
              // DECISION (QA PP3): a switch to user starts from the narrow choice, approvals off
              // and agents to pick, never an admin's "every agent, approves changes". The server
              // refuses an admin made a user without both.
              onChange(
                role === "client_admin"
                  ? { role, canSign: true, agentIds: null }
                  : value.role === "client_admin"
                    ? { role, canSign: false, agentIds: [] }
                    : { ...value, role },
              );
            }}
          >
            <option value="client_user">{t("people.role.client_user")}</option>
            <option value="client_admin">{t("people.role.client_admin")}</option>
          </Select>
        </Field>
      ) : null}
      {admin ? (
        <p className="text-sm text-ink-muted" data-testid={`${testId}-admin`}>
          {t("access.adminSeesAll")}
        </p>
      ) : (
        <>
          <div className="flex flex-col gap-1">
            <Check
              checked={value.canSign}
              onToggle={() => onChange({ ...value, canSign: !value.canSign })}
              testId={`${testId}-can-sign`}
            >
              {t("access.canSign")}
            </Check>
            <p className="text-sm text-ink-muted">{t("access.canSignHelp")}</p>
          </div>
          <fieldset className="flex flex-col gap-2">
            <legend className="mb-1 text-sm font-medium text-ink">{t("access.agents")}</legend>
            <div role="radiogroup" aria-label={t("access.agents")} className="flex flex-col gap-2">
              <Radio
                checked={!some}
                onPick={() => onChange({ ...value, agentIds: null })}
                testId={`${testId}-all`}
              >
                {t("access.allAgents")}
              </Radio>
              <Radio
                checked={some}
                onPick={() => onChange({ ...value, agentIds: value.agentIds ?? [] })}
                testId={`${testId}-some`}
              >
                {t("access.someAgents")}
              </Radio>
            </div>
            {some ? (
              agents.length === 0 ? (
                <p className="pl-6 text-sm text-ink-muted">{t("access.noAgents")}</p>
              ) : (
                <ul className="flex flex-col gap-1.5 pl-6" data-testid={`${testId}-agents`}>
                  {agents.map((a) => (
                    <li key={a.id}>
                      <Check
                        checked={picked.has(a.id)}
                        onToggle={() => {
                          const next = new Set(picked);
                          if (next.has(a.id)) next.delete(a.id);
                          else next.add(a.id);
                          onChange({
                            ...value,
                            agentIds: agents.map((x) => x.id).filter((id) => next.has(id)),
                          });
                        }}
                        testId={`${testId}-agent-${a.id}`}
                      >
                        {a.name}
                      </Check>
                    </li>
                  ))}
                </ul>
              )
            ) : null}
          </fieldset>
        </>
      )}
    </div>
  );
}

/** A person's access, changed in place: the fields, Save and Cancel. */
export function AccessEditor({
  name,
  initial,
  agents,
  onSave,
  onDone,
  testId,
}: {
  name: string;
  initial: AccessChoice;
  agents: readonly AssignableAgent[];
  onSave: (value: AccessChoice) => Promise<void>;
  onDone: () => void;
  testId: string;
}) {
  const { t } = useI18n();
  const [value, setValue] = useState<AccessChoice>(initial);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const ready = accessReady(value);
  return (
    <Card className="p-5" testId={testId}>
      <h3 className="mb-3 font-medium text-ink">{t("access.title", { name })}</h3>
      <AccessFields value={value} onChange={setValue} agents={agents} testId={testId} />
      {!ready ? <p className="mt-2 text-sm text-ink-muted">{t("access.pickOne")}</p> : null}
      {problem ? (
        <p role="alert" className="mt-2 text-sm text-risk" data-testid={`${testId}-problem`}>
          {problem}
        </p>
      ) : null}
      <div className="mt-4 flex flex-wrap gap-2">
        <Button
          variant="primary"
          size="sm"
          disabled={busy || !ready}
          data-testid={`${testId}-save`}
          onClick={() => {
            setBusy(true);
            setProblem(null);
            onSave(value)
              .then(onDone)
              .catch((error: unknown) =>
                setProblem(
                  isApiError(error) && error.code === "last_admin"
                    ? t("access.problem.lastAdmin")
                    : t("access.problem"),
                ),
              )
              .finally(() => setBusy(false));
          }}
        >
          {t("access.save")}
        </Button>
        <Button variant="ghost" size="sm" data-testid={`${testId}-cancel`} onClick={onDone}>
          {t("access.cancel")}
        </Button>
      </div>
    </Card>
  );
}
