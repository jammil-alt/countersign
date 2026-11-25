import { z } from "zod";
import { PROCESSORS } from "../compliance/processors";
import { GuideSectionSource } from "../onboarding/guide";
import { OwnerArea } from "../owners/areas";
import { Role } from "../roles";
import { LoopTests, loopsWithoutTests } from "../testbench/loop-tests";
import { AgentBundle, AnyAgentBundle } from "./agent";
import { Slug } from "./common";
import { EventTypeSpec } from "./event";
import { PackConfigField, packConfigProblems } from "./pack-config";
import { SkillDefinition } from "./skill";
import { ToolSpec } from "./tool";

/**
 * docs/plan.md §1.162 (owner, 2026-11-20): a connection a business area works through, shown on
 * the client page's Areas tab with its status for that client. Any one of `connectors` meets it
 * (Gmail or Outlook); the first is the one to offer. `use` says what the area does with it, in the
 * operator's words.
 */
// DECISION: a list of needs, each met by any of its connectors, rather than the manifest's flat
// `requiresConnectors`: an area can work through one of several tools (Search Console signs in two
// ways), and nothing here gates switching the area on; it only says what to connect.
export const AreaConnection = z.object({
  connectors: z.array(z.string().regex(/^[a-z][a-z0-9_]*$/)).min(1),
  use: z.string().min(1),
});
export type AreaConnection = z.infer<typeof AreaConnection>;

/**
 * A pack: one business area's shared data and what works on it (ARCHITECTURE §12.0–12.1, §12.10;
 * docs/plan.md §1.230). Every pack's manifest has this shape, and `apps/api` installs any pack
 * from it alone: the operator switches a pack on for a client from the client page's Areas tab
 * (the Packs tab), giving only the pack's configuration, and the platform
 *
 *  1. records the pack as on for that client (a `tenant_pack` row) and keeps the configuration in
 *     `tenant.settings.packs.<id>` (`config`, read back with `packConfigOf`);
 *  2. installs the pack's `templates` once per deployment as published template versions the
 *     operator then owns (approval on in every step that writes: invariant 8), and its
 *     `librarySkills` once as shared Library skills;
 *  3. from then on offers the client the pack's `screens` (portal and back office reports, served
 *     by the `reports` the pack registers), its `tools` and `skills` to agents, and its `events`.
 *
 * Nothing in `packages/*` or `apps/api` names a pack to install it. A new pack (Wave Y's Close and
 * AP packs) writes one manifest in this shape, registers it in `apps/api/src/packs.ts` with its
 * handlers, and is installable from the Areas tab with no other platform change.
 *
 * Fields, in the order a new pack fills them:
 *  - `id`, `name`, `version`, `description`: who it is; `id` prefixes its tools, events, reports.
 *  - `area`: the business area (`OwnerArea`) whose shared data it holds (§12.0). One pack per area,
 *    except that a pack may `extends` another (its base) to build on that area: it then sits in
 *    the base's area, and its templates declare `area` themselves (the base's pack id is what
 *    core's `processArea` reads from `requiresPacks`).
 *  - `connections`: what the area works through (any one connector of each need), shown with the
 *    client's status on the Areas tab. Nothing here gates switching it on.
 *  - `config`: the fields the operator sets when switching it on, each with its default
 *    (`PackConfigField`). Empty when there is nothing to set. Never a secret.
 *  - `processors`: the vendors of ours (`PROCESSORS`, packages/core/src/compliance) the pack itself
 *    sends a client's data to, beyond its steps' models and its connectors' (each gated where it is
 *    called). Listed so HIPAA mode can show and refuse them; a new one is named in compliance first.
 *  - `tools`, `skills`, `events`: what agents use, each named `<id>.…` (checked below).
 *  - `templates`: the agent templates it installs, whole bundles (v1 and later versions).
 *  - `screens`: its routes, `/reports/<id>/<report>` in the portal and back office.
 *  - `reports`: the names of the reports it registers (`/api/reports/<id>/<name>`); `apps/api`
 *    holds them equal to the handlers it registers.
 *  - `intakeSection`, `librarySkills`, `superseded`: optional, as their comments say.
 */
export const PackManifest = z
  .object({
    id: z.string().regex(/^[a-z][a-z0-9-]*$/),
    name: z.string(),
    version: z.string(),
    description: z.string(),
    // §1.230: the business area the pack is (ARCHITECTURE §12.0).
    area: OwnerArea,
    // §1.230: the pack whose business area this one builds on (the Close pack extends
    // `bookkeeping`, the AP pack `materials`). It sits in its base's area; apps/api checks the base
    // is registered and the areas agree.
    // DECISION (Wave Y coordinator, 2026-11-22): one pack per area, except packs that extend one,
    // so an area's shared data keeps one owner pack and later packs add to it without a new area.
    extends: z
      .string()
      .regex(/^[a-z][a-z0-9-]*$/)
      .optional(),
    // §1.230: what the operator sets when switching the pack on for a client (pack-config.ts).
    config: z.array(PackConfigField).default([]),
    // §1.230: the vendors of ours the pack itself sends client data to (compliance/processors.ts).
    processors: z.array(z.enum(PROCESSORS)).default([]),
    // §1.230: the reports it registers, by name (`/api/reports/<id>/<name>`).
    reports: z.array(z.string().regex(/^[a-z][a-z0-9_-]*$/)).default([]),
    requiresConnectors: z.array(z.string()).default([]),
    // §1.162: the connections the pack's business area works through (AreaConnection).
    connections: z.array(AreaConnection).optional(),
    events: z.array(EventTypeSpec),
    tools: z.array(ToolSpec),
    skills: z.array(SkillDefinition),
    // DECISION: a pack's templates are whole agent bundles (definition + workflows), the unit
    // ARCHITECTURE v0.6 versions, rather than separate agent and workflow lists.
    // R9 (docs/plan.md §1.86, §9): `bundle` is the template's first version, as first installed
    // (never changed: invariant 3); `versions` are its later ones, v2 first, which may hold v4
    // processes. Installing adds each later version the template doesn't hold yet, by bundle hash.
    templates: z.array(
      z.object({
        slug: Slug,
        bundle: AgentBundle,
        versions: z.array(AnyAgentBundle).optional(),
      }),
    ),
    screens: z.array(z.object({ route: z.string(), title: z.string(), roles: z.array(Role) })),
    // §1.88 (owner, 2026-11-11): the pack's shared Library skills, operator skills (`custom:<slug>`,
    // no built-in code) the pack installs once, as shared skills (tenant_id null) with a published
    // v1, the first time it is switched on. From then on they are the operator's: edited, versioned,
    // tested and published in the Library like any skill they wrote; the pack never changes them.
    librarySkills: z.array(SkillDefinition).optional(),
    // Step model §8: a Loop the pack ships (a skill with a `loop` block, built in or a Library
    // skill) carries its test set: hand-written replays, by skill id. CI runs them and the pack
    // can't be installed without them: a Loop is never published untested.
    loopTests: LoopTests.optional(),
    // §1.88: the pack's skills another skill replaces for new steps (skill id → its replacement's
    // id, one of the pack's skills or Library skills). Stored steps keep running the old one
    // (invariant 3); the palette and the Builder offer the replacement instead (core's
    // `newStepSkillReason`).
    superseded: z.record(z.string(), z.string()).optional(),
    // docs/plan.md §1.149.2 (cases-plan §4.2 step 2): the questions an intake asks about the
    // pack's business area, as data (kind `area`, its area named). The platform reads them from
    // the manifest; an area without a pack gets core's generic questions.
    intakeSection: GuideSectionSource.optional(),
  })
  .superRefine((p, ctx) => {
    if (p.extends === p.id) {
      ctx.addIssue({ code: "custom", message: "a pack can't extend itself", path: ["extends"] });
    }
    for (const message of packConfigProblems(p.config)) {
      ctx.addIssue({ code: "custom", message, path: ["config"] });
    }
    if (new Set(p.reports).size !== p.reports.length) {
      ctx.addIssue({ code: "custom", message: "a report is listed twice", path: ["reports"] });
    }
    if (p.intakeSection?.area && p.intakeSection.area !== p.area) {
      ctx.addIssue({
        code: "custom",
        message: `the intake section asks about ${p.intakeSection.area}, but the pack is ${p.area}`,
        path: ["intakeSection", "area"],
      });
    }
    if (p.intakeSection && (p.intakeSection.kind !== "area" || !p.intakeSection.area)) {
      ctx.addIssue({
        code: "custom",
        message: "a pack's intake section is its area's (kind area, with the area named)",
        path: ["intakeSection"],
      });
    }
    const library = p.librarySkills ?? [];
    for (const id of loopsWithoutTests([...p.skills, ...library], p.loopTests)) {
      ctx.addIssue({
        code: "custom",
        message: `${id} is a Loop and ships without a test set: add its cases to loopTests`,
        path: ["loopTests", id],
      });
    }
    for (const id of Object.keys(p.loopTests ?? {})) {
      if (![...p.skills, ...library].some((s) => s.id === id && s.loop !== undefined)) {
        ctx.addIssue({
          code: "custom",
          message: `loopTests names ${id}, which isn't one of the pack's Loops`,
          path: ["loopTests", id],
        });
      }
    }
    for (const [from, to] of Object.entries(p.superseded ?? {})) {
      if (!p.skills.some((s) => s.id === from)) {
        ctx.addIssue({
          code: "custom",
          message: `superseded names ${from}, which isn't one of the pack's skills`,
          path: ["superseded", from],
        });
      }
      if (!p.skills.some((s) => s.id === to) && !library.some((s) => s.id === to)) {
        ctx.addIssue({
          code: "custom",
          message: `superseded names ${to}, which isn't one of the pack's skills or Library skills`,
          path: ["superseded", from],
        });
      }
    }
    library.forEach((s, i) => {
      const slug = s.id.startsWith("custom:") ? s.id.slice("custom:".length) : "";
      if (!Slug.safeParse(slug).success || s.handler !== undefined) {
        ctx.addIssue({
          code: "custom",
          message: `a Library skill is an operator skill (custom:<slug>, no built-in code), not ${s.id}`,
          path: ["librarySkills", i, "id"],
        });
      }
    });
    p.tools.forEach((t, i) => {
      if (t.source !== p.id) {
        ctx.addIssue({
          code: "custom",
          message: `tool ${t.id} has source ${t.source}, not ${p.id}`,
          path: ["tools", i, "source"],
        });
      }
    });
    p.events.forEach((e, i) => {
      if (!e.type.startsWith(`${p.id}.`)) {
        ctx.addIssue({
          code: "custom",
          message: `pack events are named ${p.id}.<...>`,
          path: ["events", i, "type"],
        });
      }
    });
  })
  .meta({ id: "PackManifest" });
export type PackManifest = z.infer<typeof PackManifest>;
