// Names for the ids an approval card would show bare (a bill line's account or item: "#20"), when
// the change's before state leaves them unnamed: read from the connection's synced records, where
// the connector says a record names them (`Connector.syncedNames`). The portal's inbox adds them to
// each item's view (core ChangeDisplayView `names`); a client never reads a bare id on a card.
import { changeValue, isPlainObject, type ToolDisplay } from "@countersign/core";
import { rawRecord, type Tx } from "@countersign/db";
import { and, desc, eq, sql } from "drizzle-orm";
import { changeDisplay } from "./change-display";
import type { Platform } from "./platform";

type Registries = Pick<Platform, "tools" | "connectors">;
type Names = Record<string, Record<string, string>>;

const NAME_KEYS = ["name", "displayName", "title", "label"] as const;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** At most this many record lookups per response, so a long done list never slows the Desk. */
const MAX_LOOKUPS = 40;

function idText(v: unknown): string | null {
  if (typeof v === "string" && v.length > 0) return v;
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  return null;
}

function namesAt(v: unknown): Names {
  if (!isPlainObject(v)) return {};
  return Object.fromEntries(
    Object.entries(v)
      .filter((e): e is [string, Record<string, unknown>] => isPlainObject(e[1]))
      .map(([list, map]) => [
        list,
        Object.fromEntries(
          Object.entries(map).filter((e): e is [string, string] => typeof e[1] === "string"),
        ),
      ]),
  );
}

function hasName(v: unknown): boolean {
  return isPlainObject(v) && NAME_KEYS.some((k) => typeof v[k] === "string" && v[k] !== "");
}

/**
 * The ids a display's lists book lines to through a `names` list that neither the line nor the
 * before state names, by list: `{ accounts: {"20"} }`. A line an earlier ref names (its item or
 * account by name, or an id the before state names) needs nothing.
 */
export function unnamedIds(
  display: ToolDisplay,
  before: unknown,
  inputs: readonly unknown[],
): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  const known = namesAt(changeValue({ before, input: null }, display.names));
  for (const input of inputs) {
    const ctx = { before, input };
    for (const field of display.fields) {
      const refs = field.columns?.refs ?? [];
      if (refs.length === 0) continue;
      for (const path of [field.now, field.after]) {
        const raw = changeValue(ctx, path);
        const lines = Array.isArray(raw) ? raw : raw === undefined || raw === null ? [] : [raw];
        for (const line of lines) {
          if (!isPlainObject(line)) continue;
          const missing: [string, string][] = [];
          let named = false;
          for (const r of refs) {
            const v: unknown = line[r.key];
            if (hasName(v)) {
              named = true;
              break;
            }
            const id = isPlainObject(v) ? idText(v.id) : idText(v);
            if (id === null || r.names === undefined) continue;
            if (known[r.names]?.[id] !== undefined) {
              named = true;
              break;
            }
            missing.push([r.names, id]);
          }
          if (named) continue;
          for (const [list, id] of missing) {
            const set = out.get(list) ?? new Set<string>();
            set.add(id);
            out.set(list, set);
          }
        }
      }
    }
  }
  return out;
}

/**
 * Names from the connection's synced records for the ids each external action's card would show
 * bare, by inbox item id. An id no synced record names stays unnamed.
 */
// DECISION: the lookup runs when a response is built (nothing stored, no migration), only for ids
// the before state leaves unnamed, newest synced record first, at most MAX_LOOKUPS per response.
export async function syncedRefNames(
  tx: Tx,
  platform: Registries,
  rows: readonly { id: string; tenantId: string; kind: string; payload: unknown }[],
): Promise<Map<string, Names>> {
  const out = new Map<string, Names>();
  const cache = new Map<string, string | null>();
  let lookups = 0;
  for (const row of rows) {
    if (row.kind !== "external_action" || !isPlainObject(row.payload)) continue;
    const p = row.payload;
    const tool = changeDisplay(platform, p.tool)?.tool;
    const connectionId = typeof p.connectionId === "string" ? p.connectionId : null;
    if (!tool?.names || !connectionId || !UUID.test(connectionId)) continue;
    const connectorId =
      platform.tools.get(p.tool as string)?.spec.connector ?? String(p.tool).split(".")[0] ?? "";
    const connector = platform.connectors.get(connectorId);
    if (!connector?.syncedNames) continue;
    const edited = isPlainObject(p.edited) ? p.edited.input : undefined;
    const want = unnamedIds(tool, p.before, edited === undefined ? [p.input] : [p.input, edited]);
    const found = new Map<string, Map<string, string>>();
    for (const [list, ids] of want) {
      for (const id of ids) {
        const key = `${row.tenantId}|${connectionId}|${list}|${id}`;
        if (!cache.has(key)) {
          let name: string | null = null;
          for (const look of connector.syncedNames(list, id)) {
            if (lookups >= MAX_LOOKUPS) break;
            lookups += 1;
            const [hit] = await tx
              .select({ payload: rawRecord.payload })
              .from(rawRecord)
              .where(
                and(
                  eq(rawRecord.tenantId, row.tenantId),
                  eq(rawRecord.connectionId, connectionId),
                  eq(rawRecord.entityType, look.entityType),
                  eq(rawRecord.isDeleted, false),
                  sql`${rawRecord.payload} @> ${JSON.stringify(look.contains)}::jsonb`,
                ),
              )
              .orderBy(desc(rawRecord.syncedAt))
              .limit(1);
            name = hit ? look.name(hit.payload) : null;
            if (name !== null) break;
          }
          cache.set(key, name);
        }
        const name = cache.get(key);
        if (name) found.set(list, (found.get(list) ?? new Map()).set(id, name));
      }
    }
    if (found.size > 0) {
      out.set(
        row.id,
        Object.fromEntries([...found].map(([list, m]) => [list, Object.fromEntries(m)])),
      );
    }
  }
  return out;
}
