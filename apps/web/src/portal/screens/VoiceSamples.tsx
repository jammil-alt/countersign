// Voice samples on the People page (ARCHITECTURE v0.12 §6.4; docs/plan.md §1.42): examples of how
// the client's own people write, which our agents read for tone only, never as instructions. The
// client admin pastes one (whose voice, which channel), edits it (the previous text is kept) and
// archives it. The text is shown as kept: quoted history cut, card numbers redacted.
import {
  VOICE_SAMPLE_CHANNELS,
  VOICE_SAMPLE_PASTE_MAX,
  VOICE_SAMPLE_TITLE_MAX,
  type VoiceSample,
  type VoiceSampleChannel,
} from "@countersign/core";
import { useState } from "react";
import { apiRoutes } from "../../api/routes";
import { useApi, useApiClient } from "../../api/useApi";
import type { PlainKey } from "../../i18n/catalog";
import { useI18n } from "../../i18n/i18n";
import { shortTime } from "../../runs/format";
import { Field, Select, TextArea, TextInput } from "../../ui/forms";
import { Loaded, Section } from "../../ui/page";
import { Button, Card, EmptyState, ErrorNotice, Tag } from "../../ui/primitives";

const CHANNEL_KEY: Record<VoiceSampleChannel, PlainKey> = {
  email: "peoplePage.channel.email",
  sms: "peoplePage.channel.sms",
  whatsapp: "peoplePage.channel.whatsapp",
};

export function VoiceSamples() {
  const { t } = useI18n();
  const samples = useApi(apiRoutes.portalVoiceSamples, { query: { show: "active" } });
  const users = useApi(apiRoutes.portalUsers);
  const [adding, setAdding] = useState(false);
  const team = (users.data?.users ?? []).filter((u) => u.role !== "operator");
  return (
    <Section
      title={t("peoplePage.voice.title")}
      meta={t("peoplePage.voice.subtitle")}
      action={
        adding ? null : (
          <Button size="sm" data-testid="voice-add" onClick={() => setAdding(true)}>
            {t("peoplePage.voice.add")}
          </Button>
        )
      }
      testId="voice-samples"
    >
      {adding ? (
        <Card pad testId="voice-new">
          <SampleForm
            sample={null}
            team={team}
            onDone={() => {
              setAdding(false);
              samples.reload();
            }}
            onCancel={() => setAdding(false)}
          />
        </Card>
      ) : null}
      <Loaded state={samples}>
        {(data) =>
          data.samples.length === 0 ? (
            <EmptyState>{t("peoplePage.voice.empty")}</EmptyState>
          ) : (
            <div className="flex flex-col gap-4">
              {data.samples.map((s) => (
                <SampleCard key={s.id} sample={s} team={team} onChanged={samples.reload} />
              ))}
            </div>
          )
        }
      </Loaded>
    </Section>
  );
}

type TeamMember = { userId: string; name: string | null; email: string };

function SampleCard({
  sample,
  team,
  onChanged,
}: {
  sample: VoiceSample;
  team: TeamMember[];
  onChanged: () => void;
}) {
  const i18n = useI18n();
  const { t } = i18n;
  const api = useApiClient();
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  async function archive() {
    setBusy(true);
    setError(null);
    try {
      await api.call(apiRoutes.portalVoiceSampleArchive, {
        params: { id: sample.id },
        body: { baseVersion: sample.version },
      });
      onChanged();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card testId={`voice-sample-${sample.id}`}>
      <div className="flex flex-wrap items-start justify-between gap-3 px-6 py-4">
        <div className="min-w-0">
          <p className="font-medium text-ink">{sample.title}</p>
          <p className="text-sm text-ink-muted">
            {t("peoplePage.voice.byline", {
              person: sample.person.name ?? "—",
              time: shortTime(sample.updatedAt, undefined, i18n),
            })}
          </p>
        </div>
        <Tag>{t(CHANNEL_KEY[sample.channel])}</Tag>
      </div>
      {editing ? (
        <div className="border-t border-line px-6 py-4">
          <SampleForm
            sample={sample}
            team={team}
            onDone={() => {
              setEditing(false);
              onChanged();
            }}
            onCancel={() => setEditing(false)}
          />
        </div>
      ) : (
        <p className="border-t border-line px-6 py-4 text-sm whitespace-pre-line text-ink">
          {sample.text}
        </p>
      )}
      {error ? (
        <div className="px-6 pb-4">
          <ErrorNotice error={error} />
        </div>
      ) : null}
      {editing ? null : (
        <div className="ui-card__foot">
          <Button size="sm" data-testid="voice-edit" onClick={() => setEditing(true)}>
            {t("directory.edit")}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            disabled={busy}
            data-testid="voice-archive"
            onClick={() => void archive()}
          >
            {t("peoplePage.voice.archive")}
          </Button>
        </div>
      )}
    </Card>
  );
}

function SampleForm({
  sample,
  team,
  onDone,
  onCancel,
}: {
  sample: VoiceSample | null;
  team: TeamMember[];
  onDone: () => void;
  onCancel: () => void;
}) {
  const { t } = useI18n();
  const api = useApiClient();
  const [title, setTitle] = useState(sample?.title ?? "");
  const [text, setText] = useState(sample?.text ?? "");
  const [channel, setChannel] = useState<VoiceSampleChannel>(sample?.channel ?? "email");
  // Empty: the client admin's own voice (the API's default).
  const [person, setPerson] = useState(sample?.person.id ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const ready = title.trim().length > 0 && text.trim().length > 0;

  async function save() {
    setBusy(true);
    setError(null);
    try {
      const fields = {
        title: title.trim(),
        text: text.trim(),
        channel,
        ...(person ? { personUserId: person } : {}),
      };
      if (sample) {
        await api.call(apiRoutes.portalVoiceSampleEdit, {
          params: { id: sample.id },
          body: { ...fields, baseVersion: sample.version },
        });
      } else {
        await api.call(apiRoutes.portalVoiceSampleCreate, { body: fields });
      }
      onDone();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form
      className="flex flex-col gap-3"
      data-testid="voice-form"
      onSubmit={(e) => {
        e.preventDefault();
        if (ready && !busy) void save();
      }}
    >
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field label={t("peoplePage.voice.person")}>
          <Select
            value={person}
            onChange={(e) => setPerson(e.target.value)}
            data-testid="voice-person"
          >
            <option value="">{t("peoplePage.voice.you")}</option>
            {team.map((u) => (
              <option key={u.userId} value={u.userId}>
                {u.name ?? u.email}
              </option>
            ))}
          </Select>
        </Field>
        <Field label={t("peoplePage.voice.channel")}>
          <Select
            value={channel}
            onChange={(e) => setChannel(e.target.value as VoiceSampleChannel)}
            data-testid="voice-channel"
          >
            {VOICE_SAMPLE_CHANNELS.map((c) => (
              <option key={c} value={c}>
                {t(CHANNEL_KEY[c])}
              </option>
            ))}
          </Select>
        </Field>
      </div>
      <Field label={t("peoplePage.voice.sampleTitle")}>
        <TextInput
          value={title}
          maxLength={VOICE_SAMPLE_TITLE_MAX}
          onChange={(e) => setTitle(e.target.value)}
          data-testid="voice-title"
        />
      </Field>
      <Field label={t("peoplePage.voice.text")} hint={t("peoplePage.voice.textHint")}>
        <TextArea
          rows={6}
          value={text}
          maxLength={VOICE_SAMPLE_PASTE_MAX}
          onChange={(e) => setText(e.target.value)}
          data-testid="voice-text"
        />
      </Field>
      {error ? <ErrorNotice error={error} /> : null}
      <div className="flex gap-2">
        <Button type="submit" variant="primary" disabled={!ready || busy} data-testid="voice-save">
          {t("common.save")}
        </Button>
        <Button variant="ghost" onClick={onCancel}>
          {t("common.cancel")}
        </Button>
      </div>
    </form>
  );
}
