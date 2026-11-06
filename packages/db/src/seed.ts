// The seed (docs/plan.md §1.2 "Seeded and template definitions", "Sandbox client"): the operator,
// the clients "Sandbox" and "Demo client" with their memberships, and the platform templates as v1
// rows from packages/db/seed/agents/<slug>.v1.json, later seeded versions (`<slug>.v<n>.json`) as
// the live version. Idempotent: ids are uuid v5 of fixed names and every insert skips what is
// already there, so running it twice changes nothing.
//
// Node only (it reads the seed files); not exported from the package's Worker-safe index.

import { readdir, readFile } from "node:fs/promises";
import { type AgentBundle, bundleHash, uuidv5, validateBundle } from "@countersign/core";
import { and, eq, isNull } from "drizzle-orm";
import { type Db, withOperator } from "./client";
import { agent, agentVersion, appUser, membership, tenant } from "./schema";

/** Namespace for seeded ids. Never change it: seeded rows are found again by these ids. */
export const SEED_NAMESPACE = "3b0f9a56-2c41-4e8f-a1d7-6c5e9b204d18";

export const SEED_TENANTS = {
  sandbox: { name: "Sandbox", settings: { sandbox: true } },
  demo: { name: "Demo client", settings: {} },
} as const;

export const SEED_USERS = {
  operator: { email: "operator@example.com", name: "Operator" },
  demoAdmin: { email: "admin@demo-client.example.com", name: "Demo admin" },
} as const;

const SEED_DIR = new URL("../seed/agents/", import.meta.url);

export interface SeedTemplate {
  slug: string;
  bundle: AgentBundle;
  hash: string;
}

/** The platform templates, parsed and validated. Throws on any file that fails validation. */
export async function loadSeedTemplates(): Promise<SeedTemplate[]> {
  const files = (await readdir(SEED_DIR)).filter((f) => f.endsWith(".v1.json")).sort();
  const out: SeedTemplate[] = [];
  for (const file of files) {
    const slug = file.slice(0, -".v1.json".length);
    const raw: unknown = JSON.parse(await readFile(new URL(file, SEED_DIR), "utf8"));
    const result = validateBundle(raw);
    if (!result.valid || !result.value) {
      const errors = result.errors.map((e) => `${e.field}: ${e.message}`).join("; ");
      throw new Error(`seed/agents/${file} is not a valid bundle: ${errors}`);
    }
    out.push({ slug, bundle: result.value, hash: await bundleHash(result.value) });
  }
  return out;
}

// v0.12 W2-D: later seeded versions (`<slug>.v<n>.json`, n ≥ 2), e.g. the supervisor's v2, Sloan.
export interface SeedTemplateVersion extends SeedTemplate {
  version: number;
}

/** Every seeded version after the first, by slug then version. Throws on an invalid file. */
export async function loadSeedVersions(): Promise<SeedTemplateVersion[]> {
  const out: SeedTemplateVersion[] = [];
  for (const file of await readdir(SEED_DIR)) {
    const m = /^([a-z0-9-]+)\.v(\d{1,4})\.json$/.exec(file);
    if (!m?.[1] || !m[2] || Number(m[2]) < 2) continue;
    const raw: unknown = JSON.parse(await readFile(new URL(file, SEED_DIR), "utf8"));
    const result = validateBundle(raw);
    if (!result.valid || !result.value) {
      const errors = result.errors.map((e) => `${e.field}: ${e.message}`).join("; ");
      throw new Error(`seed/agents/${file} is not a valid bundle: ${errors}`);
    }
    out.push({
      slug: m[1],
      version: Number(m[2]),
      bundle: result.value,
      hash: await bundleHash(result.value),
    });
  }
  return out.sort((a, b) => a.slug.localeCompare(b.slug) || a.version - b.version);
}

const seedId = (name: string) => uuidv5(name, SEED_NAMESPACE);

export interface SeedResult {
  tenants: { sandbox: string; demo: string };
  users: { operator: string; demoAdmin: string };
  /** slug → ids of the template and its v1. */
  templates: Record<string, { agentId: string; versionId: string }>;
}

export async function seed(db: Db): Promise<SeedResult> {
  const templates = await loadSeedTemplates();
  const tenants = {
    sandbox: await seedId("tenant:sandbox"),
    demo: await seedId("tenant:demo"),
  };

  // The operator's session covers both seeded clients and the templates, so the seed passes RLS
  // whichever role runs it.
  return withOperator(db, Object.values(tenants), async (tx) => {
    for (const [key, t] of Object.entries(SEED_TENANTS) as [
      keyof typeof tenants,
      typeof SEED_TENANTS.sandbox,
    ][]) {
      await tx
        .insert(tenant)
        .values({ id: tenants[key], name: t.name, settings: t.settings })
        .onConflictDoNothing();
    }

    // Users are found by email: one may already exist from a real sign-in, with its own id.
    const users = {} as SeedResult["users"];
    for (const [key, u] of Object.entries(SEED_USERS) as [
      keyof typeof SEED_USERS,
      (typeof SEED_USERS)["operator"],
    ][]) {
      await tx
        .insert(appUser)
        .values({ id: await seedId(`user:${u.email}`), email: u.email, name: u.name })
        .onConflictDoNothing();
      const [row] = await tx
        .select({ id: appUser.id })
        .from(appUser)
        .where(eq(appUser.email, u.email));
      if (!row) throw new Error(`seed: user ${u.email} missing after insert`);
      users[key] = row.id;
    }

    await tx
      .insert(membership)
      .values([
        // The owner serves every client.
        { tenantId: tenants.sandbox, userId: users.operator, role: "operator" },
        { tenantId: tenants.demo, userId: users.operator, role: "operator" },
        { tenantId: tenants.demo, userId: users.demoAdmin, role: "client_admin" },
      ])
      .onConflictDoNothing();

    const seeded: SeedResult["templates"] = {};
    for (const t of templates) {
      await tx
        .insert(agent)
        .values({
          id: await seedId(`template:${t.slug}`),
          tenantId: null,
          kind: "template",
          slug: t.slug,
          name: t.bundle.definition.identity.name,
          role: t.bundle.definition.identity.role,
        })
        .onConflictDoNothing();
      const [row] = await tx
        .select({ id: agent.id, liveVersionId: agent.liveVersionId })
        .from(agent)
        .where(and(isNull(agent.tenantId), eq(agent.slug, t.slug)));
      if (!row) throw new Error(`seed: template ${t.slug} missing after insert`);

      // A v1 that already exists is history and stays as it is (immutable), whatever the file says.
      await tx
        .insert(agentVersion)
        .values({
          id: await seedId(`template:${t.slug}:v1`),
          tenantId: null,
          agentId: row.id,
          version: 1,
          bundle: t.bundle,
          bundleHash: t.hash,
          status: "live",
          changeNote: "Seeded platform template",
          releaseNote: "First version",
          authorType: "operator",
        })
        .onConflictDoNothing();
      const [v1] = await tx
        .select({ id: agentVersion.id })
        .from(agentVersion)
        .where(and(eq(agentVersion.agentId, row.id), eq(agentVersion.version, 1)));
      if (!v1) throw new Error(`seed: template ${t.slug} v1 missing after insert`);

      if (row.liveVersionId === null) {
        await tx.update(agent).set({ liveVersionId: v1.id }).where(eq(agent.id, row.id));
      }
      seeded[t.slug] = { agentId: row.id, versionId: v1.id };
    }

    // v0.12 W2-D: later seeded versions become the template's live version, once: a version with
    // the same bundle already there (seeded, or installed by the back office's install route)
    // changes nothing. Publishing a template changes no client agent (invariant 11): clients'
    // forks move by the usual reviewed update.
    for (const v of await loadSeedVersions()) {
      const template = seeded[v.slug];
      if (!template) continue;
      const versions = await tx
        .select({
          id: agentVersion.id,
          version: agentVersion.version,
          hash: agentVersion.bundleHash,
        })
        .from(agentVersion)
        .where(eq(agentVersion.agentId, template.agentId));
      if (versions.some((x) => x.hash === v.hash)) continue;
      const [row] = await tx
        .select({ liveVersionId: agent.liveVersionId })
        .from(agent)
        .where(eq(agent.id, template.agentId));
      const id = await seedId(`template:${v.slug}:v${v.version}`);
      await tx.insert(agentVersion).values({
        id,
        tenantId: null,
        agentId: template.agentId,
        // DECISION: the next free number, so an operator's own versions keep theirs.
        version: Math.max(0, ...versions.map((x) => x.version)) + 1,
        bundle: v.bundle,
        bundleHash: v.hash,
        status: "live",
        changeNote: `Seeded platform template v${v.version}`,
        releaseNote: `Seeded v${v.version}`,
        authorType: "operator",
        parentVersionId: row?.liveVersionId ?? null,
      });
      if (row?.liveVersionId) {
        await tx
          .update(agentVersion)
          .set({ status: "retired" })
          .where(eq(agentVersion.id, row.liveVersionId));
      }
      await tx.update(agent).set({ liveVersionId: id }).where(eq(agent.id, template.agentId));
    }

    return { tenants, users, templates: seeded };
  });
}
