// The Sandbox's sample company (owner, 2026-11-27): one click in the back office fills the Sandbox
// client (`tenant.settings.sandbox`) with a small, plainly invented business, Ridgeline Builders,
// so a workflow's lookups and Match steps have records to find: vendors with their people and
// email domains, the company's own people, its customers, a chart of accounts, master items and
// the vendors' SKUs for them, and a few bills and purchases. Every name, domain (example.com) and
// number (555-01xx) is made up. The operator may add themselves as one of its employees, so an
// email or a text they send reaches a message trigger as an employee's.
//
// Running it again adds only what is missing: each record has a fixed id, and nothing seeded is
// changed or duplicated, even after it was edited.

import { z } from "zod";
import { isUuid } from "../ids";
import { defineRoute } from "./contract";

const Id = z.string().refine((v) => isUuid(v), "not an id");
const OPS = ["operator"] as const;

/** The operator as one of the sample company's employees (their real address and number). */
export const SampleCompanyYou = z.strictObject({
  name: z.string().trim().min(1).max(200),
  email: z.email().max(254).optional(),
  /** International form, or a 10-digit US or Canadian number. */
  phone: z.string().trim().min(1).max(40).optional(),
});
export type SampleCompanyYou = z.infer<typeof SampleCompanyYou>;

export const SampleCompanyBody = z.strictObject({ you: SampleCompanyYou.optional() });
export type SampleCompanyBody = z.infer<typeof SampleCompanyBody>;

/** Rows of each kind: the sample company's that are there now, or the ones this call added. */
export const SampleCompanyCounts = z.object({
  vendors: z.number().int(),
  organizations: z.number().int(),
  contacts: z.number().int(),
  ledgerAccounts: z.number().int(),
  ledgerNotes: z.number().int(),
  masterItems: z.number().int(),
  vendorItems: z.number().int(),
  transactions: z.number().int(),
});
export type SampleCompanyCounts = z.infer<typeof SampleCompanyCounts>;

export const SampleCompanyPerson = z.object({
  contactId: Id,
  name: z.string(),
  email: z.string().nullable(),
  phone: z.string().nullable(),
  title: z.string().nullable(),
  /** The operator who asked to be added. */
  you: z.boolean(),
});
export type SampleCompanyPerson = z.infer<typeof SampleCompanyPerson>;

/** Something to try a step with: what it is and the value to type. */
export const SampleCompanyExample = z.object({ what: z.string(), value: z.string() });
export type SampleCompanyExample = z.infer<typeof SampleCompanyExample>;

export const SampleCompanyResult = z.object({
  company: z.object({ name: z.string(), domain: z.string() }),
  /** The sample company's records in the Sandbox now. */
  counts: SampleCompanyCounts,
  /** What this call added (all zero on a second run). */
  added: SampleCompanyCounts,
  employees: z.array(SampleCompanyPerson),
  /** Areas this call switched on for the Sandbox (the Purchasing area's pack, the first time). */
  switchedOn: z.array(z.string()),
  examples: z.array(SampleCompanyExample),
});
export type SampleCompanyResult = z.infer<typeof SampleCompanyResult>;

export const sampleCompanyRoutes = {
  opsSandboxSampleCompany: defineRoute({
    method: "POST",
    path: "/api/ops/clients/:id/sample-company",
    auth: "session",
    roles: OPS,
    summary:
      "Set up the sample company in the Sandbox client: invented vendors, people, customers, chart of accounts, items and bills, added once (a second call adds only what is missing); optionally the operator as an employee (403 not_sandbox in any other client)",
    params: z.object({ id: Id }),
    body: SampleCompanyBody,
    response: SampleCompanyResult,
  }),
};
