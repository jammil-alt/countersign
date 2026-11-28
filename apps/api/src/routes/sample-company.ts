// The Sandbox's sample company (packages/core `sampleCompanyRoutes`): the back office fills the
// Sandbox client with an invented business to test workflows on. Operators only, in the Sandbox
// only (403 `not_sandbox` anywhere else); `mount()` writes the audit row.
// Owner, 2026-11-27: where the Sandbox's messages to its made-up people go instead (core
// `sandboxRedirect`), read and set here (422 `not_sandbox` anywhere else).
import {
  isMadeUpEmail,
  isMadeUpPhone,
  normalizeSignupPhone,
  readSandboxDelivery,
  sampleCompanyRoutes as routes,
  SANDBOX_DELIVERY_SETTING,
} from "@countersign/core";
import { contact, type Tx, tenant } from "@countersign/db";
import { and, eq, or } from "drizzle-orm";
import type { Hono } from "hono";
import { type AppEnv, ensureClient, HttpError, mount, notFound } from "../http";
import { SAMPLE_COMPANY, seedSampleCompany } from "../sandbox/sample-company";
import { isSandbox, sandboxClient } from "./ops-clients";

export function sampleCompanyRoutesFor(app: Hono<AppEnv>): void {
  mount(app, routes.opsSandboxSampleCompany, async (ctx) => {
    const t = await sandboxClient(
      ctx,
      ctx.params.id,
      "the sample company is set up in the Sandbox client only",
    );
    const seeded = await seedSampleCompany(ctx.tx, ctx.services, {
      tenantId: t.id,
      userId: ctx.session.user.id,
      you: ctx.body.you,
    });
    return {
      company: { name: SAMPLE_COMPANY.name, domain: SAMPLE_COMPANY.domain },
      ...seeded,
    };
  });

  mount(app, routes.opsSandboxDelivery, async (ctx) => {
    const t = await deliveryClient(ctx, ctx.params.id);
    return readSandboxDelivery(t.settings);
  });

  mount(app, routes.opsSetSandboxDelivery, async (ctx) => {
    const t = await deliveryClient(ctx, ctx.params.id);
    const email = ctx.body.email?.trim().toLowerCase() || null;
    let phone: string | null = null;
    if (ctx.body.phone) {
      phone = normalizeSignupPhone(ctx.body.phone);
      if (!phone) {
        throw new HttpError(
          422,
          "invalid_phone",
          "Give the phone in international form (+15551234567) or as a 10-digit US number",
        );
      }
    }
    if ((email && isMadeUpEmail(email)) || (phone && isMadeUpPhone(phone))) {
      throw new HttpError(422, "made_up", "That is a made-up address too: give a real one");
    }
    // DECISION: the address and number must be one of the Sandbox's own contacts (the operator,
    // added as an employee), since every send checks its recipient's consent in the directory.
    for (const [what, value] of [
      ["email", email],
      ["phone", phone],
    ] as const) {
      if (value && !(await isContact(ctx.tx, t.id, what, value))) {
        throw new HttpError(
          422,
          "not_a_contact",
          `No one in the Sandbox has this ${what === "email" ? "address" : "number"}: add yourself as an employee of the sample company first`,
        );
      }
    }
    await ctx.tx
      .update(tenant)
      .set({ settings: { ...t.settings, [SANDBOX_DELIVERY_SETTING]: { email, phone } } })
      .where(eq(tenant.id, t.id));
    return { email, phone };
  });
}

/** The Sandbox client for its delivery setting: 404 unless served, 422 for any other client. */
async function deliveryClient(ctx: { tx: Tx; tenantIds: readonly string[] }, id: string) {
  ensureClient(ctx, id);
  const [t] = await ctx.tx.select().from(tenant).where(eq(tenant.id, id));
  if (!t) throw notFound("client");
  if (!isSandbox(t.settings)) {
    throw new HttpError(
      422,
      "not_sandbox",
      "messages to made-up people are redirected in the Sandbox client only",
    );
  }
  return t;
}

async function isContact(
  tx: Tx,
  tenantId: string,
  what: "email" | "phone",
  value: string,
): Promise<boolean> {
  const [row] = await tx
    .select({ id: contact.id })
    .from(contact)
    .where(
      and(
        eq(contact.tenantId, tenantId),
        what === "email"
          ? eq(contact.email, value)
          : or(eq(contact.phone, value), eq(contact.whatsapp, value)),
      ),
    )
    .limit(1);
  return row !== undefined;
}
