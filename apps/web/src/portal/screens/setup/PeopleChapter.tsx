// Your people (docs/setup-plan.md §4.2; docs/plan.md §1.185, SU2): one card per seat the agents
// being set up declare, merged across them: who approves, answers, is told or is contacted. "We
// think" from the client's own answers, Yes or Change; a person picked from the team (or, for a
// seat that is told or contacted, the directory); a backup for a seat that signs; then Looks right.
// Only the client admin fills seats; everyone else reads them. Approval stays on (invariant 8).
import {
  gettingStartedRoutes,
  type PeopleChapterView,
  type SeatBody,
  type SeatKind,
  type SeatMember,
  type SeatView,
} from "@countersign/core";
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { isApiError } from "../../../api/client";
import { useApi, useApiClient } from "../../../api/useApi";
import type { PlainKey } from "../../../i18n/catalog";
import { useI18n } from "../../../i18n/i18n";
import { Field, Select } from "../../../ui/forms";
import { Loaded } from "../../../ui/page";
import { Badge, Button, Card, ErrorNotice } from "../../../ui/primitives";
import { PORTAL_PATHS } from "../../paths";
import { ChapterFrame } from "./ChapterFrame";

const KIND_WORDS: Record<SeatKind, PlainKey> = {
  signs: "setup.people.kind.signs",
  answers: "setup.people.kind.answers",
  told: "setup.people.kind.told",
  reached: "setup.people.kind.reached",
};

export function PeopleChapterScreen() {
  const state = useApi(gettingStartedRoutes.portalSetupPeople);
  return (
    <ChapterFrame chapter="people">
      <Loaded state={state}>{(d) => <People initial={d.people} />}</Loaded>
    </ChapterFrame>
  );
}

function People({ initial }: { initial: PeopleChapterView }) {
  const { t } = useI18n();
  const api = useApiClient();
  const [view, setView] = useState(initial);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState<string | null>(null);
  useEffect(() => setView(initial), [initial]);

  async function save(role: string, body: SeatBody) {
    setBusy(role);
    setError(null);
    try {
      const out = await api.call(gettingStartedRoutes.portalSetupSeat, { params: { role }, body });
      setView(out.people);
      return true;
    } catch (e) {
      setError(e);
      return false;
    } finally {
      setBusy(null);
    }
  }

  async function confirm() {
    setBusy("confirm");
    setError(null);
    try {
      setView((await api.call(gettingStartedRoutes.portalSetupPeopleConfirm)).people);
    } catch (e) {
      setError(e);
    } finally {
      setBusy(null);
    }
  }

  if (view.seats.length === 0) {
    return <p className="text-ink-muted">{t("setup.people.none")}</p>;
  }
  const agents = new Map(view.seats.flatMap((s) => s.agents).map((a) => [a.id, a.name]));
  return (
    <div className="flex flex-col gap-4" data-testid="start-people">
      <p className="text-ink-muted">{t("setup.people.intro")}</p>
      {view.canEdit ? null : (
        <p className="text-sm text-ink-muted">{t("setup.people.adminOnly")}</p>
      )}
      {error ? <SeatError error={error} /> : null}
      {view.seats.map((s) => (
        <SeatCard
          key={s.role}
          seat={s}
          view={view}
          busy={busy === s.role}
          onSave={(body) => save(s.role, body)}
        />
      ))}
      <div className="flex flex-col gap-1">
        {[...agents].map(([id, name]) => (
          <Link key={id} className="text-sm text-link" to={PORTAL_PATHS.agentSop(id)}>
            {t("setup.people.matrix", { agent: name })}
          </Link>
        ))}
      </div>
      {view.canEdit ? (
        <div className="flex flex-wrap items-center gap-3">
          {view.confirmed ? (
            <Badge tone="positive" testId="start-people-confirmed">
              {t("setup.people.confirmed", { name: view.confirmed.byName })}
            </Badge>
          ) : null}
          <Button
            variant={view.confirmed ? "secondary" : "primary"}
            working={busy === "confirm"}
            onClick={() => void confirm()}
            data-testid="start-people-looks-right"
          >
            {t("setup.people.looksRight")}
          </Button>
        </div>
      ) : null}
    </div>
  );
}

function SeatError({ error }: { error: unknown }) {
  const { t } = useI18n();
  if (isApiError(error) && error.code === "not_a_signer") {
    return (
      <p className="rounded-md border border-line bg-signal-tint p-3 text-sm text-signal-ink">
        {t("setup.people.notSigner")}{" "}
        <Link className="text-link" to={PORTAL_PATHS.team}>
          {t("setup.people.inviteNew")}
        </Link>
      </p>
    );
  }
  return <ErrorNotice error={error} />;
}

/** Who can sit in a seat: team members (signers only, to sign); contacts where it is told or contacted. */
function eligible(seat: SeatView, view: PeopleChapterView) {
  const members = view.members.filter((m) => seat.kind !== "signs" || m.canSign);
  const contacts = seat.kind === "told" || seat.kind === "reached" ? view.contacts : [];
  return {
    members: seat.kind === "reached" ? [] : members,
    contacts,
  };
}

function SeatCard({
  seat,
  view,
  busy,
  onSave,
}: {
  seat: SeatView;
  view: PeopleChapterView;
  busy: boolean;
  onSave: (body: SeatBody) => Promise<boolean>;
}) {
  const { t } = useI18n();
  const [editing, setEditing] = useState(false);
  const members = new Map(view.members.map((m) => [m.userId, m]));
  const contacts = new Map(view.contacts.map((c) => [c.id, c]));
  const nameOf = (id: string) =>
    members.get(id)?.name ?? members.get(id)?.email ?? contacts.get(id)?.name ?? id;
  const empty = seat.userIds.length + seat.contactIds.length === 0;
  const checked = seat.filled && !empty;
  const kind = t(KIND_WORDS[seat.kind]);
  const agentNames = seat.agents.map((a) => a.name).join(", ");
  const unjoined = [...seat.userIds, ...seat.backupUserIds]
    .map((id) => members.get(id))
    .filter((m): m is SeatMember => !!m && !m.joined);

  return (
    <Card pad testId={`start-seat-${seat.role}`}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="eyebrow text-ink-muted">
            {kind} · {agentNames}
          </p>
          <h3 className="text-ink">{seat.label}</h3>
          {seat.description ? <p className="text-sm text-ink-muted">{seat.description}</p> : null}
        </div>
        <Badge tone={checked ? "positive" : "warning"}>
          {checked ? t("setup.people.checked") : t("setup.people.toCheck")}
        </Badge>
      </div>

      {empty && seat.weThink && !editing ? (
        <div
          className="mt-3 flex flex-wrap items-center gap-3 rounded-md border border-line bg-surface-subtle px-4 py-3"
          data-testid={`start-seat-${seat.role}-we-think`}
        >
          <span className="min-w-0 flex-1 text-sm text-ink">
            {t("setup.people.weThink", {
              names: seat.weThink.userIds.map(nameOf).join(", "),
              from: seat.weThink.from,
            })}
          </span>
          {view.canEdit ? (
            <>
              <Button
                size="sm"
                variant="primary"
                working={busy}
                onClick={() => void onSave({ userIds: seat.weThink?.userIds ?? [] })}
              >
                {t("setup.people.yes")}
              </Button>
              <Button size="sm" onClick={() => setEditing(true)}>
                {t("setup.people.change")}
              </Button>
            </>
          ) : null}
        </div>
      ) : null}

      {!editing ? (
        <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2">
          {empty ? (
            seat.weThink ? null : (
              <p className="text-sm text-ink-muted">{t("setup.people.nobody")}</p>
            )
          ) : (
            [...seat.userIds, ...seat.contactIds].map((id) => (
              <Person key={id} name={nameOf(id)} sub={subOf(id)} />
            ))
          )}
          {seat.backupUserIds.length ? (
            <>
              <span className="text-sm text-ink-muted">{t("setup.people.backup")}:</span>
              {seat.backupUserIds.map((id) => (
                <Person key={id} name={nameOf(id)} sub={subOf(id)} />
              ))}
            </>
          ) : null}
          {view.canEdit && !(empty && seat.weThink) ? (
            <Button size="sm" variant="ghost" onClick={() => setEditing(true)}>
              {t("setup.people.change")}
            </Button>
          ) : null}
        </div>
      ) : (
        <SeatEditor
          seat={seat}
          view={view}
          busy={busy}
          nameOf={nameOf}
          onCancel={() => setEditing(false)}
          onSave={async (body) => {
            if (await onSave(body)) setEditing(false);
          }}
        />
      )}

      {unjoined.length ? (
        <p className="mt-3 text-sm text-ink-muted">
          {unjoined.map((m) => m.name ?? m.email).join(", ")}: {t("setup.people.notJoined")}
        </p>
      ) : null}
    </Card>
  );

  function subOf(id: string): string {
    const m = members.get(id);
    if (!m) return t("setup.people.byEmail");
    if (m.me) return t("setup.people.you");
    if (!m.canSign) return t("setup.people.viewer");
    return m.joined ? t("setup.people.signsIn") : t("setup.people.notJoined");
  }
}

function Person({ name, sub }: { name: string; sub: string }) {
  return (
    <span className="mz-person mz-person--role">
      <span className="ds-avatar ds-avatar--sm">
        {name
          .split(/\s+/)
          .map((w) => w[0] ?? "")
          .join("")
          .slice(0, 2)
          .toUpperCase()}
      </span>
      <span>
        {name}
        <small>{sub}</small>
      </span>
    </span>
  );
}

function SeatEditor({
  seat,
  view,
  busy,
  nameOf,
  onCancel,
  onSave,
}: {
  seat: SeatView;
  view: PeopleChapterView;
  busy: boolean;
  nameOf: (id: string) => string;
  onCancel: () => void;
  onSave: (body: SeatBody) => Promise<void>;
}) {
  const { t } = useI18n();
  const pick = eligible(seat, view);
  const [userIds, setUserIds] = useState<string[]>(
    seat.userIds.length ? seat.userIds : (seat.weThink?.userIds ?? []),
  );
  const [contactIds, setContactIds] = useState<string[]>(seat.contactIds);
  const [backups, setBackups] = useState<string[]>(seat.backupUserIds);
  const chosen = new Set([...userIds, ...contactIds, ...backups]);
  const options = [
    ...pick.members
      .filter((m) => !chosen.has(m.userId))
      .map((m) => ({ id: m.userId, name: m.name ?? m.email, user: true })),
    ...pick.contacts
      .filter((c) => !chosen.has(c.id))
      .map((c) => ({ id: c.id, name: c.name, user: false })),
  ];
  const signers = pick.members.filter((m) => !chosen.has(m.userId));
  const list = (ids: string[], drop: (id: string) => void) =>
    ids.map((id) => (
      <span
        key={id}
        className="inline-flex items-center gap-1 rounded-full border border-line px-2.5 py-0.5 text-sm"
      >
        {nameOf(id)}
        <button
          type="button"
          className="text-ink-muted hover:text-ink"
          aria-label={t("setup.people.remove", { name: nameOf(id) })}
          onClick={() => drop(id)}
        >
          ×
        </button>
      </span>
    ));

  return (
    <div className="mt-3 flex flex-col gap-3" data-testid={`start-seat-${seat.role}-editor`}>
      <div className="flex flex-wrap gap-2">
        {list(userIds, (id) => setUserIds(userIds.filter((x) => x !== id)))}
        {list(contactIds, (id) => setContactIds(contactIds.filter((x) => x !== id)))}
      </div>
      {options.length ? (
        <Field label={t("setup.people.add")}>
          <Select
            value=""
            data-testid={`start-seat-${seat.role}-add`}
            onChange={(e) => {
              const o = options.find((x) => x.id === e.target.value);
              if (!o) return;
              if (o.user) setUserIds([...userIds, o.id]);
              else setContactIds([...contactIds, o.id]);
            }}
          >
            <option value="">{t("setup.people.choose")}</option>
            {options.map((o) => (
              <option key={o.id} value={o.id}>
                {o.name}
              </option>
            ))}
          </Select>
        </Field>
      ) : null}
      {seat.kind === "signs" ? (
        <>
          <div className="flex flex-wrap gap-2">
            {list(backups, (id) => setBackups(backups.filter((x) => x !== id)))}
          </div>
          {signers.length ? (
            <Field label={t("setup.people.addBackup")} hint={t("setup.people.backup")}>
              <Select
                value=""
                data-testid={`start-seat-${seat.role}-backup`}
                onChange={(e) => {
                  if (e.target.value) setBackups([...backups, e.target.value]);
                }}
              >
                <option value="">{t("setup.people.choose")}</option>
                {signers.map((m) => (
                  <option key={m.userId} value={m.userId}>
                    {m.name ?? m.email}
                  </option>
                ))}
              </Select>
            </Field>
          ) : null}
        </>
      ) : null}
      <p className="text-sm text-ink-muted">
        <Link className="text-link" to={PORTAL_PATHS.team}>
          {t("setup.people.inviteNew")}
        </Link>
      </p>
      <div className="flex gap-2">
        <Button
          variant="primary"
          size="sm"
          working={busy}
          data-testid={`start-seat-${seat.role}-save`}
          onClick={() =>
            void onSave({
              userIds,
              ...(seat.kind === "told" || seat.kind === "reached" ? { contactIds } : {}),
              ...(seat.kind === "signs" ? { backupUserIds: backups } : {}),
            })
          }
        >
          {t("common.save")}
        </Button>
        <Button size="sm" variant="ghost" onClick={onCancel}>
          {t("common.cancel")}
        </Button>
      </div>
    </div>
  );
}
