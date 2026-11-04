// An agent's people and channels (plan §1.25). People: each role the agent's version declares,
// bound to contacts of the client, with the conditions for reaching them (which channels, urgent
// outside hours, how often, escalation, an "only if" rule). The operator edits them on the agent
// page and the client admin in the portal's People page; every change is logged with who made it.
// Channels: the agent's email, texting, WhatsApp and calling channels, each bound to a connection,
// the operator's alone. Consent and opt-outs stay on the contact: nothing here overrides them.
// The people part reads in the reader's language (docs/plan.md §1.18; English in the back office);
// role names, their descriptions and contacts' names are data and stay as written. Channels are
// the back office's alone and stay English.
import {
  type AgentChannels,
  type AgentPeople,
  type PeopleBindingInput,
  type PersonRole,
  REACH_CHANNELS,
  type ReachChannel,
  type ReachConditionsInput,
  RuleOp,
} from "@countersign/core";
import { useState } from "react";
import { isApiError } from "../api/client";
import { apiRoutes } from "../api/routes";
import { useApi, useApiClient } from "../api/useApi";
import type { PlainKey } from "../i18n/catalog";
import { errorText as apiErrorText } from "../i18n/errors";
import { type I18n, useI18n } from "../i18n/i18n";
import { Field, Select, TextInput } from "../ui/forms";
import {
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorNotice,
  Loading,
  SectionLabel,
} from "../ui/primitives";

export const CHANNEL_LABEL: Record<ReachChannel, string> = {
  email: "Email",
  sms: "Text",
  whatsapp: "WhatsApp",
  voice: "Call",
};

const CHANNEL_KEY: Record<ReachChannel, PlainKey> = {
  email: "reach.channel.email",
  sms: "reach.channel.sms",
  whatsapp: "reach.channel.whatsapp",
  voice: "reach.channel.voice",
};

function errorText(error: unknown, fallback: string): string {
  return isApiError(error) ? error.message : fallback;
}

function problemText(error: unknown, i18n: I18n): string {
  return isApiError(error) ? apiErrorText(error, i18n) : i18n.t("reach.problem.notSaved");
}

// "No reply in this long" is stored as the platform's duration ("2 hours", core's `Duration`);
// people enter a number and pick a unit in their own language.
// DECISION: the unit is a choice of minutes, hours or days; a stored week reads as days and a
// stored second count as whole minutes, so every language edits it without typing English units.
const ESCALATE_UNITS = ["minute", "hour", "day"] as const;
type EscalateUnit = (typeof ESCALATE_UNITS)[number];
const UNIT_KEY: Record<EscalateUnit, PlainKey> = {
  minute: "reach.unit.minute",
  hour: "reach.unit.hour",
  day: "reach.unit.day",
};

function parseEscalate(value: string | undefined): { n: number; unit: EscalateUnit } | null {
  const m = /^(\d+)\s*(second|minute|hour|day|week)s?$/.exec(value?.trim() ?? "");
  if (!m) return null;
  const n = Number(m[1]);
  switch (m[2]) {
    case "second":
      return { n: Math.max(1, Math.ceil(n / 60)), unit: "minute" };
    case "week":
      return { n: n * 7, unit: "day" };
    default:
      return { n, unit: m[2] as EscalateUnit };
  }
}

function escalateDuration(n: number, unit: EscalateUnit): string {
  return `${n} ${unit}${n === 1 ? "" : "s"}`;
}

function EscalateField({
  value,
  testId,
  onChange,
}: {
  value: string | undefined;
  testId: string;
  onChange(next: string | undefined): void;
}) {
  const { t } = useI18n();
  const parsed = parseEscalate(value);
  const [unitChoice, setUnitChoice] = useState<EscalateUnit>(parsed?.unit ?? "hour");
  const unit = parsed?.unit ?? unitChoice;
  return (
    <Field label={t("reach.escalate")} hint={t("reach.escalateHint")}>
      <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)] gap-2">
        <TextInput
          type="number"
          min={1}
          value={parsed?.n ?? ""}
          placeholder="2"
          onChange={(e) => {
            const n = Number.parseInt(e.target.value, 10);
            onChange(Number.isFinite(n) && n > 0 ? escalateDuration(n, unit) : undefined);
          }}
          data-testid={testId}
        />
        <Select
          value={unit}
          aria-label={t("reach.escalateUnit")}
          onChange={(e) => {
            const next = e.target.value as EscalateUnit;
            setUnitChoice(next);
            if (parsed) onChange(escalateDuration(parsed.n, next));
          }}
          data-testid={`${testId}-unit`}
        >
          {ESCALATE_UNITS.map((u) => (
            <option key={u} value={u}>
              {t(UNIT_KEY[u])}
            </option>
          ))}
        </Select>
      </div>
    </Field>
  );
}

/** One role: who is bound and the conditions, edited in place. */
function RoleEditor({
  role,
  binding,
  contacts,
  onChange,
}: {
  role: PersonRole;
  binding: PeopleBindingInput | undefined;
  contacts: AgentPeople["contacts"];
  onChange(next: PeopleBindingInput): void;
}) {
  const { t } = useI18n();
  const ids = binding?.contactIds ?? [];
  const cond: ReachConditionsInput = binding?.conditions ?? {};
  const set = (patch: Partial<ReachConditionsInput>) => {
    const next: ReachConditionsInput = { ...cond, ...patch };
    for (const k of Object.keys(next) as (keyof ReachConditionsInput)[]) {
      if (next[k] === undefined) delete next[k];
    }
    onChange({ contactIds: ids, conditions: next });
  };
  const allowed = cond.channels ?? role.channels ?? [...REACH_CHANNELS];
  const rule = cond.onlyIf?.rules[0];
  const testId = `role-${role.role}`;

  return (
    <Card className="p-4" testId={testId}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium text-ink">{role.role}</span>
        {role.required ? (
          <Badge tone={ids.length ? "neutral" : "warning"} testId={`${testId}-required`}>
            {ids.length ? t("reach.required") : t("reach.requiredNobody")}
          </Badge>
        ) : null}
      </div>
      {role.description ? <p className="mt-1 text-sm text-ink-muted">{role.description}</p> : null}

      <div className="mt-3">
        <SectionLabel>{t("reach.who")}</SectionLabel>
        {contacts.length === 0 ? (
          <p className="text-sm text-ink-muted">{t("reach.noContacts")}</p>
        ) : (
          <ul className="flex flex-col gap-1">
            {contacts.map((c) => (
              <li key={c.id}>
                <label className="flex items-center gap-2 text-sm text-ink">
                  <input
                    type="checkbox"
                    checked={ids.includes(c.id)}
                    onChange={(e) =>
                      onChange({
                        contactIds: e.target.checked
                          ? [...ids, c.id]
                          : ids.filter((x) => x !== c.id),
                        conditions: cond,
                      })
                    }
                    data-testid={`${testId}-contact-${c.id}`}
                  />
                  {c.name}
                  {c.optedOut ? <Badge>{t("reach.optedOut")}</Badge> : null}
                  {c.roles.includes(role.role) ? <Badge tone="accent">{role.role}</Badge> : null}
                  <span className="text-ink-muted">
                    {c.reachable.map((ch) => t(CHANNEL_KEY[ch])).join(", ") || t("reach.noConsent")}
                  </span>
                </label>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div>
          <SectionLabel>{t("reach.channels")}</SectionLabel>
          <div className="flex flex-wrap gap-3">
            {(role.channels ?? REACH_CHANNELS).map((ch) => (
              <label key={ch} className="flex items-center gap-1.5 text-sm text-ink">
                <input
                  type="checkbox"
                  checked={allowed.includes(ch)}
                  onChange={(e) =>
                    set({
                      channels: e.target.checked
                        ? [...allowed, ch]
                        : allowed.filter((x) => x !== ch),
                    })
                  }
                  data-testid={`${testId}-channel-${ch}`}
                />
                {t(CHANNEL_KEY[ch])}
              </label>
            ))}
          </div>
          <label className="mt-2 flex items-center gap-1.5 text-sm text-ink">
            <input
              type="checkbox"
              checked={cond.urgentOutsideHours === true}
              onChange={(e) => set({ urgentOutsideHours: e.target.checked || undefined })}
              data-testid={`${testId}-urgent-hours`}
            />
            {t("reach.urgent")}
          </label>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Field label={t("reach.maxPerDay")}>
            <TextInput
              type="number"
              min={1}
              max={20}
              value={cond.maxPerDay ?? ""}
              placeholder="3"
              onChange={(e) =>
                set({ maxPerDay: e.target.value ? Number(e.target.value) : undefined })
              }
              data-testid={`${testId}-max`}
            />
          </Field>
          <EscalateField
            value={cond.escalateAfter}
            testId={`${testId}-escalate`}
            onChange={(escalateAfter) => set({ escalateAfter })}
          />
        </div>
      </div>

      <div className="mt-3">
        <SectionLabel>{t("reach.onlyIf")}</SectionLabel>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-[1fr_120px_1fr]">
          <TextInput
            value={rule?.field ?? ""}
            placeholder="{{trigger.total}}"
            aria-label={t("reach.field")}
            onChange={(e) =>
              set({
                onlyIf: e.target.value
                  ? {
                      match: "all",
                      rules: [{ field: e.target.value, op: rule?.op ?? ">", value: rule?.value }],
                    }
                  : undefined,
              })
            }
            data-testid={`${testId}-only-field`}
          />
          <Select
            value={rule?.op ?? ">"}
            aria-label={t("reach.comparison")}
            disabled={!rule}
            onChange={(e) =>
              rule &&
              set({
                onlyIf: {
                  match: "all",
                  rules: [{ ...rule, op: e.target.value as RuleOp }],
                },
              })
            }
          >
            {RuleOp.options.map((op) => (
              <option key={op} value={op}>
                {op}
              </option>
            ))}
          </Select>
          <TextInput
            value={rule?.value === undefined ? "" : String(rule.value)}
            placeholder="500"
            aria-label={t("reach.value")}
            disabled={!rule}
            onChange={(e) =>
              rule &&
              set({
                onlyIf: {
                  match: "all",
                  rules: [
                    {
                      ...rule,
                      value:
                        e.target.value !== "" && !Number.isNaN(Number(e.target.value))
                          ? Number(e.target.value)
                          : e.target.value,
                    },
                  ],
                },
              })
            }
          />
        </div>
      </div>
    </Card>
  );
}

/** One agent's roles, with a save. */
export function AgentPeopleEditor({
  people,
  save,
}: {
  people: AgentPeople;
  save(next: Record<string, PeopleBindingInput>): Promise<AgentPeople>;
}) {
  const i18n = useI18n();
  const { t } = i18n;
  const [draft, setDraft] = useState<Record<string, PeopleBindingInput>>(people.people);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [missing, setMissing] = useState(people.missing);

  if (people.roles.length === 0) {
    return <EmptyState>{t("reach.noRoles")}</EmptyState>;
  }
  return (
    <div className="flex flex-col gap-3" data-testid={`people-${people.agentId}`}>
      {people.roles.map((role) => (
        <RoleEditor
          key={role.role}
          role={role}
          binding={draft[role.role]}
          contacts={people.contacts}
          onChange={(next) => {
            setSaved(false);
            setDraft({ ...draft, [role.role]: next });
          }}
        />
      ))}
      {missing.length ? (
        <p className="text-sm text-ink" data-testid="people-missing">
          <Badge tone="warning">{t("common.waitingOnYou")}</Badge>{" "}
          {t("reach.missing", { roles: missing.join(", ") })}
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="ds-error text-sm">
          {error}
        </p>
      ) : null}
      <div className="flex items-center gap-3">
        <Button
          variant="primary"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            setError(null);
            try {
              const next = await save(draft);
              setMissing(next.missing);
              setSaved(true);
            } catch (e) {
              setError(problemText(e, i18n));
            } finally {
              setBusy(false);
            }
          }}
          data-testid={`people-${people.agentId}-save`}
        >
          {t("reach.save")}
        </Button>
        {saved ? <span className="text-sm text-ink-muted">{t("reach.saved")}</span> : null}
      </div>
    </div>
  );
}

/** The back office's People section on a client agent's page. */
export function OpsPeopleSection({ agentId }: { agentId: string }) {
  const api = useApiClient();
  const { data, error, reload } = useApi(apiRoutes.opsAgentPeople, { params: { id: agentId } });
  if (error) return <ErrorNotice error={error} onRetry={reload} />;
  if (!data) return <Loading />;
  return (
    <AgentPeopleEditor
      key={JSON.stringify(data.people.people)}
      people={data.people}
      save={async (people) =>
        (
          await api.call(apiRoutes.opsSetAgentPeople, {
            params: { id: agentId },
            body: { people },
          })
        ).people
      }
    />
  );
}

/** The operator's Channels section: each channel bound to a connection that can carry it. */
export function OpsChannelsSection({ agentId }: { agentId: string }) {
  const api = useApiClient();
  const { data, error, reload } = useApi(apiRoutes.opsAgentChannels, { params: { id: agentId } });
  if (error) return <ErrorNotice error={error} onRetry={reload} />;
  if (!data) return <Loading />;
  return (
    <ChannelsEditor
      key={JSON.stringify(data.channels.channels)}
      channels={data.channels}
      save={async (channels) =>
        (
          await api.call(apiRoutes.opsSetAgentChannels, {
            params: { id: agentId },
            body: { channels },
          })
        ).channels
      }
    />
  );
}

function ChannelsEditor({
  channels,
  save,
}: {
  channels: AgentChannels;
  save(next: AgentChannels["channels"]): Promise<AgentChannels>;
}) {
  const [draft, setDraft] = useState(channels.channels);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  return (
    <Card className="p-5" testId="agent-channels">
      <SectionLabel>Channels</SectionLabel>
      <p className="mb-3 text-sm text-ink-muted">
        How this agent reaches people. It sends only through channels bound here.
      </p>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        {REACH_CHANNELS.map((ch) => {
          const options = channels.options.filter((o) => o.channels.includes(ch));
          return (
            <Field key={ch} label={CHANNEL_LABEL[ch]}>
              <Select
                value={draft[ch] ?? ""}
                onChange={(e) => {
                  setSaved(false);
                  const next = { ...draft };
                  if (e.target.value) next[ch] = e.target.value;
                  else delete next[ch];
                  setDraft(next);
                }}
                data-testid={`agent-channel-${ch}`}
              >
                <option value="">
                  {options.length ? "Not bound" : "No connection can carry it"}
                </option>
                {options.map((o) => (
                  <option key={o.connectionId} value={o.connectionId}>
                    {o.label}
                    {o.status === "connected" ? "" : ` (${o.status})`}
                  </option>
                ))}
              </Select>
            </Field>
          );
        })}
      </div>
      {error ? (
        <p role="alert" className="ds-error mt-3 text-sm">
          {error}
        </p>
      ) : null}
      <div className="mt-3 flex items-center gap-3">
        <Button
          variant="primary"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            setError(null);
            try {
              setDraft((await save(draft)).channels);
              setSaved(true);
            } catch (e) {
              setError(errorText(e, "That didn't save. Try again."));
            } finally {
              setBusy(false);
            }
          }}
          data-testid="agent-channels-save"
        >
          Save channels
        </Button>
        {saved ? <span className="text-sm text-ink-muted">Saved.</span> : null}
      </div>
    </Card>
  );
}

/** The portal's People page (client admin): each of your agents' roles. */
export function PortalPeopleList() {
  const { t } = useI18n();
  const api = useApiClient();
  const { data, error, reload } = useApi(apiRoutes.portalAgentPeople, {});
  if (error) return <ErrorNotice error={error} onRetry={reload} />;
  if (!data) return <Loading />;
  if (data.items.length === 0) {
    return <EmptyState>{t("reach.none")}</EmptyState>;
  }
  return (
    <div className="flex flex-col gap-8">
      {data.items.map((item) => (
        <section key={item.agentId}>
          <h2 className="mb-3 type-subheading text-ink">{item.agentName}</h2>
          <AgentPeopleEditor
            people={item}
            save={async (people) =>
              (
                await api.call(apiRoutes.portalSetAgentPeople, {
                  params: { id: item.agentId },
                  body: { people },
                })
              ).people
            }
          />
        </section>
      ))}
    </div>
  );
}
