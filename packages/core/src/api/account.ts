import { z } from "zod";
import { isUuid } from "../ids";
import { defineRoute } from "./contract";

// Sloan, the account agent (ARCHITECTURE §9.8, §14; docs/plan.md §1.47). The operator installs a
// seeded platform template version where the seed never runs; the client admin signs a change
// Sloan drafted, which applies it through the portal's own code in the same transaction.

const Id = z.string().refine((v) => isUuid(v), "not an id");
const OPS = ["operator"] as const;

const PlatformSlug = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]*$/, "lowercase letters, digits and dashes")
  .max(64);

export const InstallPlatformTemplateBody = z.strictObject({
  /** The seeded version (`<slug>.v<version>.json`). */
  version: z.number().int().min(1).max(1000),
});

export const InstalledPlatformTemplate = z.object({
  template: z.object({ id: z.string(), slug: z.string() }),
  /** The template's version holding the seeded bundle, now live. */
  version: z.object({ id: z.string(), version: z.number().int(), status: z.string() }),
  /** False when a version with the same bundle was already there (nothing changed). */
  installed: z.boolean(),
});
export type InstalledPlatformTemplate = z.infer<typeof InstalledPlatformTemplate>;

export const AccountChangeDecision = z.strictObject({
  decision: z.enum(["approve", "reject"]),
  note: z.string().trim().max(2000).optional(),
});
export type AccountChangeDecision = z.infer<typeof AccountChangeDecision>;

export const AccountChangeOutcome = z.object({
  item: z.object({
    id: z.string(),
    title: z.string(),
    status: z.enum(["open", "resolved", "expired"]),
    approved: z.boolean().nullable(),
  }),
  /** What the approval changed: the person added or edited. */
  applied: z
    .object({
      kind: z.enum(["add_signer", "edit_person", "change_contact", "invite_to_texts"]),
      userId: z.string().nullable(),
      contactId: z.string().nullable(),
    })
    .nullable(),
});
export type AccountChangeOutcome = z.infer<typeof AccountChangeOutcome>;

export const accountRoutes = {
  opsInstallPlatformTemplate: defineRoute({
    method: "POST",
    path: "/api/ops/platform-templates/:slug/install",
    auth: "session",
    roles: OPS,
    summary:
      "Install a seeded platform template version and make it the template's live version (idempotent by bundle hash; clients' forks move only by a reviewed update)",
    params: z.object({ slug: PlatformSlug }),
    body: InstallPlatformTemplateBody,
    response: InstalledPlatformTemplate,
  }),
  portalResolveAccountChange: defineRoute({
    method: "POST",
    path: "/api/account-changes/:id/resolve",
    auth: "session",
    roles: ["client_admin"] as const,
    summary:
      "Sign or decline a change Sloan drafted; signing applies it as the portal's own edit would",
    params: z.object({ id: Id }),
    body: AccountChangeDecision,
    response: AccountChangeOutcome,
  }),
} as const;
