// docs/plan.md §1.230: a pack's configuration on the client page's Areas tab, the same for every
// pack. Off: the pack's settings at their defaults and Switch on, which installs it with them.
// On: what the client has, and Change settings. Both go through the one install route
// (`opsInstallClientPack`), which takes only configuration. Loaded on demand (the Areas tab's
// first load stays as it was).
import { useState } from "react";
import type { ResponseOf } from "../api/client";
import { apiRoutes } from "../api/routes";
import { useApiClient } from "../api/useApi";
import { Field, Select, TextInput } from "../ui/forms";
import { Button, ErrorNotice, SectionLabel } from "../ui/primitives";

type Area = ResponseOf<typeof apiRoutes.opsClientPacks>["packs"][number];
type Fields = Area["config"]["fields"];
type Values = Area["config"]["values"];

export default function PackSettings({
  clientId,
  area,
  onChanged,
}: {
  clientId: string;
  area: Area;
  onChanged: () => void;
}) {
  const api = useApiClient();
  const { fields, values } = area.config;
  const [editing, setEditing] = useState(!area.enabled);
  const [draft, setDraft] = useState<Values>(values);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<unknown>(null);
  const testId = `pack-settings-${area.id}`;

  async function save() {
    setBusy(true);
    setProblem(null);
    try {
      await api.call(apiRoutes.opsInstallClientPack, {
        params: { id: clientId, pack: area.id },
        body: { config: changed(fields, values, draft, area.enabled) },
      });
      setEditing(false);
      onChanged();
    } catch (e) {
      setProblem(e);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-4" data-testid={testId}>
      <SectionLabel>Settings</SectionLabel>
      {editing ? (
        <form
          className="flex max-w-xl flex-col gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
        >
          {fields.map((f) => (
            <FieldInput
              key={f.key}
              field={f}
              value={draft[f.key] ?? f.default}
              onChange={(v) => setDraft({ ...draft, [f.key]: v })}
              testId={`${testId}-${f.key}`}
            />
          ))}
          {problem ? <ErrorNotice error={problem} /> : null}
          <span className="flex gap-2">
            <Button
              type="submit"
              size="sm"
              variant="primary"
              disabled={busy}
              data-testid={`${testId}-save`}
            >
              {area.enabled ? "Save settings" : "Switch on"}
            </Button>
            {area.enabled ? (
              <Button
                type="button"
                size="sm"
                variant="ghost"
                disabled={busy}
                onClick={() => {
                  setDraft(values);
                  setEditing(false);
                }}
              >
                Cancel
              </Button>
            ) : null}
          </span>
        </form>
      ) : (
        <div className="flex flex-wrap items-start justify-between gap-3">
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
            {fields.map((f) => (
              <div key={f.key} className="contents">
                <dt className="text-ink-muted">{f.label}</dt>
                <dd className="text-ink" data-testid={`${testId}-${f.key}-value`}>
                  {shown(f, values[f.key] ?? f.default)}
                </dd>
              </div>
            ))}
          </dl>
          <Button
            size="sm"
            variant="secondary"
            data-testid={`${testId}-edit`}
            onClick={() => {
              setDraft(values);
              setEditing(true);
            }}
          >
            Change settings
          </Button>
        </div>
      )}
    </div>
  );
}

/** Only what the operator changed, once the pack is on; every value when switching it on. */
function changed(fields: Fields, before: Values, draft: Values, enabled: boolean): Values {
  const out: Values = {};
  for (const f of fields) {
    const raw = draft[f.key];
    if (raw === undefined) continue;
    // A number field's text, as typed; left empty, it goes back to its default.
    const v = f.type === "number" && typeof raw === "string" ? toNumber(raw, f.default) : raw;
    if (!enabled || v !== before[f.key]) out[f.key] = v;
  }
  return out;
}

function toNumber(text: string, fallback: number): number {
  const n = Number(text);
  return text.trim() === "" || !Number.isFinite(n) ? fallback : n;
}

function shown(field: Fields[number], value: string | number | boolean): string {
  if (field.type === "boolean") return value ? "Yes" : "No";
  if (field.type === "choice") {
    return field.options.find((o) => o.value === value)?.label ?? String(value);
  }
  return value === "" ? "None" : String(value);
}

function FieldInput({
  field,
  value,
  onChange,
  testId,
}: {
  field: Fields[number];
  value: string | number | boolean;
  onChange: (value: string | number | boolean) => void;
  testId: string;
}) {
  if (field.type === "boolean") {
    return (
      <label className="flex items-center gap-2 text-sm text-ink">
        <input
          type="checkbox"
          className="size-4 accent-slate"
          data-testid={testId}
          checked={value === true}
          onChange={(e) => onChange(e.target.checked)}
        />
        {field.label}
      </label>
    );
  }
  return (
    <Field label={field.label} hint={field.help} testId={testId}>
      {field.type === "choice" ? (
        <Select
          data-testid={testId}
          value={String(value)}
          onChange={(e) => onChange(e.target.value)}
        >
          {field.options.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </Select>
      ) : field.type === "number" ? (
        <TextInput
          type="number"
          className="w-28"
          data-testid={testId}
          value={String(value)}
          min={field.min}
          max={field.max}
          onChange={(e) => onChange(e.target.value)}
        />
      ) : (
        <TextInput
          data-testid={testId}
          value={String(value)}
          maxLength={500}
          onChange={(e) => onChange(e.target.value)}
        />
      )}
    </Field>
  );
}
