// The client settings' Custom fields section (docs/step-model-plan.md §10f): fields we add to a
// record type for this client, or share with every client, so a use case maps its data without a
// change to the schema. A field is used like a built-in one: in steps' inputs and outputs, Find,
// and the Data tab. Removing one hides it and keeps its data; its type can't change once a record
// holds a value (the server says so). Ours only: the client never sees this (invariant 11).
import {
  CUSTOM_FIELD_TYPES,
  type CustomFieldType,
  type CustomFieldView,
  type RecordType,
} from "@countersign/core";
import { useMemo, useState } from "react";
import { isApiError } from "../../api/client";
import { apiRoutes } from "../../api/routes";
import { useApi, useApiClient } from "../../api/useApi";
import { Field, Select, TextInput } from "../../ui/forms";
import { Loaded, Section } from "../../ui/page";
import { Badge, Button, Card, EmptyState } from "../../ui/primitives";
import { TableCard } from "./business";

export const FIELD_TYPE_WORDS: Record<CustomFieldType, string> = {
  text: "Text",
  number: "Number",
  money: "Money",
  date: "Date",
  yes_no: "Yes or no",
  list: "List",
  group: "Group",
  record: "Link to a record",
};

const AREA_WORDS: Record<string, string> = {
  shared: "Shared",
  purchasing: "Purchasing",
  bookkeeping: "Bookkeeping",
  sales: "Sales",
  marketing: "Marketing",
};

/** "Credit limit" → "creditLimit": the key a field is stored and wired under. */
export function fieldNameOf(label: string): string {
  const words = label
    .normalize("NFKD")
    .replace(/[^A-Za-z0-9 ]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  const name = words
    .map((w, i) => (i === 0 ? w.toLowerCase() : w[0]?.toUpperCase() + w.slice(1).toLowerCase()))
    .join("");
  const safe = /^[a-z]/.test(name) ? name : `f${name}`;
  return safe.slice(0, 40);
}

function message(e: unknown): string {
  return isApiError(e) ? e.message : "We couldn't save that. Try again.";
}

export function ClientCustomFieldsSection({ clientId }: { clientId: string }) {
  const state = useApi(apiRoutes.opsRecordTypes, { query: { client: clientId } });
  return (
    <Section
      title="Custom fields"
      meta="Fields we add to this client's records. Steps use them like built-in fields."
      testId="ops-client-settings-custom-fields"
    >
      <Loaded state={state}>
        {(data) => (
          <CustomFields
            clientId={clientId}
            recordTypes={data.recordTypes}
            fields={data.fields}
            onChange={state.reload}
          />
        )}
      </Loaded>
    </Section>
  );
}

function CustomFields({
  clientId,
  recordTypes,
  fields,
  onChange,
}: {
  clientId: string;
  recordTypes: readonly RecordType[];
  fields: readonly CustomFieldView[];
  onChange: () => void;
}) {
  const [typeId, setTypeId] = useState(recordTypes[0]?.id ?? "");
  const type = recordTypes.find((t) => t.id === typeId);
  const mine = fields.filter((f) => f.recordType === typeId);
  const byArea = useMemo(() => {
    const out = new Map<string, RecordType[]>();
    for (const t of recordTypes) out.set(t.area, [...(out.get(t.area) ?? []), t]);
    return [...out];
  }, [recordTypes]);
  if (!type) return <EmptyState compact line="No area declares a record type yet." />;
  return (
    <div className="flex flex-col gap-4">
      <Field label="Record type" hint={type.about} className="max-w-sm">
        <Select
          value={typeId}
          onChange={(e) => setTypeId(e.target.value)}
          data-testid="ops-custom-fields-type"
        >
          {byArea.map(([area, types]) => (
            <optgroup key={area} label={AREA_WORDS[area] ?? area}>
              {types.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.plural}
                </option>
              ))}
            </optgroup>
          ))}
        </Select>
      </Field>
      <TableCard
        title={`${type.plural}' fields`}
        meta={`${type.fields.length} built in, ${mine.filter((f) => !f.hidden).length} added`}
        testId="ops-custom-fields-table"
      >
        <table>
          <thead>
            <tr className="dt-cols">
              <th>Field</th>
              <th>Type</th>
              <th>For</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {type.fields.map((f) => (
              <tr key={`built-${f.name}`}>
                <td>
                  <span className="text-ink">{f.name}</span>
                  {f.about ? <span className="block text-sm text-ink-muted">{f.about}</span> : null}
                </td>
                <td>{FIELD_TYPE_WORDS[f.type]}</td>
                <td>
                  <Badge tone="neutral">Built in</Badge>
                </td>
                <td />
              </tr>
            ))}
            {mine.map((f) => (
              <FieldRow key={f.id} field={f} onChange={onChange} />
            ))}
          </tbody>
        </table>
      </TableCard>
      <AddField
        clientId={clientId}
        recordType={type}
        recordTypes={recordTypes}
        onAdded={onChange}
      />
    </div>
  );
}

function FieldRow({ field, onChange }: { field: CustomFieldView; onChange: () => void }) {
  const api = useApiClient();
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const testId = `ops-custom-field-${field.name}`;
  async function setHidden(hidden: boolean) {
    setBusy(true);
    setProblem(null);
    try {
      await api.call(apiRoutes.opsCustomFieldUpdate, {
        params: { id: field.id },
        body: { hidden },
      });
      onChange();
    } catch (e) {
      setProblem(message(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <tr data-testid={testId} className={field.hidden ? "opacity-60" : undefined}>
      <td>
        <span className="text-ink">{field.label}</span>{" "}
        <span className="text-sm text-ink-muted">{field.name}</span>
        {field.required ? <span className="text-sm text-ink-muted"> · required</span> : null}
        {field.about ? <span className="block text-sm text-ink-muted">{field.about}</span> : null}
        {problem ? (
          <span role="alert" className="ds-error block text-sm">
            {problem}
          </span>
        ) : null}
      </td>
      <td>
        {FIELD_TYPE_WORDS[field.type]}
        {field.spec.record ? ` (${field.spec.record})` : ""}
      </td>
      <td>
        {field.hidden ? (
          <Badge tone="neutral">Removed</Badge>
        ) : field.scope === "shared" ? (
          <Badge tone="neutral">Every client</Badge>
        ) : (
          <Badge tone="neutral">This client</Badge>
        )}
      </td>
      <td className="text-right">
        <Button
          variant="secondary"
          disabled={busy}
          onClick={() => void setHidden(!field.hidden)}
          data-testid={`${testId}-${field.hidden ? "show" : "remove"}`}
        >
          {field.hidden ? "Show again" : "Remove"}
        </Button>
      </td>
    </tr>
  );
}

function AddField({
  clientId,
  recordType,
  recordTypes,
  onAdded,
}: {
  clientId: string;
  recordType: RecordType;
  recordTypes: readonly RecordType[];
  onAdded: () => void;
}) {
  const api = useApiClient();
  const [label, setLabel] = useState("");
  const [type, setType] = useState<CustomFieldType>("text");
  const [about, setAbout] = useState("");
  const [required, setRequired] = useState(false);
  const [shared, setShared] = useState(false);
  const [parts, setParts] = useState("");
  const [linkTo, setLinkTo] = useState(recordTypes[0]?.id ?? "");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const name = fieldNameOf(label);
  const listed = type === "list" || type === "group";

  async function add() {
    setBusy(true);
    setProblem(null);
    try {
      await api.call(apiRoutes.opsCustomFieldCreate, {
        body: {
          ...(shared ? {} : { clientId }),
          recordType: recordType.id,
          name,
          label: label.trim(),
          type,
          spec: listed
            ? {
                of: parts
                  .split(",")
                  .map((p) => fieldNameOf(p))
                  .filter(Boolean)
                  .map((n) => ({ name: n, type: "text" as const, required: false })),
              }
            : type === "record"
              ? { record: linkTo }
              : {},
          required,
          about: about.trim(),
        },
      });
      setLabel("");
      setAbout("");
      setParts("");
      setRequired(false);
      onAdded();
    } catch (e) {
      setProblem(message(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card
      title={`Add a field to ${recordType.plural.toLowerCase()}`}
      pad
      testId="ops-custom-field-add"
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Name" hint={label ? `Stored as ${name}` : "What a person reads"}>
          <TextInput
            value={label}
            maxLength={60}
            onChange={(e) => setLabel(e.target.value)}
            data-testid="ops-custom-field-label"
          />
        </Field>
        <Field label="Type">
          <Select
            value={type}
            onChange={(e) => setType(e.target.value as CustomFieldType)}
            data-testid="ops-custom-field-type"
          >
            {CUSTOM_FIELD_TYPES.map((t) => (
              <option key={t} value={t}>
                {FIELD_TYPE_WORDS[t]}
              </option>
            ))}
          </Select>
        </Field>
        {listed ? (
          <Field label="Its fields" hint="Names, separated by commas">
            <TextInput
              value={parts}
              onChange={(e) => setParts(e.target.value)}
              data-testid="ops-custom-field-parts"
            />
          </Field>
        ) : null}
        {type === "record" ? (
          <Field label="Links to">
            <Select
              value={linkTo}
              onChange={(e) => setLinkTo(e.target.value)}
              data-testid="ops-custom-field-link"
            >
              {recordTypes.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </Select>
          </Field>
        ) : null}
        <Field label="What it means" hint="One line" className="sm:col-span-2">
          <TextInput
            value={about}
            maxLength={200}
            onChange={(e) => setAbout(e.target.value)}
            data-testid="ops-custom-field-about"
          />
        </Field>
        <Field label="For">
          <Select
            value={shared ? "shared" : "client"}
            onChange={(e) => setShared(e.target.value === "shared")}
            data-testid="ops-custom-field-scope"
          >
            <option value="client">This client only</option>
            <option value="shared">Every client</option>
          </Select>
        </Field>
        <label className="flex items-center gap-2 self-end pb-2 text-sm text-ink">
          <input
            type="checkbox"
            className="size-4 accent-slate"
            checked={required}
            onChange={(e) => setRequired(e.target.checked)}
            data-testid="ops-custom-field-required"
          />
          Required on every new record
        </label>
      </div>
      {problem ? (
        <p role="alert" className="ds-error mt-3 text-sm" data-testid="ops-custom-field-error">
          {problem}
        </p>
      ) : null}
      <div className="mt-4">
        <Button
          variant="primary"
          disabled={busy || !label.trim() || (listed && !parts.trim())}
          onClick={() => void add()}
          data-testid="ops-custom-field-save"
        >
          Add field
        </Button>
      </div>
    </Card>
  );
}
