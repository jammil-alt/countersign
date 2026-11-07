// Who approves what, in Settings, Approvals (`GET /api/team`; on the Desk until QA round 1): each
// person, whether they approve, and what the approver rules send them, in the API's words; and the
// undo window, which the client admin sets (`PUT /api/desk/settings`, 0 to 300 seconds; 0 switches
// it off). Everyone else reads it.
import { UNDO_SECONDS_MAX } from "@countersign/core";
import { useState } from "react";
import type { ResponseOf } from "../api/client";
import { apiRoutes } from "../api/routes";
import { useApi, useApiClient } from "../api/useApi";
import { useI18n } from "../i18n/i18n";
import { PersonBadge } from "../ui/badges";
import { Field, Select } from "../ui/forms";
import { Loaded } from "../ui/page";
import { Card, ErrorNotice } from "../ui/primitives";

type Team = ResponseOf<typeof apiRoutes.portalTeam>;

/** The card with its own read of the team. */
export function PortalTeamApprovals({ isAdmin }: { isAdmin: boolean }) {
  const team = useApi(apiRoutes.portalTeam);
  return (
    <Loaded state={team}>
      {(data) => <TeamApprovals team={data} isAdmin={isAdmin} onSaved={team.reload} />}
    </Loaded>
  );
}

/** The undo windows offered, in seconds (the API takes any whole number up to 300). */
const WINDOWS = [0, 30, 60, 120, UNDO_SECONDS_MAX] as const;

export function TeamApprovals({
  team,
  isAdmin,
  onSaved,
}: {
  team: Team;
  isAdmin: boolean;
  onSaved: () => void;
}) {
  const { t } = useI18n();
  const api = useApiClient();
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const seconds = team.settings.undoSeconds;
  const windows: number[] = WINDOWS.includes(seconds as (typeof WINDOWS)[number])
    ? [...WINDOWS]
    : [...WINDOWS, seconds].sort((a, b) => a - b);
  const label = (s: number) =>
    s === 0 ? t("desk.team.undoOff") : t("desk.team.undoSeconds", { count: s });

  return (
    <Card title={t("desk.team.title")} testId="desk-team">
      <ul>
        {team.members.map((m) => (
          <li
            key={m.userId}
            className="flex items-start gap-3 border-b border-line px-6 py-3 max-sm:px-4"
          >
            <PersonBadge name={m.name ?? m.email} plain size="sm" />
            <div className="min-w-0">
              <p className="truncate text-sm font-medium text-ink">{m.name ?? m.email}</p>
              {m.signs.map((line) => (
                <p key={line} className="text-sm text-ink-muted">
                  {line}
                </p>
              ))}
            </div>
          </li>
        ))}
      </ul>
      <div className="flex flex-col gap-2 px-6 py-4 max-sm:px-4">
        {isAdmin ? (
          <Field label={t("desk.team.undo")} hint={t("desk.team.undoHint")}>
            <Select
              data-testid="desk-undo-window"
              value={String(seconds)}
              disabled={busy}
              onChange={async (e) => {
                setBusy(true);
                setError(null);
                try {
                  await api.call(apiRoutes.portalDeskSettings, {
                    body: { undoSeconds: Number(e.target.value) },
                  });
                  onSaved();
                } catch (err) {
                  setError(err);
                } finally {
                  setBusy(false);
                }
              }}
            >
              {windows.map((s) => (
                <option key={s} value={s}>
                  {label(s)}
                </option>
              ))}
            </Select>
          </Field>
        ) : (
          <p className="text-sm text-ink-muted" data-testid="desk-undo-window-text">
            {t("desk.team.undoIs", { window: label(seconds) })}
          </p>
        )}
        {error ? <ErrorNotice error={error} /> : null}
      </div>
    </Card>
  );
}
