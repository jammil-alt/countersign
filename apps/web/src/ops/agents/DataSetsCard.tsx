// An agent's data sets (docs/step-model-plan.md §10f): named groups of record types it may read,
// create and change in our own records, across areas, each turned on or off for this agent.
// Saved with the agent's version and published like any change; nothing is granted by default.
// What a set grants is what the builder's Uses picker offers (Find, Get by id, Create, Update), and
// the gate refuses anything else at run time. Writing into another area is shown here, and what this
// draft grants beyond the version it was opened on is listed, so a widened grant is never missed.
import {
  type AgentData,
  crossAreaWrites,
  type DataSet,
  type RecordGrant,
  type RecordType,
  recordTypeAllows,
  widenedRecordGrants,
} from "@countersign/core";
import { useState } from "react";
import { apiRoutes } from "../../api/routes";
import { useApi } from "../../api/useApi";
import { Badge, Button, Card, SectionLabel } from "../../ui/primitives";
import { Field, TextInput } from "./ui";

const ACCESS = [
  ["read", "Read", "get"],
  ["create", "Create", "create"],
  ["update", "Change", "update"],
] as const;

/** "Margin and ROI" → "margin-and-roi", unique among the agent's sets. */
export function dataSetId(name: string, taken: readonly string[]): string {
  const base =
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "data-set";
  let id = base;
  for (let i = 2; taken.includes(id); i++) id = `${base}-${i}`;
  return id;
}

export function DataSetsCard({
  value,
  opened,
  area,
  onChange,
}: {
  value: AgentData | undefined;
  /** The data access of the version the editor was opened on. */
  opened: AgentData | undefined;
  /** The agent's own area: writes elsewhere are listed. */
  area: string;
  onChange(next: AgentData): void;
}) {
  const state = useApi(apiRoutes.opsRecordTypes, { query: {} });
  const types = state.data?.recordTypes ?? [];
  const data: AgentData = value ?? { grants: [], sets: [] };
  const [name, setName] = useState("");

  const setSet = (i: number, next: DataSet | null) =>
    onChange({
      ...data,
      sets: next
        ? data.sets.map((s, k) => (k === i ? next : s))
        : data.sets.filter((_, k) => k !== i),
    });

  const add = () => {
    const first = types[0];
    if (!name.trim() || !first) return;
    onChange({
      ...data,
      sets: [
        ...data.sets,
        {
          id: dataSetId(
            name,
            data.sets.map((s) => s.id),
          ),
          name: name.trim(),
          on: true,
          grants: [{ recordType: first.id, read: true, create: false, update: false }],
        },
      ],
    });
    setName("");
  };

  const elsewhere = crossAreaWrites(data, area, types);
  const widened = widenedRecordGrants(opened, data);

  return (
    <Card className="p-5" testId="agent-editor-data">
      <SectionLabel>Data sets</SectionLabel>
      <p className="mb-4 text-sm text-ink-muted">
        What it may read, create and change in our own records, by record type. Nothing is granted
        until a set is on. Saves to our records need no approval from the client and are always
        logged with their evidence.
      </p>
      <div className="flex flex-col gap-4">
        {data.sets.map((set, i) => (
          <DataSetRow key={set.id} set={set} types={types} onChange={(next) => setSet(i, next)} />
        ))}
        {data.grants.length > 0 ? (
          <p className="text-sm text-ink-muted" data-testid="agent-editor-data-own">
            Also granted to this agent alone:{" "}
            {data.grants.map((g) => grantWords(g, types)).join("; ")}.
          </p>
        ) : null}
        <div className="flex flex-wrap items-end gap-3">
          <Field label="New data set" className="min-w-0 flex-1">
            <TextInput
              data-testid="agent-editor-data-name"
              placeholder="Margin and ROI"
              maxLength={60}
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </Field>
          <Button
            variant="secondary"
            disabled={!name.trim() || types.length === 0}
            onClick={add}
            data-testid="agent-editor-data-add"
          >
            Add data set
          </Button>
        </div>
        {elsewhere.length > 0 ? (
          <p className="text-sm text-ink" data-testid="agent-editor-data-elsewhere">
            <Badge tone="neutral">Another area</Badge> It may write to{" "}
            {elsewhere.map((w) => `${typeName(w.recordType, types)} (${w.area})`).join(", ")}.
          </p>
        ) : null}
        {widened.length > 0 ? (
          <p className="text-sm text-ink" data-testid="agent-editor-data-widened">
            This draft grants more than the version it came from: {widened.join(", ")}.
          </p>
        ) : null}
      </div>
    </Card>
  );
}

function typeName(id: string, types: readonly RecordType[]): string {
  return types.find((t) => t.id === id)?.plural.toLowerCase() ?? id;
}

function grantWords(g: RecordGrant, types: readonly RecordType[]): string {
  const what = ACCESS.filter(([k]) => g[k]).map(([, label]) => label.toLowerCase());
  return `${what.join(", ") || "nothing"} ${typeName(g.recordType, types)}`;
}

function DataSetRow({
  set,
  types,
  onChange,
}: {
  set: DataSet;
  types: readonly RecordType[];
  onChange(next: DataSet | null): void;
}) {
  const testId = `agent-editor-data-set-${set.id}`;
  const byId = new Map(set.grants.map((g) => [g.recordType, g]));
  const toggle = (type: RecordType, key: (typeof ACCESS)[number][0], on: boolean) => {
    const cur = byId.get(type.id) ?? {
      recordType: type.id,
      read: false,
      create: false,
      update: false,
    };
    const next = { ...cur, [key]: on };
    // Writing needs reading what is written.
    if (on && key !== "read") next.read = true;
    if (!on && key === "read") {
      next.create = false;
      next.update = false;
    }
    const grants = types
      .map((t) => (t.id === type.id ? next : byId.get(t.id)))
      .filter((g): g is RecordGrant => g !== undefined && (g.read || g.create || g.update));
    if (grants.length === 0) return;
    onChange({ ...set, grants });
  };
  return (
    <div className="rounded-md border border-line p-4" data-testid={testId}>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <span className="font-medium text-ink">{set.name}</span>
        <div className="flex items-center gap-2">
          <Badge tone={set.on ? "positive" : "neutral"} testId={`${testId}-state`}>
            {set.on ? "On" : "Off"}
          </Badge>
          <Button
            variant="secondary"
            onClick={() => onChange({ ...set, on: !set.on })}
            data-testid={`${testId}-toggle`}
          >
            {set.on ? "Turn off" : "Turn on"}
          </Button>
          <Button
            variant="secondary"
            onClick={() => onChange(null)}
            data-testid={`${testId}-remove`}
          >
            Remove
          </Button>
        </div>
      </div>
      <div className="dt dt-ana overflow-x-auto">
        <table>
          <thead>
            <tr className="dt-cols">
              <th>Record type</th>
              {ACCESS.map(([k, label]) => (
                <th key={k}>{label}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {types.map((t) => {
              const g = byId.get(t.id);
              return (
                <tr key={t.id}>
                  <td>
                    {t.plural} <span className="text-sm text-ink-muted">{t.area}</span>
                  </td>
                  {ACCESS.map(([k, label, op]) => {
                    const allowed = op === "get" || recordTypeAllows(t, op);
                    return (
                      <td key={k}>
                        <input
                          type="checkbox"
                          className="size-4 accent-slate"
                          aria-label={`${label} ${t.plural.toLowerCase()} in ${set.name}`}
                          disabled={!allowed}
                          checked={allowed && g?.[k] === true}
                          onChange={(e) => toggle(t, k, e.target.checked)}
                          data-testid={`${testId}-${t.id}-${k}`}
                        />
                      </td>
                    );
                  })}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
