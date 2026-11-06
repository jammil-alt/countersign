// v0.12 W2-C: the agent lab (ARCHITECTURE §9.10, §14; docs/plan.md §1.46). Back office only:
// templates with a published version, drafts never published, and client agents made for one client
// from no template; per template, its clients (in the clients this operator serves), how many are
// behind its live version, and its test bench (the latest shared suite run of its live and latest
// versions).

import { type LabResponse, type LabTemplate, routes } from "@countersign/core";
import { agent, agentVersion, type Tx, tenant, testCase, testSuiteRun } from "@countersign/db";
import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import type { Hono } from "hono";
import { type AppEnv, mount } from "../http";
import { suiteViews } from "./testbench";

type AgentRow = typeof agent.$inferSelect;
type VersionLite = { id: string; agentId: string; version: number; based: string | null };

async function versionsOf(tx: Tx, agentIds: string[]): Promise<VersionLite[]> {
  if (agentIds.length === 0) return [];
  return tx
    .select({
      id: agentVersion.id,
      agentId: agentVersion.agentId,
      version: agentVersion.version,
      based: agentVersion.basedOnTemplateVersionId,
    })
    .from(agentVersion)
    .where(inArray(agentVersion.agentId, agentIds))
    .orderBy(desc(agentVersion.version));
}

function labAgent(row: AgentRow, versions: VersionLite[]) {
  const mine = versions.filter((v) => v.agentId === row.id);
  const live = mine.find((v) => v.id === row.liveVersionId) ?? null;
  const latest = mine[0] ?? null;
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    kind: row.kind,
    liveVersion: live?.version ?? null,
    latestVersion: latest?.version ?? null,
    liveVersionId: live?.id ?? null,
    latestVersionId: latest?.id ?? null,
  };
}

export function labRoutes(app: Hono<AppEnv>): void {
  mount(app, routes.opsLab, async (ctx) => {
    const { tx, tenantIds } = ctx;
    const served = [...tenantIds];
    const templates = await tx
      .select()
      .from(agent)
      .where(and(isNull(agent.tenantId), eq(agent.kind, "template"), eq(agent.status, "active")))
      .orderBy(agent.slug);
    // Client agents in the clients served (test copies aside): forks and client-only ones.
    const clientAgents = served.length
      ? await tx
          .select()
          .from(agent)
          .where(
            and(
              eq(agent.kind, "client"),
              eq(agent.testCopy, false),
              eq(agent.status, "active"),
              inArray(agent.tenantId, served),
            ),
          )
          .orderBy(agent.slug)
      : [];
    const versions = await versionsOf(tx, [
      ...templates.map((t) => t.id),
      ...clientAgents.map((a) => a.id),
    ]);
    const byId = new Map(versions.map((v) => [v.id, v]));

    // Cases per template, shared and the served clients'.
    const counts = templates.length
      ? await tx
          .select({ targetId: testCase.targetId, n: sql<number>`count(*)::int` })
          .from(testCase)
          .where(
            and(
              eq(testCase.targetKind, "template"),
              inArray(
                testCase.targetId,
                templates.map((t) => t.id),
              ),
              isNull(testCase.archivedAt),
              served.length
                ? sql`(${testCase.tenantId} is null or ${inArray(testCase.tenantId, served)})`
                : isNull(testCase.tenantId),
            ),
          )
          .groupBy(testCase.targetId)
      : [];
    // DECISION: the lab's test summary is the shared bench (tenant_id null): a client's suite
    // runs belong to that client and show on its own cases list (GET /api/ops/tests?client=).
    const wantVersions = templates.flatMap((t) => {
      const a = labAgent(t, versions);
      return [a.liveVersionId, a.latestVersionId].filter((x): x is string => x !== null);
    });
    const suites = wantVersions.length
      ? await tx
          .select()
          .from(testSuiteRun)
          .where(
            and(
              eq(testSuiteRun.targetKind, "template"),
              inArray(testSuiteRun.versionId, [...new Set(wantVersions)]),
              isNull(testSuiteRun.tenantId),
            ),
          )
          .orderBy(desc(testSuiteRun.createdAt))
      : [];
    const suiteViewsList = await suiteViews(tx, suites);
    const latestSuite = (versionId: string | null) =>
      versionId ? (suiteViewsList.find((s) => s.versionId === versionId) ?? null) : null;

    const published: LabTemplate[] = [];
    const drafts: LabTemplate[] = [];
    for (const t of templates) {
      const a = labAgent(t, versions);
      const forks = clientAgents.filter((c) => c.templateId === t.id);
      let behind = 0;
      let maxBehind = 0;
      for (const f of forks) {
        const mine = versions.filter((v) => v.agentId === f.id);
        const current = mine.find((v) => v.id === f.liveVersionId) ?? mine[0];
        const base = current?.based ? byId.get(current.based) : undefined;
        const by =
          f.linked && base && a.liveVersion !== null
            ? Math.max(0, a.liveVersion - base.version)
            : 0;
        if (by > 0) behind += 1;
        maxBehind = Math.max(maxBehind, by);
      }
      const entry: LabTemplate = {
        agent: a,
        clients: new Set(forks.map((f) => f.tenantId)).size,
        behind,
        maxBehind,
        tests: {
          cases: counts.find((c) => c.targetId === t.id)?.n ?? 0,
          live: latestSuite(a.liveVersionId),
          latest: latestSuite(a.latestVersionId),
        },
      };
      (t.liveVersionId ? published : drafts).push(entry);
    }

    const only = clientAgents.filter((c) => c.templateId === null);
    const names = only.length
      ? await tx
          .select({ id: tenant.id, name: tenant.name })
          .from(tenant)
          .where(inArray(tenant.id, [...new Set(only.map((c) => c.tenantId as string))]))
      : [];
    const response: LabResponse = {
      published,
      drafts,
      clientOnly: only.map((c) => ({
        agent: labAgent(c, versions),
        client: {
          id: c.tenantId as string,
          name: names.find((n) => n.id === c.tenantId)?.name ?? "",
        },
      })),
    };
    return response;
  });
}
