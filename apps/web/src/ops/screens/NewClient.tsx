// `/ops/clients/new`: onboarding a client (ARCHITECTURE §15): its name, timezone and language, the tools it
// is offered, who approves changes to its tools, its admin, invited in the same step, and the
// supervisor (docs/plan.md §1.28), offered by default. Then the client's settings page, which says
// what became of the invitation email.
import {
  type ExternalApprover,
  type InviteResult,
  LOCALE_NAMES,
  LOCALES,
  type Locale,
  parseLocale,
} from "@countersign/core";
import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { isApiError } from "../../api/client";
import { apiRoutes } from "../../api/routes";
import { useApi, useApiClient } from "../../api/useApi";
import { inviteProblem } from "../../people/People";
import { useSessionState } from "../../session/session";
import { Field, Select, TextInput } from "../../ui/forms";
import {
  Button,
  buttonClass,
  Card,
  cx,
  ErrorNotice,
  Loading,
  PageHeader,
  SectionLabel,
} from "../../ui/primitives";

/** What the settings page shows after onboarding. */
export interface CreatedState {
  created: { name: string; admin: InviteResult | null };
}

function browserTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

function timezones(): string[] {
  try {
    return (
      (Intl as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf?.("timeZone") ??
      []
    );
  } catch {
    return [];
  }
}

export const APPROVER_OPTIONS: [ExternalApprover, string, string][] = [
  [
    "client_admin",
    "Their admin approves",
    "Changes to the client's tools wait for their admin. This is the default.",
  ],
  [
    "operator",
    "We approve on their behalf",
    "Changes wait for us instead. Use it when the client asks us to handle approvals.",
  ],
];

export function ApproverChoice({
  value,
  onChange,
  name,
}: {
  value: ExternalApprover;
  onChange(next: ExternalApprover): void;
  name: string;
}) {
  return (
    <div className="flex flex-col gap-2" role="radiogroup">
      {APPROVER_OPTIONS.map(([id, title, text]) => (
        <label
          key={id}
          className={cx(
            "flex cursor-pointer items-start gap-3 rounded-md border px-4 py-3",
            value === id
              ? "border-slate bg-slate-tint"
              : "border-line bg-surface hover:bg-surface-subtle",
          )}
        >
          <input
            type="radio"
            name={name}
            className="mt-1 size-4 accent-slate"
            data-testid={`${name}-${id}`}
            checked={value === id}
            onChange={() => onChange(id)}
          />
          <span className="min-w-0">
            <span className="block font-medium text-ink">{title}</span>
            <span className="block text-sm text-ink-muted">{text}</span>
          </span>
        </label>
      ))}
    </div>
  );
}

export function NewClientScreen() {
  const client = useApiClient();
  const { refresh } = useSessionState();
  const navigate = useNavigate();
  const connectors = useApi(apiRoutes.connectors);
  const [name, setName] = useState("");
  const [timezone, setTimezone] = useState(browserTimezone);
  // DECISION: English unless the operator picks another; the client admin can change it later.
  const [language, setLanguage] = useState<Locale>("en");
  const [offered, setOffered] = useState<string[]>([]);
  const [approvals, setApprovals] = useState<ExternalApprover>("client_admin");
  const [adminEmail, setAdminEmail] = useState("");
  const [adminName, setAdminName] = useState("");
  // DECISION: onboarding offers the supervisor ticked; it arrives as a draft to test and activate.
  const [supervisor, setSupervisor] = useState(true);
  const [busy, setBusy] = useState(false);
  const [problems, setProblems] = useState<{
    name?: string;
    timezone?: string;
    admin?: string;
    form?: string;
  }>({});

  async function submit() {
    const next: typeof problems = {};
    if (!name.trim()) next.name = "Give the client a name.";
    if (!timezone.trim()) next.timezone = "Choose a timezone.";
    setProblems(next);
    if (Object.keys(next).length > 0) return;
    setBusy(true);
    try {
      const created = await client.call(apiRoutes.opsCreateClient, {
        body: {
          name: name.trim(),
          timezone: timezone.trim(),
          connectorsOffered: offered,
          approvals,
          language,
          supervisor,
          ...(adminEmail.trim()
            ? {
                admin: {
                  email: adminEmail.trim(),
                  ...(adminName.trim() ? { name: adminName.trim() } : {}),
                },
              }
            : {}),
        },
      });
      const state: CreatedState = { created: { name: created.client.name, admin: created.admin } };
      navigate(`/ops/clients/${created.client.id}/settings`, { state });
      // The switcher lists the clients the session serves: reload it so the new one is there.
      void refresh();
    } catch (error) {
      const code = isApiError(error) ? error.code : null;
      if (code === "invalid_timezone") setProblems({ timezone: "That isn't a timezone we know." });
      else if (
        code &&
        ["already_member", "other_client", "is_operator", "invalid_request"].includes(code)
      ) {
        setProblems({ admin: inviteProblem(error, "ops") });
      } else setProblems({ form: "We couldn't create the client. Try again." });
    } finally {
      setBusy(false);
    }
  }

  const zones = timezones();
  return (
    <div className="max-w-3xl">
      <PageHeader title="New client" subtitle="Set the client up, then invite their admin." />
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
        className="flex flex-col gap-8"
      >
        <section>
          <SectionLabel>Client</SectionLabel>
          <Card className="flex flex-wrap gap-4 p-5">
            <Field
              label="Name"
              error={problems.name}
              className="min-w-64 flex-1"
              testId="new-client-name"
            >
              <TextInput
                data-testid="new-client-name"
                value={name}
                invalid={!!problems.name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Millwork shop"
              />
            </Field>
            <Field
              label="Timezone"
              hint="Schedules run in this timezone."
              error={problems.timezone}
              className="min-w-64 flex-1"
              testId="new-client-timezone"
            >
              <TextInput
                data-testid="new-client-timezone"
                list="new-client-timezones"
                value={timezone}
                invalid={!!problems.timezone}
                onChange={(e) => setTimezone(e.target.value)}
              />
              <datalist id="new-client-timezones">
                {zones.map((z) => (
                  <option key={z} value={z} />
                ))}
              </datalist>
            </Field>
            <Field
              label="Language"
              hint="Their portal and what their agents write for them."
              className="min-w-48"
              testId="new-client-language"
            >
              <Select
                data-testid="new-client-language"
                value={language}
                onChange={(e) => setLanguage(parseLocale(e.target.value) ?? "en")}
              >
                {LOCALES.map((l) => (
                  <option key={l} value={l}>
                    {LOCALE_NAMES[l]}
                  </option>
                ))}
              </Select>
            </Field>
          </Card>
        </section>

        <section>
          <SectionLabel>Tools to offer</SectionLabel>
          {connectors.loading && !connectors.data ? <Loading /> : null}
          {connectors.error ? (
            <ErrorNotice error={connectors.error} onRetry={connectors.reload} />
          ) : null}
          {connectors.data ? (
            <Card testId="new-client-connectors">
              <ul>
                {connectors.data.connectors.map((c) => {
                  const on = offered.includes(c.id);
                  return (
                    <li key={c.id} className="border-b border-line last:border-b-0">
                      <label className="flex cursor-pointer items-start gap-3 px-4 py-3">
                        <input
                          type="checkbox"
                          className="mt-1 size-4 accent-slate"
                          data-testid={`new-client-offer-${c.id}`}
                          checked={on}
                          onChange={() =>
                            setOffered((o) => (on ? o.filter((x) => x !== c.id) : [...o, c.id]))
                          }
                        />
                        <span className="min-w-0">
                          <span className="block font-medium text-ink">{c.name}</span>
                          <span className="block text-sm text-ink-muted">{c.description}</span>
                        </span>
                      </label>
                    </li>
                  );
                })}
              </ul>
            </Card>
          ) : null}
          <p className="mt-2 text-sm text-ink-muted">
            The client signs in to each tool from their portal. We never hold their passwords.
          </p>
        </section>

        <section>
          <SectionLabel>Approvals</SectionLabel>
          <ApproverChoice value={approvals} onChange={setApprovals} name="new-client-approvals" />
        </section>

        <section>
          <SectionLabel>Their admin</SectionLabel>
          <Card className="flex flex-wrap gap-4 p-5">
            <Field
              label="Email"
              hint="We email them an invitation. You can invite more people from Settings."
              error={problems.admin}
              className="min-w-64 flex-1"
              testId="new-client-admin-email"
            >
              <TextInput
                type="email"
                autoComplete="off"
                data-testid="new-client-admin-email"
                value={adminEmail}
                invalid={!!problems.admin}
                onChange={(e) => setAdminEmail(e.target.value)}
              />
            </Field>
            <Field label="Name (optional)" className="min-w-48 flex-1">
              <TextInput
                data-testid="new-client-admin-name"
                value={adminName}
                onChange={(e) => setAdminName(e.target.value)}
              />
            </Field>
          </Card>
        </section>

        <section>
          <SectionLabel>Supervisor</SectionLabel>
          <Card>
            <label className="flex cursor-pointer items-start gap-3 px-4 py-3">
              <input
                type="checkbox"
                className="mt-1 size-4 accent-slate"
                data-testid="new-client-supervisor"
                checked={supervisor}
                onChange={() => setSupervisor((v) => !v)}
              />
              <span className="min-w-0">
                <span className="block font-medium text-ink">Add the supervisor</span>
                <span className="block text-sm text-ink-muted">
                  It watches their runs, connections and waiting items, and tells their admin in
                  plain steps and us with the details. It changes nothing itself. You test and
                  activate it like any agent.
                </span>
              </span>
            </label>
          </Card>
        </section>

        {problems.form ? (
          <p role="alert" className="ds-error text-sm">
            {problems.form}
          </p>
        ) : null}
        <div className="flex gap-3">
          <Button type="submit" variant="primary" disabled={busy} data-testid="new-client-create">
            Create client
          </Button>
          <Link to="/ops/clients" className={buttonClass("secondary")}>
            Cancel
          </Link>
        </div>
      </form>
    </div>
  );
}
