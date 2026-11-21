// docs/plan.md §1.164 step 3 ("Zoho's fields"): in a Zoho CRM connection's settings, the fields its
// sync reads beyond the standard ones, chosen from the client's own Zoho fields (read from Zoho,
// kept a day). Choosing changes the connection's setup draft (`config.syncFields`); the connection
// editor's footer previews and sends it like any setup change: tighter applies, anything looser
// goes to the client to approve (Connectors C4).
import type { ZohoFieldsView, ZohoFieldView } from "@countersign/core";
import { useState } from "react";
import { apiRoutes } from "../../api/routes";
import { useApi, useApiClient } from "../../api/useApi";
import { shortTime } from "../../runs/format";
import { Button, ErrorNotice, Loading, SectionLabel, Tag } from "../../ui/primitives";

type SyncFields = Record<string, string[]>;

/** The draft's `syncFields`, read loosely (the server checks the shape). */
export function syncFieldsOf(config: Record<string, unknown>): SyncFields {
  const raw = config.syncFields;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: SyncFields = {};
  for (const [m, v] of Object.entries(raw as Record<string, unknown>)) {
    if (Array.isArray(v)) out[m] = v.filter((x): x is string => typeof x === "string");
  }
  return out;
}

/** The config with one field turned on or off for a module's sync. */
export function toggleSyncField(
  config: Record<string, unknown>,
  module: string,
  apiName: string,
  on: boolean,
): Record<string, unknown> {
  const fields = syncFieldsOf(config);
  const current = fields[module] ?? [];
  const next = on ? [...new Set([...current, apiName])] : current.filter((f) => f !== apiName);
  const rest = { ...fields };
  if (next.length > 0) rest[module] = next;
  else delete rest[module];
  const out = { ...config };
  if (Object.keys(rest).length > 0) out.syncFields = rest;
  else delete out.syncFields;
  return out;
}

/** What a field is, in a few words: "Picklist, custom", "Date". */
function typeWords(f: ZohoFieldView): string {
  const kind = f.dataType.charAt(0).toUpperCase() + f.dataType.slice(1);
  return [kind, f.custom ? "custom" : null, f.readOnly ? "read-only" : null]
    .filter(Boolean)
    .join(", ");
}

export function ZohoSyncFields({
  clientId,
  clientName,
  connectionId,
  config,
  onConfig,
}: {
  clientId: string;
  clientName: string;
  connectionId: string;
  /** The setup as drafted (or saved). */
  config: Record<string, unknown>;
  onConfig(next: Record<string, unknown>): void;
}) {
  const api = useApiClient();
  const params = { id: clientId, connectionId };
  const { data, error, loading, reload } = useApi(apiRoutes.opsZohoFields, { params });
  const [reading, setReading] = useState(false);
  const [readError, setReadError] = useState<unknown>(null);
  const testId = `ops-zoho-fields-${connectionId}`;

  async function readAgain() {
    setReading(true);
    setReadError(null);
    try {
      await api.call(apiRoutes.opsZohoFields, { params, query: { refresh: "true" } });
      reload();
    } catch (e) {
      setReadError(e);
    } finally {
      setReading(false);
    }
  }

  const chosen = syncFieldsOf(config);
  return (
    <section data-testid={testId}>
      <SectionLabel
        action={
          <Button
            size="sm"
            variant="ghost"
            data-testid={`${testId}-refresh`}
            disabled={reading}
            onClick={() => void readAgain()}
          >
            {reading ? "Reading…" : "Read the fields again"}
          </Button>
        }
      >
        Fields we sync
      </SectionLabel>
      {loading && !data ? <Loading /> : null}
      {error && !data ? <ErrorNotice error={error} onRetry={reload} /> : null}
      {readError ? <ErrorNotice error={readError} /> : null}
      {data ? (
        <ZohoFieldsBody
          data={data}
          clientName={clientName}
          chosen={chosen}
          testId={testId}
          onToggle={(module, apiName, on) => onConfig(toggleSyncField(config, module, apiName, on))}
        />
      ) : null}
    </section>
  );
}

function ZohoFieldsBody({
  data,
  clientName,
  chosen,
  testId,
  onToggle,
}: {
  data: ZohoFieldsView;
  clientName: string;
  chosen: SyncFields;
  testId: string;
  onToggle(module: string, apiName: string, on: boolean): void;
}) {
  if (data.status === "needs_sign_in") {
    return (
      <p className="text-sm text-ink" data-testid={`${testId}-sign-in`}>
        This sign-in can't read Zoho's fields. {clientName} needs to sign in to Zoho again; until
        then we sync the standard fields only.
      </p>
    );
  }
  if (data.status === "not_read") {
    return (
      <p className="text-sm text-ink-muted" data-testid={`${testId}-not-read`}>
        We haven't read this Zoho's fields yet.
      </p>
    );
  }
  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-ink-muted">
        We sync the standard fields of each module. Add the ones your matches use
        {data.readAt ? ` (read ${shortTime(data.readAt)})` : ""}.
      </p>
      {data.modules.map((m) => {
        const extra = m.fields.filter((f) => !m.standard.includes(f.apiName));
        const on = new Set(chosen[m.module] ?? []);
        const full = on.size >= m.room;
        return (
          <div key={m.module} data-testid={`${testId}-${m.module}`}>
            <p className="text-sm font-medium text-ink">
              {m.module}
              <span className="ml-2 font-normal text-ink-muted">
                {on.size} of {m.room} added
              </span>
            </p>
            {extra.length === 0 ? (
              <p className="text-sm text-ink-muted">No other fields.</p>
            ) : (
              <ul className="mt-1 grid gap-1 sm:grid-cols-2">
                {extra.map((f) => (
                  <li key={f.apiName}>
                    <label className="flex items-center gap-2 text-sm text-ink">
                      <input
                        type="checkbox"
                        className="size-4 accent-slate"
                        data-testid={`${testId}-${m.module}-${f.apiName}`}
                        checked={on.has(f.apiName)}
                        disabled={full && !on.has(f.apiName)}
                        onChange={(e) => onToggle(m.module, f.apiName, e.target.checked)}
                      />
                      <span>{f.label}</span>
                      <span className="text-ink-muted">{f.apiName}</span>
                      {f.custom ? <Tag>{typeWords(f)}</Tag> : null}
                    </label>
                  </li>
                ))}
              </ul>
            )}
          </div>
        );
      })}
    </div>
  );
}
