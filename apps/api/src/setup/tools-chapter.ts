// Getting started's Your tools (docs/setup-plan.md §5; docs/plan.md §1.206, SU3): each tool the
// agents being set up need, from their setup checklists' connect items and the tools their
// versions use (Connectors C1's needs, the same ones the Connectors pages read); whether it is
// connected and to which account; what the agents read and change there and what they never do,
// in plain words; the account check; who was asked to connect it; and for QuickBooks the first
// look, counted by code from the synced records (never a model). Connecting is the connector's own
// page (Connectors C5): there is no second place to connect. Every query runs in the caller's
// transaction, scoped to the client (invariant 1), and filters by `tenant_id` besides. Nothing
// here carries a credential, a bundle, a prompt or a cost (invariants 11, 13).

import type { RegistryContext } from "@countersign/agents";
import {
  bindingConnector,
  type ConnectorNeed,
  connectionLabel,
  entityWords,
  FINGERPRINT_KEY,
  type FirstLookLine,
  QBO_CONNECTOR_ID,
  readTenantGuide,
  type SetupLeft,
  type SetupTool,
  type SetupWho,
  type StoredToolGuide,
  type ToolConfirmBody,
  type ToolsChapterView,
} from "@countersign/core";
import {
  agent,
  appUser,
  connection,
  inboxItem,
  membership,
  rawRecord,
  type Tx,
  tenant,
} from "@countersign/db";
import { and, eq, inArray, type SQL, sql } from "drizzle-orm";
import { bundleNeeds, connectorName, needLabel } from "../connector-access/service";
import { HttpError, notFound } from "../http";
import { PERSONAL_CONNECTORS } from "../routes/portal";
import { agentSetupView, checklistOf, shownVersion } from "./checklist";
import { setupAgents } from "./overview";

type AgentRow = typeof agent.$inferSelect;
type ConnectionRow = typeof connection.$inferSelect;
/** The registries the words and needs are read from: the tools, and the skills when there are. */
type Registry = Pick<RegistryContext, "tools"> & Partial<Pick<RegistryContext, "catalog">>;

/** An ask's inbox item (`inbox_item.subject_type`): "Dana asked you to connect Gmail". */
export const SETUP_TOOL_ASK_SUBJECT = "setup_tool_ask";

export interface ToolsInput {
  tenantId: string;
  userId: string;
  /** The agents this person sees; null for every agent. */
  agents: readonly string[] | null;
  canEdit: boolean;
  /** The platform's registries (`services.platform.ctx`). */
  registry: Registry;
}

// ── What the agents need ─────────────────────────────────────────────────────────────────────

/** One tool, gathered across the agents being set up. */
interface Gathered {
  connector: string;
  agents: AgentRow[];
  needs: ConnectorNeed[];
}

/**
 * Each tool the agents need, in the order they first name it: a connect item of the setup
 * checklist, or a need of the version's steps (Connectors C1's `agentNeeds`, through
 * `bundleNeeds`, as the Connectors pages read them).
 */
// DECISION: a write that can go through one of several tools (an action without `via`, core's
// `anyOf`) needs only one of them: the one the agent is bound to, else one the client already has
// a connection of, else the first. So an email step doesn't list Gmail and Outlook both.
async function gather(
  tx: Tx,
  tenantId: string,
  rows: readonly AgentRow[],
  registry: Registry,
  connections: readonly ConnectionRow[],
): Promise<Gathered[]> {
  const out = new Map<string, Gathered>();
  const add = (connector: string, row: AgentRow, need?: ConnectorNeed) => {
    let g = out.get(connector);
    if (!g) {
      g = { connector, agents: [], needs: [] };
      out.set(connector, g);
    }
    if (!g.agents.some((a) => a.id === row.id)) g.agents.push(row);
    if (need) g.needs.push(need);
  };
  const had = new Set(connections.map((c) => c.connector));
  for (const row of rows) {
    const v = await shownVersion(tx, row);
    for (const item of checklistOf(v?.bundle)) {
      if (item.kind === "connect" && item.connector) add(item.connector, row);
    }
    if (!registry.catalog || !v) continue;
    const needs = await bundleNeeds(tx, tenantId, v.bundle, {
      tools: registry.tools,
      catalog: registry.catalog,
    });
    const bound = new Set(Object.keys(row.bindings).map(bindingConnector));
    const groups = new Map<string, ConnectorNeed[]>();
    for (const n of needs) {
      if (!n.anyOf) {
        add(n.connector, row, n);
        continue;
      }
      groups.set(n.anyOf, [...(groups.get(n.anyOf) ?? []), n]);
    }
    for (const group of groups.values()) {
      const pick =
        group.find((n) => bound.has(n.connector)) ??
        group.find((n) => had.has(n.connector)) ??
        group[0];
      if (pick)
        for (const n of group.filter((x) => x.connector === pick.connector))
          add(pick.connector, row, n);
    }
  }
  return [...out.values()];
}

/** A connection a client can work through: connected, or waiting where there is nothing to sign in to. */
function usable(row: ConnectionRow, registry: Registry): boolean {
  return (
    row.status === "connected" ||
    (row.status === "pending" &&
      registry.tools.connectors.get(row.connector)?.manifest.auth === "none")
  );
}

/** The connection a tool goes through: the one an agent is bound to, else the client's best. */
function connectionOf(
  g: Gathered,
  connections: readonly ConnectionRow[],
  registry: Registry,
): ConnectionRow | null {
  const ofKind = connections.filter((c) => c.connector === g.connector);
  for (const row of g.agents) {
    for (const [key, id] of Object.entries(row.bindings)) {
      if (bindingConnector(key) !== g.connector) continue;
      const bound = ofKind.find((c) => c.id === id);
      if (bound) return bound;
    }
  }
  const ranked = [...ofKind].sort(
    (a, b) =>
      Number(usable(b, registry)) - Number(usable(a, registry)) ||
      b.createdAt.getTime() - a.createdAt.getTime(),
  );
  return ranked[0] ?? null;
}

// ── Words ────────────────────────────────────────────────────────────────────────────────────

const uniq = (xs: readonly string[]) => [...new Set(xs)];

/**
 * What the agents read and change in a tool, and what they never do, in the client's words: the
 * record types they read ("Bills"); each change they may make, which asks first ("Create bills
 * (asks you first)"); never delete, never pay or move money, never anything else.
 */
// DECISION: every change reads "(asks you first)". During setup no agent has started its trial,
// and every write step starts with approval on (invariant 8); what the client later lets run on
// its own is the connection's access, which the card links to rather than restating.
// DECISION: "never" is the same three lines for every tool: delete is off on every connection, no
// tool of ours pays or moves money, and an agent has no tool for anything not listed. It names no
// record type the agents don't touch, so the card stays short.
export function toolWords(
  registry: Registry,
  connector: string,
  needs: readonly ConnectorNeed[],
): Pick<SetupTool, "reads" | "changes" | "never"> {
  const platform = { connectors: registry.tools.connectors };
  const declared = registry.tools.connectors.get(connector)?.manifest.permissionEntities;
  const name = connectorName(platform, connector);
  const reads = uniq(
    needs
      .filter((n) => n.verb === "read")
      .map((n) =>
        n.entity ? entityWords(n.entity, declared) : `What the agents look up in ${name}`,
      ),
  );
  const changes = uniq(
    needs
      .filter((n) => n.verb === "create" || n.verb === "update")
      .map((n) => `${needLabel(platform, n)} (asks you first)`),
  );
  const never = [
    "Delete anything",
    "Pay or move money",
    changes.length > 0 ? "Change anything not listed here" : "Change anything",
  ];
  return { reads, changes, never };
}

// ── The first look (QuickBooks) ──────────────────────────────────────────────────────────────

const DAY = 86_400_000;
/** The first look's window: bills a month over the last three months. */
const LOOK_DAYS = 91;

function namesList(names: readonly string[]): string {
  if (names.length <= 1) return names.join("");
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/**
 * What we see in QuickBooks, counted by code from the latest version of each synced record (never
 * a model): its active vendors, bills a month over the last three months, and the three vendors
 * with the most bills then. Null before the first sync.
 */
// DECISION: the latest raw record of each vendor and bill (by when it was synced, then a deletion,
// then the higher SyncToken, which QuickBooks raises on every change; a deleted one counts as gone); a
// vendor is active unless QuickBooks says `Active: false`; a bill counts by its `TxnDate`, so the
// window is the bills' own dates, not when we synced them; "a month" is the window's count over
// three, rounded; the top vendors are by bills in the same window, by `VendorRef`'s name, ties by
// name. A line with nothing to say (no bills) is left out.
export async function firstLook(
  tx: Tx,
  input: { tenantId: string; connection: ConnectionRow; now: Date },
): Promise<Omit<FirstLookLine, "confirmed">[] | null> {
  const c = input.connection;
  if (c.connector !== QBO_CONNECTOR_ID || c.status !== "connected" || !c.lastSyncAt) return null;
  const since = new Date(input.now.getTime() - LOOK_DAYS * DAY).toISOString().slice(0, 10);
  const latest = sql`(
    select distinct on (${rawRecord.entityType}, ${rawRecord.externalId})
      ${rawRecord.entityType} as entity_type, ${rawRecord.payload} as payload,
      ${rawRecord.isDeleted} as is_deleted
    from ${rawRecord}
    where ${rawRecord.tenantId} = ${input.tenantId}
      and ${rawRecord.connectionId} = ${c.id}
      and ${rawRecord.entityType} in ('Vendor', 'Bill')
    order by ${rawRecord.entityType}, ${rawRecord.externalId}, ${rawRecord.syncedAt} desc,
      ${rawRecord.isDeleted} desc,
      (case when ${rawRecord.externalVersion} ~ '^[0-9]{1,18}$'
        then ${rawRecord.externalVersion}::bigint end) desc nulls last,
      ${rawRecord.id} desc
  )`;
  const [counts] = await tx.execute<{ vendors: number; bills: number }>(sql`
    select
      count(*) filter (where entity_type = 'Vendor' and not is_deleted
        and coalesce(payload->>'Active', 'true') <> 'false')::int as vendors,
      count(*) filter (where entity_type = 'Bill' and not is_deleted
        and payload->>'TxnDate' >= ${since})::int as bills
    from ${latest} as latest`);
  const top = await tx.execute<{ name: string; n: number }>(sql`
    select coalesce(payload->'VendorRef'->>'name', '') as name, count(*)::int as n
    from ${latest} as latest
    where entity_type = 'Bill' and not is_deleted and payload->>'TxnDate' >= ${since}
      and coalesce(payload->'VendorRef'->>'name', '') <> ''
    group by 1
    order by n desc, name
    limit 3`);
  const vendors = Number(counts?.vendors ?? 0);
  const bills = Number(counts?.bills ?? 0);
  const lines: Omit<FirstLookLine, "confirmed">[] = [
    { key: "vendors", text: vendors === 1 ? "1 active vendor." : `${vendors} active vendors.` },
  ];
  if (bills > 0) {
    const month = Math.max(1, Math.round(bills / 3));
    lines.push({
      key: "bills_month",
      text: `About ${month} ${month === 1 ? "bill" : "bills"} a month over the last three months.`,
    });
  }
  const names = [...top].map((r) => r.name.slice(0, 100));
  if (names.length > 0) {
    lines.push({
      key: "top_vendors",
      text:
        names.length === 1
          ? `Most bills come from ${names[0]}.`
          : `Most bills come from ${namesList(names)}.`,
    });
  }
  return lines;
}

// ── The chapter ──────────────────────────────────────────────────────────────────────────────

async function guideOf(tx: Tx, tenantId: string) {
  const [row] = await tx
    .select({ settings: tenant.settings })
    .from(tenant)
    .where(eq(tenant.id, tenantId));
  return readTenantGuide(row?.settings);
}

async function whoIs(tx: Tx, tenantId: string, userId: string, meId: string): Promise<SetupWho> {
  const [u] = await tx
    .select({ name: appUser.name, email: appUser.email })
    .from(membership)
    .innerJoin(appUser, eq(appUser.id, membership.userId))
    .where(and(eq(membership.tenantId, tenantId), eq(membership.userId, userId)));
  return { userId, name: u?.name?.trim() || u?.email || "Someone", me: userId === meId };
}

/** Each tool with what the chapter shows, before words about the reader. */
async function toolsOf(
  tx: Tx,
  input: Pick<ToolsInput, "tenantId" | "agents" | "registry">,
  rows?: readonly AgentRow[],
) {
  const agents = rows ?? (await setupAgents(tx, input.tenantId, input.agents));
  if (agents.length === 0) return [];
  const connections = await tx
    .select()
    .from(connection)
    .where(eq(connection.tenantId, input.tenantId))
    .orderBy(connection.createdAt);
  const gathered = await gather(tx, input.tenantId, agents, input.registry, connections);
  return gathered.map((g) => {
    const conn = connectionOf(g, connections, input.registry);
    return { ...g, connection: conn, connected: conn !== null && usable(conn, input.registry) };
  });
}

/** Each tool the agents being set up need, connected or not, with what they do there. */
export async function toolsChapter(tx: Tx, input: ToolsInput): Promise<ToolsChapterView> {
  const tools = await toolsOf(tx, input);
  const guide = await guideOf(tx, input.tenantId);
  const now = new Date();
  const out: SetupTool[] = [];
  for (const t of tools) {
    const stored: StoredToolGuide = guide.tools?.[t.connector] ?? {};
    const account =
      t.connected && t.connection
        ? connectionLabel(t.connection.config, t.connection.externalAccountId)
        : null;
    const look =
      t.connected && t.connection
        ? await firstLook(tx, { tenantId: input.tenantId, connection: t.connection, now })
        : null;
    out.push({
      connector: t.connector,
      name: connectorName({ connectors: input.registry.tools.connectors }, t.connector),
      connected: t.connected,
      connectionId: t.connection?.id ?? null,
      account,
      // A confirm counts for the account it was said about: signing in to another company
      // asks again.
      accountConfirmed: account !== null && stored.account?.name === account,
      agents: t.agents.map((a) => ({ id: a.id, name: a.serviceName ?? a.name })),
      ...toolWords(input.registry, t.connector, t.needs),
      firstLook: look
        ? look.map((l) => ({ ...l, confirmed: stored.lines?.[l.key] !== undefined }))
        : null,
      askedOf:
        stored.askedOf && !t.connected
          ? await whoIs(tx, input.tenantId, stored.askedOf.userId, input.userId)
          : null,
    });
  }
  return { tools: out, canEdit: input.canEdit };
}

/** One tool of the chapter, or 404. */
async function toolIn(tx: Tx, input: ToolsInput & { connector: string }) {
  const tool = (await toolsOf(tx, input)).find((t) => t.connector === input.connector);
  if (!tool) throw notFound("tool");
  return tool;
}

/** Merges `patch` into `settings.setupGuide.tools[connector]`, in one statement. */
async function patchTool(
  tx: Tx,
  tenantId: string,
  connector: string,
  patch: (tool: SQL) => SQL,
): Promise<void> {
  const guide = sql`coalesce(${tenant.settings} -> 'setupGuide', '{}'::jsonb)`;
  const tools = sql`coalesce(${guide} -> 'tools', '{}'::jsonb)`;
  const tool = sql`coalesce(${tools} -> ${connector}::text, '{}'::jsonb)`;
  await tx
    .update(tenant)
    .set({
      settings: sql`jsonb_set(coalesce(${tenant.settings}, '{}'::jsonb), '{setupGuide}', ${guide} || jsonb_build_object('tools', ${tools} || jsonb_build_object(${connector}::text, ${tool} || ${patch(tool)})))`,
    })
    .where(eq(tenant.id, tenantId));
}

/** Yes to the account, or to one first-look line. */
// DECISION: the account's confirm keeps the account's name with it (`account.name`), so a later
// sign-in to a different company reads as not checked. A line's confirm keeps who and when only;
// filing it as a `seen` fact (cases-plan §4.6) is for when that store is built.
export async function confirmTool(
  tx: Tx,
  input: ToolsInput & { connector: string; body: ToolConfirmBody; name: string | null },
): Promise<void> {
  const tool = await toolIn(tx, input);
  const by = { by: input.userId, byName: input.name, at: new Date().toISOString() };
  if (!tool.connected || !tool.connection) {
    throw new HttpError(409, "not_connected", "Connect it first.");
  }
  if (input.body.what === "account") {
    const account = connectionLabel(tool.connection.config, tool.connection.externalAccountId);
    if (!account) {
      throw new HttpError(
        409,
        "no_account",
        "This tool doesn't say which account it signed in to.",
      );
    }
    const value = JSON.stringify({ account: { ...by, name: account } });
    await patchTool(tx, input.tenantId, input.connector, () => sql`${value}::jsonb`);
    return;
  }
  const key = input.body.key;
  const look = await firstLook(tx, {
    tenantId: input.tenantId,
    connection: tool.connection,
    now: new Date(),
  });
  if (!look?.some((l) => l.key === key)) throw notFound("line");
  const value = JSON.stringify({ [key]: by });
  await patchTool(
    tx,
    input.tenantId,
    input.connector,
    (t) =>
      sql`jsonb_build_object('lines', coalesce(${t} -> 'lines', '{}'::jsonb) || ${value}::jsonb)`,
  );
}

/**
 * Ask a colleague to connect a tool: just that card, as an item on their Desk (which the hourly
 * pass's "items waiting" email and phone notification already tell them about), and their name on
 * the tool's line in the overview.
 */
// DECISION: the intake's "Ask someone else" (`POST /api/intake/:id/ask`) adds a section of an
// open intake to the colleague's place on it and sends the intake's email; a tool is no intake
// section and may have no open intake, so the ask is a Desk item instead: a review closed with
// Done (it carries a fingerprint, as a supervisor's finding does), assigned to that person alone,
// with the steps in words. No new notification kind, so no migration. Asking again, of anyone,
// closes the earlier ask's item.
// DECISION: the person asked must be one who can connect it: the client admin for any tool, a
// client user only for their own account (Gmail, `PERSONAL_CONNECTORS`), as the sign-in allows.
export async function askToolOf(
  tx: Tx,
  input: ToolsInput & { connector: string; askUserId: string; name: string | null },
): Promise<void> {
  const tool = await toolIn(tx, input);
  if (tool.connected) throw new HttpError(409, "connected", "It's connected already.");
  if (input.askUserId === input.userId) {
    throw new HttpError(422, "yourself", "Ask someone other than yourself.");
  }
  const [m] = await tx
    .select({ role: membership.role, name: appUser.name, email: appUser.email })
    .from(membership)
    .innerJoin(appUser, eq(appUser.id, membership.userId))
    .where(and(eq(membership.tenantId, input.tenantId), eq(membership.userId, input.askUserId)));
  // The portal never learns who serves the client: an operator is "not found", as a stranger.
  if (!m || (m.role !== "client_admin" && m.role !== "client_user")) throw notFound("member");
  const name = connectorName({ connectors: input.registry.tools.connectors }, input.connector);
  if (m.role !== "client_admin" && !PERSONAL_CONNECTORS.has(input.connector)) {
    throw new HttpError(
      422,
      "cannot_connect",
      `Only an admin can connect ${name}. Make them an admin on Team, or connect it yourself.`,
    );
  }
  const at = new Date();
  const value = JSON.stringify({
    askedOf: {
      userId: input.askUserId,
      by: input.userId,
      byName: input.name,
      at: at.toISOString(),
    },
  });
  await patchTool(tx, input.tenantId, input.connector, () => sql`${value}::jsonb`);

  await tx
    .update(inboxItem)
    .set({ status: "resolved", resolvedAt: at, resolvedBy: input.userId })
    .where(
      and(
        eq(inboxItem.tenantId, input.tenantId),
        eq(inboxItem.subjectType, SETUP_TOOL_ASK_SUBJECT),
        eq(inboxItem.status, "open"),
        sql`${inboxItem.payload} ->> 'connector' = ${input.connector}`,
      ),
    );
  const asker = input.name ?? "Your admin";
  const agents = tool.agents.map((a) => a.serviceName ?? a.name);
  await tx.insert(inboxItem).values({
    tenantId: input.tenantId,
    kind: "review",
    subjectType: SETUP_TOOL_ASK_SUBJECT,
    subjectId: tool.connection?.id ?? null,
    assigneeUserId: input.askUserId,
    title: `${asker} asked you to connect ${name}`.slice(0, 200),
    payload: {
      [FINGERPRINT_KEY]: `${SETUP_TOOL_ASK_SUBJECT}:${input.connector}`,
      kind: SETUP_TOOL_ASK_SUBJECT,
      connector: input.connector,
      finding: {
        steps: [
          `Open Getting started, then Your tools.`,
          `Choose Connect on ${name} and sign in on ${name}'s own page. We never see your password.`,
          ...(agents.length ? [`It's for ${agents.join(", ")}.`] : []),
        ],
      },
    },
  });
}

/**
 * What tools still hold each agent (agent id → lines), for the overview: a tool not connected
 * ("Connect Gmail"), waiting on whoever was asked, else the client admin; and a connected one the
 * agent's checklist still holds (its access short of what it needs), in the checklist's words.
 */
// DECISION: the second kind keeps what the overview read from the checklist before TOOLS, so a
// connected tool that doesn't yet allow what the agent needs still shows as a line.
export async function toolsLeft(
  tx: Tx,
  input: {
    tenantId: string;
    agentIds: readonly string[];
    /** The person reading, for "you". */
    userId?: string;
    registry?: Registry;
  },
): Promise<Map<string, SetupLeft[]> | null> {
  if (!input.registry) return null;
  const registry = input.registry;
  const out = new Map<string, SetupLeft[]>(input.agentIds.map((id) => [id, []]));
  if (input.agentIds.length === 0) return out;
  const rows = await tx
    .select()
    .from(agent)
    .where(and(eq(agent.tenantId, input.tenantId), inArray(agent.id, [...input.agentIds])));
  const tools = await toolsOf(tx, { tenantId: input.tenantId, agents: null, registry }, rows);
  const guide = await guideOf(tx, input.tenantId);
  const meId = input.userId ?? "";
  const admins = await tx
    .select({ userId: membership.userId, name: appUser.name, email: appUser.email })
    .from(membership)
    .innerJoin(appUser, eq(appUser.id, membership.userId))
    .where(and(eq(membership.tenantId, input.tenantId), eq(membership.role, "client_admin")));
  const admin = admins.find((a) => a.userId === meId) ?? admins[0] ?? null;
  const adminWho: SetupWho | null = admin
    ? { userId: admin.userId, name: admin.name?.trim() || admin.email, me: admin.userId === meId }
    : null;
  const setups = new Map<string, Awaited<ReturnType<typeof agentSetupView>>>();
  for (const row of rows) setups.set(row.id, await agentSetupView(tx, row, registry));
  for (const t of tools) {
    const name = connectorName({ connectors: registry.tools.connectors }, t.connector);
    const asked = guide.tools?.[t.connector]?.askedOf;
    const who =
      !t.connected && asked ? await whoIs(tx, input.tenantId, asked.userId, meId) : adminWho;
    for (const row of t.agents) {
      const item = setups
        .get(row.id)
        ?.items.find(
          (i) => i.kind === "connect" && i.connector === t.connector && i.guards !== "live",
        );
      if (t.connected && (!item || item.done)) continue;
      out.get(row.id)?.push({
        key: `tool:${t.connector}`,
        chapter: "tools",
        label: !t.connected ? (item?.label ?? `Connect ${name}`) : (item?.label ?? name),
        who,
      });
    }
  }
  return out;
}
