// R8 (docs/plan.md §1.86, §9; ARCHITECTURE §10.14 "The Library and the client's settings"): the
// Library's read-only banks for the back office (contract: packages/core/src/api/library.ts).
// Processes are the templates and their versions, each workflow read as a v4 process: a stored v3
// workflow through `processes.fromWorkflowV3`, never rewritten (invariant 3). Tools and record
// types come from the registries; condition sets are derived from the processes, since nothing
// stores named ones yet. Every handler runs inside withOperator (the clients served), and only
// operators reach /api/ops (invariant 11).

import { convertLookup, listTemplates, SHARED_COPY_PREFIX } from "@countersign/agents";
import {
  isToolWrapper,
  type LibraryConditionSet,
  type LibraryConditionUse,
  type LibraryProcess,
  type LibraryProcessWorkflow,
  type LibraryRecordType,
  type LibraryTool,
  processes,
  RECORD_KINDS,
  routes,
  sha256Hex,
  type Workflow,
} from "@countersign/core";
import { agent, agentVersion, automation, automationVersion, skill } from "@countersign/db";
import { and, desc, eq, inArray, isNull, or } from "drizzle-orm";
import type { Hono } from "hono";
import { type AppEnv, type HandlerCtx, iso, mount } from "../http";
import type { Platform } from "../platform";

type Scope = Pick<HandlerCtx<never>, "tx" | "tenantIds">;

/** One process as the banks read it: its workflows as v4 processes. */
interface ReadProcess {
  kind: "template" | "automation";
  id: string;
  slug: string;
  name: string;
  version: number;
  workflows: { slug: string | null; process: Pick<processes.Process, "triggers" | "steps"> }[];
}

/** A stored bundle's workflows, each read as a v4 process; one that doesn't read is left out. */
function readWorkflows(
  bundle: unknown,
  lookup: processes.ConvertLookup,
): (Omit<LibraryProcessWorkflow, "triggers" | "steps" | "kinds" | "checks"> & {
  process: processes.Process;
})[] {
  const list = (bundle as { workflows?: unknown } | null)?.workflows;
  if (!Array.isArray(list)) return [];
  return list.flatMap((entry) => {
    const w = entry as { slug: string; name: string; enabled?: boolean; workflow: unknown };
    const stored = w.workflow as { schemaVersion?: number } | undefined;
    try {
      const process =
        stored?.schemaVersion === 4
          ? (stored as processes.Process)
          : processes.fromWorkflowV3(stored as Workflow, lookup);
      return [
        {
          slug: w.slug,
          name: w.name,
          enabled: w.enabled !== false,
          schemaVersion: stored?.schemaVersion === 4 ? (4 as const) : (3 as const),
          process,
        },
      ];
    } catch {
      // A version that no longer reads shows nothing here; its own page says why.
      return [];
    }
  });
}

/** A process's triggers, step counts by kind and the checks its steps carry. */
function workflowFacts(
  process: processes.Process,
): Pick<LibraryProcessWorkflow, "triggers" | "steps" | "kinds" | "checks"> {
  const kinds: Record<string, number> = {};
  const checks = { confer: 0, approval: 0, notify: 0 };
  const steps = processes.allSteps(process);
  for (const { step } of steps) {
    kinds[step.kind] = (kinds[step.kind] ?? 0) + 1;
    if (step.checks?.confer) checks.confer += 1;
    if (step.checks?.approval) checks.approval += 1;
    if (step.checks?.notify?.length) checks.notify += 1;
  }
  return {
    triggers: process.triggers.map((t) => ({
      id: t.id,
      kind: t.on.type,
      event: t.on.type === "event" ? t.on.event : null,
    })),
    steps: steps.length,
    kinds,
    checks,
  };
}

function storedSchemaVersion(bundle: unknown): 3 | 4 {
  const list = (bundle as { workflows?: unknown } | null)?.workflows;
  return Array.isArray(list) &&
    list.some((w) => (w as { workflow?: { schemaVersion?: number } }).workflow?.schemaVersion === 4)
    ? 4
    : 3;
}

/** The templates with their versions (newest first) and the client agents forked from them. */
async function templateProcesses(
  ctx: Scope,
  platform: Platform,
): Promise<{ items: LibraryProcess[]; read: ReadProcess[] }> {
  const templates = await listTemplates(ctx.tx);
  if (templates.length === 0) return { items: [], read: [] };
  const ids = templates.map((t) => t.id);
  const versions = await ctx.tx
    .select({
      id: agentVersion.id,
      agentId: agentVersion.agentId,
      version: agentVersion.version,
      status: agentVersion.status,
      changeNote: agentVersion.changeNote,
      createdAt: agentVersion.createdAt,
      bundle: agentVersion.bundle,
    })
    .from(agentVersion)
    .where(and(inArray(agentVersion.agentId, ids), isNull(agentVersion.tenantId)))
    .orderBy(desc(agentVersion.version));
  const forks =
    ctx.tenantIds.length > 0
      ? await ctx.tx
          .select({ templateId: agent.templateId })
          .from(agent)
          .where(
            and(
              inArray(agent.tenantId, [...ctx.tenantIds]),
              inArray(agent.templateId, ids),
              eq(agent.kind, "client"),
              eq(agent.testCopy, false),
              eq(agent.status, "active"),
            ),
          )
      : [];
  const lookup = convertLookup(platform.catalog, platform.tools);
  const items: LibraryProcess[] = [];
  const read: ReadProcess[] = [];
  for (const t of templates) {
    const mine = versions.filter((v) => v.agentId === t.id);
    const live = mine.find((v) => v.id === t.liveVersionId) ?? null;
    const shown = live ?? mine[0] ?? null;
    const workflows = shown ? readWorkflows(shown.bundle, lookup) : [];
    const mission = (shown?.bundle as { definition?: { identity?: { mission?: unknown } } } | null)
      ?.definition?.identity?.mission;
    items.push({
      id: t.id,
      slug: t.slug,
      name: t.name,
      description: typeof mission === "string" ? mission : "",
      liveVersion: live?.version ?? null,
      latestVersion: mine[0]?.version ?? null,
      shownVersion: shown?.version ?? null,
      workflows: workflows.map(({ process, ...w }) => ({ ...w, ...workflowFacts(process) })),
      versions: mine.map((v) => ({
        id: v.id,
        version: v.version,
        status: v.status,
        changeNote: v.changeNote,
        createdAt: iso(v.createdAt) as string,
        schemaVersion: storedSchemaVersion(v.bundle),
      })),
      usedBy: forks.filter((f) => f.templateId === t.id).length,
    });
    if (shown) {
      read.push({
        kind: "template",
        id: t.id,
        slug: t.slug,
        name: t.name,
        version: shown.version,
        workflows: workflows.map((w) => ({ slug: w.slug, process: w.process })),
      });
    }
  }
  return { items, read };
}

/** Shared automations and the served clients' own (never the clients' snapshot copies). */
async function automationRows(ctx: Scope) {
  const rows = (
    await ctx.tx
      .select()
      .from(automation)
      .where(
        ctx.tenantIds.length > 0
          ? or(isNull(automation.tenantId), inArray(automation.tenantId, [...ctx.tenantIds]))
          : isNull(automation.tenantId),
      )
  ).filter((r) => !r.slug.startsWith(SHARED_COPY_PREFIX) && r.status === "active");
  return rows;
}

/** Each automation's live, else latest, version, its steps read as v4. */
async function automationProcesses(ctx: Scope, platform: Platform): Promise<ReadProcess[]> {
  const rows = await automationRows(ctx);
  if (rows.length === 0) return [];
  const versions = await ctx.tx
    .select({
      id: automationVersion.id,
      automationId: automationVersion.automationId,
      version: automationVersion.version,
      definition: automationVersion.definition,
    })
    .from(automationVersion)
    .where(
      inArray(
        automationVersion.automationId,
        rows.map((r) => r.id),
      ),
    )
    .orderBy(desc(automationVersion.version));
  const lookup = convertLookup(platform.catalog, platform.tools);
  return rows.flatMap((r) => {
    const mine = versions.filter((v) => v.automationId === r.id);
    const shown = mine.find((v) => v.id === r.liveVersionId) ?? mine[0];
    if (!shown) return [];
    try {
      // An automation has no trigger of its own: a placeholder lets the converter read its steps.
      const steps = processes.fromWorkflowV3(
        {
          schemaVersion: 3,
          trigger: { id: "automation", on: { type: "manual", input: {} } },
          steps: shown.definition.steps,
        } as Workflow,
        lookup,
      ).steps;
      return [
        {
          kind: "automation" as const,
          id: r.id,
          slug: r.slug,
          name: r.name,
          version: shown.version,
          workflows: [{ slug: null, process: { triggers: [], steps } }],
        },
      ];
    } catch {
      return [];
    }
  });
}

/** Every condition the processes use, grouped where the same rules are used more than once. */
// DECISION (library): grouped by canonical JSON (`processes.conditionKey`), keyed by the first 16
// hex digits of its sha256, named by the first `if` path using it; the most used come first.
async function conditionSets(read: readonly ReadProcess[]): Promise<LibraryConditionSet[]> {
  const byKey = new Map<string, LibraryConditionSet & { canonical: string }>();
  for (const p of read) {
    for (const w of p.workflows) {
      for (const use of processes.conditionUses(w.process)) {
        const canonical = processes.conditionKey(use.when);
        const entry: LibraryConditionUse = {
          processKind: p.kind,
          processId: p.id,
          processSlug: p.slug,
          processName: p.name,
          version: p.version,
          workflow: w.slug,
          place: use.place,
          stepId: use.stepId,
          stepName: use.stepName,
          label: use.label,
        };
        const set = byKey.get(canonical);
        if (set) {
          set.uses.push(entry);
          if (set.name === null && use.place === "if_path") set.name = use.label;
        } else {
          byKey.set(canonical, {
            canonical,
            key: "",
            name: use.place === "if_path" ? use.label : null,
            when: use.when,
            uses: [entry],
          });
        }
      }
    }
  }
  const sets: LibraryConditionSet[] = [];
  for (const { canonical, ...set } of byKey.values()) {
    sets.push({ ...set, key: (await sha256Hex(canonical)).slice(0, 16) });
  }
  // The most used first: those are the ones worth naming.
  return sets.sort(
    (a, b) => b.uses.length - a.uses.length || (a.name ?? "~").localeCompare(b.name ?? "~"),
  );
}

/** Each tool source's name in words: a connector's or a pack's, or "Platform". */
function sourceNames(platform: Platform): Map<string, string> {
  const names = new Map<string, string>([["platform", "Platform"]]);
  for (const c of platform.connectors.list()) names.set(c.manifest.id, c.manifest.name);
  for (const p of platform.packs) names.set(p.manifest.id, p.manifest.name);
  return names;
}

export function libraryTools(platform: Platform): LibraryTool[] {
  const names = sourceNames(platform);
  const wrappers = new Map<string, string[]>();
  for (const def of platform.catalog.list()) {
    if (!isToolWrapper(def) || !def.handler) continue;
    wrappers.set(def.handler, [...(wrappers.get(def.handler) ?? []), def.id]);
  }
  return platform.tools
    .list()
    .map(({ spec }) => {
      const external = spec.sideEffect === "external";
      return {
        id: spec.id,
        description: spec.description,
        source: spec.source,
        sourceName: names.get(spec.source) ?? spec.source,
        connector: spec.connector ?? (platform.connectors.has(spec.source) ? spec.source : null),
        sideEffect: spec.sideEffect,
        verb: spec.verb,
        entities: spec.entity
          ? [spec.entity]
          : [...new Set(Object.values(spec.entityInput?.values ?? {}))],
        // DECISION (library): a write that declares no undo shows as "none", as the undo path
        // treats it (packages/core/src/schemas/tool.ts), with `undoDeclared` false to say so.
        undo: external ? (spec.undo ?? { kind: "none" as const }) : null,
        undoDeclared: spec.undo !== undefined,
        alwaysSigned: spec.approval === "always",
        wrappedBy: wrappers.get(spec.id) ?? [],
      };
    })
    .sort((a, b) => a.sourceName.localeCompare(b.sourceName) || a.id.localeCompare(b.id));
}

const PLATFORM_RECORD_LABEL: Record<(typeof RECORD_KINDS)[number], string> = {
  transaction: "Transaction",
  raw_record: "Record as it arrived",
  document: "Document",
  vendor: "Vendor",
};

export function libraryRecordTypes(platform: Platform): LibraryRecordType[] {
  const fromConnectors = platform.connectors.list().flatMap((c) =>
    (c.manifest.permissionEntities ?? []).map((e) => ({
      id: `${c.manifest.id}.${e.id}`,
      connector: c.manifest.id,
      sourceName: c.manifest.name,
      entity: e.id,
      label: e.label,
      verbs: e.verbs,
      scopes: e.scopes ?? [],
      tools: c.manifest.tools
        .filter(
          (t) => t.entity === e.id || Object.values(t.entityInput?.values ?? {}).includes(e.id),
        )
        .map((t) => ({ id: t.id, verb: t.verb, sideEffect: t.sideEffect })),
    })),
  );
  // DECISION (library): the platform's own record types are the kinds a source id can name
  // (records.ts, invariant 10); agents read them through tools, never write them directly.
  const ours = RECORD_KINDS.map((kind) => ({
    id: kind,
    connector: null,
    sourceName: "Platform",
    entity: kind,
    label: PLATFORM_RECORD_LABEL[kind],
    verbs: ["read" as const],
    scopes: [],
    tools: [],
  }));
  return [
    ...fromConnectors.sort(
      (a, b) => a.sourceName.localeCompare(b.sourceName) || a.label.localeCompare(b.label),
    ),
    ...ours,
  ];
}

/** Operator skills in scope (shared and the served clients' own; never snapshot copies). */
async function operatorSkillCount(ctx: Scope): Promise<number> {
  const rows = await ctx.tx
    .select({ slug: skill.slug })
    .from(skill)
    .where(
      ctx.tenantIds.length > 0
        ? or(isNull(skill.tenantId), inArray(skill.tenantId, [...ctx.tenantIds]))
        : isNull(skill.tenantId),
    );
  return rows.filter((r) => !r.slug.startsWith(SHARED_COPY_PREFIX)).length;
}

export function libraryRoutes(app: Hono<AppEnv>): void {
  mount(app, routes.opsLibrary, async (ctx) => {
    const { platform } = ctx.services;
    const templates = await templateProcesses(ctx, platform);
    const automations = await automationProcesses(ctx, platform);
    const builtins = platform.catalog.list();
    const retired = builtins.filter((d) => isToolWrapper(d)).length;
    const sets = await conditionSets([...templates.read, ...automations]);
    return {
      banks: [
        {
          bank: "processes" as const,
          count: templates.items.length + (await automationRows(ctx)).length,
          retired: 0,
        },
        {
          bank: "skills" as const,
          count: builtins.length - retired + (await operatorSkillCount(ctx)),
          retired,
        },
        { bank: "tools" as const, count: platform.tools.list().length, retired: 0 },
        { bank: "connectors" as const, count: platform.connectors.list().length, retired: 0 },
        { bank: "triggers" as const, count: platform.events.list().length, retired: 0 },
        { bank: "record_types" as const, count: libraryRecordTypes(platform).length, retired: 0 },
        { bank: "conditions" as const, count: sets.length, retired: 0 },
      ],
    };
  });

  mount(app, routes.opsLibraryProcesses, async (ctx) => ({
    processes: (await templateProcesses(ctx, ctx.services.platform)).items,
  }));

  mount(app, routes.opsLibraryTools, async ({ services }) => ({
    tools: libraryTools(services.platform),
  }));

  mount(app, routes.opsLibraryRecordTypes, async ({ services }) => ({
    recordTypes: libraryRecordTypes(services.platform),
  }));

  mount(app, routes.opsLibraryConditions, async (ctx) => {
    const { platform } = ctx.services;
    const templates = await templateProcesses(ctx, platform);
    const automations = await automationProcesses(ctx, platform);
    return {
      source: "derived" as const,
      sets: await conditionSets([...templates.read, ...automations]),
    };
  });
}
