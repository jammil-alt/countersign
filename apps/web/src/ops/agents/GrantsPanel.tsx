// A client agent's access (ARCHITECTURE §6.9, docs/plan.md §1.26 "Grants"): each connection it is
// bound to (bind it in Operation above), with what it may do there. The binding is the grant; the
// limits here only narrow it: a ceiling per verb, up to the connection's matrix, and optionally a
// subset of the connector's tools. We may loosen what we set; the client admin can only tighten or
// revoke from the portal. Secrets are never shown here, only whether one is stored.
// The owner's review: each connection shows its main row (read, create, update, delete) at once,
// in the approval words, and its limits and per-tool choices open on demand, so nothing scrolls
// sideways.
import type { GrantLimits, PermissionLevel, ReleaseWindow } from "@countersign/core";
import { useState } from "react";
import type { ResponseOf } from "../../api/client";
import { apiRoutes } from "../../api/routes";
import { useApi } from "../../api/useApi";
import { isLooser, LEVELS, levelTone, VERBS } from "../../connections/matrix";
import { Icon } from "../../ui/icons";
import { Badge, Button, Card, ErrorNotice, Loading, SectionLabel } from "../../ui/primitives";
import { errorText, Notice, plural, Select, useAction } from "./ui";

type Grant = ResponseOf<typeof apiRoutes.opsAgentGrants>["grants"][number];

// The one approval vocabulary on both sides (the owner's decision 2).
export const LEVEL_TEXT: Record<PermissionLevel, string> = {
  auto: "On its own",
  approval: "Needs approval",
  off: "Off",
};

const VERB_TEXT: Record<(typeof VERBS)[number], string> = {
  read: "Read",
  create: "Create",
  update: "Update",
  delete: "Delete",
};

const KIND_TEXT: Record<Grant["kind"], string> = {
  oauth: "Signed in by the client",
  api_key: "API key",
  browser: "Website login",
  built_in: "Built in",
};

export function GrantsPanel({
  agentId,
  clientId = null,
}: {
  agentId: string;
  /** The agent's client, to turn human release on (none: shown read-only). */
  clientId?: string | null;
}) {
  const grants = useApi(apiRoutes.opsAgentGrants, {
    params: { id: agentId },
    // Vault and second-factor answers are never stored (docs/audit-plan.md 1.2).
    cache: "none",
  });
  return (
    <Card className="p-5" testId="agent-grants">
      <SectionLabel>What it may do</SectionLabel>
      <p className="mb-4 text-sm text-ink-muted">
        In each connection it is bound to. Limits only narrow the connection's own permissions; the
        client can tighten or revoke them, only we loosen.
      </p>
      {grants.error ? <ErrorNotice error={grants.error} onRetry={grants.reload} /> : null}
      {grants.loading && !grants.data ? <Loading /> : null}
      {grants.data?.grants.length === 0 ? (
        <p className="text-sm text-ink-muted">Not bound to any connection yet.</p>
      ) : null}
      <div className="flex flex-col gap-4">
        {grants.data?.grants.map((g) => (
          <GrantRow
            key={`${g.connectionId}:${g.access.updatedAt ?? ""}`}
            agentId={agentId}
            clientId={clientId}
            grant={g}
            onSaved={grants.reload}
          />
        ))}
      </div>
    </Card>
  );
}

function GrantRow({
  agentId,
  clientId,
  grant,
  onSaved,
}: {
  agentId: string;
  clientId: string | null;
  grant: Grant;
  onSaved: () => void;
}) {
  const { access } = grant;
  const [verbs, setVerbs] = useState<NonNullable<GrantLimits["verbs"]>>(
    () => access.limits.verbs ?? {},
  );
  const [limitTools, setLimitTools] = useState(access.tools !== null);
  const [tools, setTools] = useState<string[]>(access.tools ?? grant.tools.map((t) => t.id));
  const [saved, setSaved] = useState(false);
  const [editing, setEditing] = useState(false);
  const action = useAction();

  const limits: GrantLimits = {
    ...(Object.keys(verbs).length ? { verbs } : {}),
    ...(limitTools ? { tools } : {}),
  };
  const dirty = JSON.stringify(limits) !== JSON.stringify(access.limits);

  async function save(next: GrantLimits) {
    setSaved(false);
    const res = await action.call(apiRoutes.opsSetAgentGrant, {
      params: { id: agentId, connectionId: grant.connectionId },
      body: { limits: next },
    });
    if (res.ok) {
      setSaved(true);
      onSaved();
    }
  }

  return (
    <div
      className="rounded-md border border-line p-4"
      data-testid={`agent-grant-${grant.connector}`}
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <p className="font-medium text-ink">{grant.connectorName}</p>
          <p className="text-sm text-ink-muted">
            {KIND_TEXT[grant.kind]} · {grant.status}
          </p>
        </div>
        <div className="flex flex-wrap gap-1.5">
          {access.revoked ? <Badge testId="agent-grant-revoked">Revoked</Badge> : null}
          {grant.kind !== "built_in" ? (
            <Badge tone={grant.secretSet ? "positive" : "neutral"}>
              {grant.secretSet ? "Secret stored" : "No secret stored"}
            </Badge>
          ) : null}
        </div>
      </div>

      {/* The main row: what it may do now, per verb. */}
      <dl
        className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2 sm:grid-cols-4"
        data-testid={`agent-grant-${grant.connector}-summary`}
      >
        {VERBS.map((v) => (
          <div key={v} className="flex flex-col gap-1">
            <dt className="text-sm text-ink-muted">{VERB_TEXT[v]}</dt>
            <dd>
              <Badge tone={levelTone(access.effective[v])}>{LEVEL_TEXT[access.effective[v]]}</Badge>
            </dd>
          </div>
        ))}
      </dl>
      {access.tools !== null ? (
        <p className="mt-2 text-sm text-ink-muted">
          Only {access.tools.length} of its {plural(grant.tools.length, "tool")}.
        </p>
      ) : null}

      <button
        type="button"
        className="ds-btn ds-btn--link mt-2 inline-flex items-center gap-1 text-sm"
        aria-expanded={editing}
        data-testid={`agent-grant-${grant.connector}-edit`}
        onClick={() => setEditing((x) => !x)}
      >
        {editing ? "Hide limits" : "Change limits"}
        <Icon name={editing ? "chevron-down" : "chevron-right"} size={16} />
      </button>

      {editing ? (
        <div className="mt-3 flex flex-col gap-3 rounded-md bg-surface-subtle p-3">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {VERBS.map((v) => {
              const ceiling = grant.matrix[v];
              // Up to the connection's matrix; "" = no limit (the matrix decides).
              const options = LEVELS.filter((l) => !isLooser(l, ceiling) || l === verbs[v]);
              return (
                <div key={v} className="flex min-w-0 flex-col gap-1">
                  <span className="text-sm font-medium text-ink">
                    {VERB_TEXT[v]}{" "}
                    <span className="font-normal text-ink-muted">
                      · connection: {LEVEL_TEXT[ceiling].toLowerCase()}
                    </span>
                  </span>
                  <Select
                    aria-label={VERB_TEXT[v]}
                    data-testid={`agent-grant-${grant.connector}-${v}`}
                    value={verbs[v] ?? ""}
                    onChange={(e) =>
                      setVerbs((s) => {
                        const next = { ...s };
                        if (e.target.value) next[v] = e.target.value as PermissionLevel;
                        else delete next[v];
                        return next;
                      })
                    }
                  >
                    <option value="">As the connection allows</option>
                    {options.map((l) => (
                      <option key={l} value={l}>
                        {LEVEL_TEXT[l]}
                      </option>
                    ))}
                  </Select>
                </div>
              );
            })}
          </div>

          {grant.tools.length > 0 ? (
            <div>
              <label className="flex items-center gap-2 text-sm text-ink">
                <input
                  type="checkbox"
                  className="size-4 accent-slate"
                  data-testid={`agent-grant-${grant.connector}-limit-tools`}
                  checked={limitTools}
                  onChange={(e) => setLimitTools(e.target.checked)}
                />
                Only some of its tools
              </label>
              {limitTools ? (
                <div className="mt-2 flex flex-col gap-1.5 pl-6">
                  {grant.tools.map((t) => (
                    <label key={t.id} className="flex items-start gap-2 text-sm text-ink">
                      <input
                        type="checkbox"
                        className="mt-0.5 size-4 shrink-0 accent-slate"
                        data-testid={`agent-grant-tool-${t.id}`}
                        checked={tools.includes(t.id)}
                        onChange={(e) =>
                          setTools((ts) =>
                            e.target.checked ? [...ts, t.id] : ts.filter((id) => id !== t.id),
                          )
                        }
                      />
                      <span>
                        {t.description}{" "}
                        <span className="text-ink-muted">({VERB_TEXT[t.verb].toLowerCase()})</span>
                      </span>
                    </label>
                  ))}
                </div>
              ) : null}
            </div>
          ) : null}

          <div className="flex justify-end">
            <Button
              data-testid={`agent-grant-${grant.connector}-save`}
              variant="primary"
              disabled={!dirty || action.busy}
              onClick={() => void save(limits)}
            >
              {action.busy ? "Saving…" : "Save limits"}
            </Button>
          </div>
        </div>
      ) : null}

      <ReleaseOps grant={grant} clientId={clientId} onSaved={onSaved} />

      {saved ? (
        <div className="mt-3">
          <Notice tone="positive" testId="agent-grant-saved">
            Saved.
          </Notice>
        </div>
      ) : null}
      {action.error ? (
        <div className="mt-3">
          <Notice tone="warning" testId="agent-grant-error">
            {errorText(action.error)}
          </Notice>
        </div>
      ) : null}
    </div>
  );
}

const HOURS = [1, 2, 4, 8, 12, 24] as const;

function windowText(window: ReleaseWindow): string {
  if (window === "run") return "one run";
  return window.hours === 1 ? "1 hour" : `${window.hours} hours`;
}

/**
 * Human release (docs/plan.md §1.26): read-only here, with "Turn on" while it is off. Only the
 * client admin turns it off or changes who releases it; we can only turn it on.
 */
function ReleaseOps({
  grant,
  clientId,
  onSaved,
}: {
  grant: Grant;
  clientId: string | null;
  onSaved: () => void;
}) {
  const { release } = grant;
  const [open, setOpen] = useState(false);
  const people = useApi(
    apiRoutes.opsRelease,
    open && clientId
      ? {
          params: { clientId, connectionId: grant.connectionId },
          // A vault item's release setting is never stored (docs/audit-plan.md 1.2).
          cache: "none",
        }
      : null,
  );
  const [personId, setPersonId] = useState("");
  const [channel, setChannel] = useState<"sms" | "email">("email");
  const [hours, setHours] = useState(0);
  const action = useAction();
  const list = people.data?.people ?? [];
  const person = list.find((p) => p.id === (personId || list[0]?.id));
  const on = release.mode === "code";

  async function turnOn() {
    if (!clientId || !person) return;
    const res = await action.call(apiRoutes.opsSetRelease, {
      params: { clientId, connectionId: grant.connectionId },
      body: {
        mode: "code",
        personId: person.id,
        channel,
        window: hours === 0 ? "run" : { hours },
      },
    });
    if (res.ok) {
      setOpen(false);
      onSaved();
    }
  }

  return (
    <div
      className="mt-3 rounded-md border border-line p-3"
      data-testid={`agent-grant-${grant.connector}-release`}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm font-medium text-ink">Human release</p>
        <Badge tone={on ? "person" : "neutral"}>{on ? "On" : "Off"}</Badge>
      </div>
      <p className="mt-1 text-sm text-ink-muted">
        {on && release.person
          ? `${release.person.name ?? "A client person"} releases it with a code by ${release.channel === "sms" ? "text" : "email"}, for ${windowText(release.window)}. ${release.live.length} live now. Only the client admin can change it or turn it off.`
          : "Off: agents use this connection without a person's code. We can turn it on; only the client admin turns it off."}
      </p>
      {!on && clientId && !open ? (
        <div className="mt-2">
          <Button
            size="sm"
            data-testid={`agent-grant-${grant.connector}-release-on`}
            onClick={() => setOpen(true)}
          >
            Turn on
          </Button>
        </div>
      ) : null}
      {open ? (
        <div className="mt-3 flex flex-col gap-2">
          {people.loading && !people.data ? <Loading /> : null}
          {people.error ? <ErrorNotice error={people.error} onRetry={people.reload} /> : null}
          <div className="grid grid-cols-1 gap-2 md:grid-cols-3">
            <Select
              data-testid="release-person"
              value={person?.id ?? ""}
              onChange={(e) => setPersonId(e.target.value)}
            >
              {list.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name ? `${p.name} · ${p.email}` : p.email}
                </option>
              ))}
            </Select>
            <Select
              data-testid="release-channel"
              value={channel}
              onChange={(e) => setChannel(e.target.value as "sms" | "email")}
            >
              <option value="email">By email</option>
              <option value="sms" disabled={person ? !person.canText : true}>
                By text
              </option>
            </Select>
            <Select
              data-testid="release-window"
              value={String(hours)}
              onChange={(e) => setHours(Number(e.target.value))}
            >
              <option value="0">For one run</option>
              {HOURS.map((h) => (
                <option key={h} value={String(h)}>
                  For {h === 1 ? "1 hour" : `${h} hours`}
                </option>
              ))}
            </Select>
          </div>
          {action.error ? (
            <Notice tone="warning" testId="agent-grant-release-error">
              {errorText(action.error)}
            </Notice>
          ) : null}
          <div className="flex gap-2">
            <Button
              size="sm"
              variant="primary"
              data-testid="release-save"
              disabled={!person || action.busy}
              onClick={() => void turnOn()}
            >
              {action.busy ? "Turning on…" : "Turn on"}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setOpen(false)}>
              Cancel
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
