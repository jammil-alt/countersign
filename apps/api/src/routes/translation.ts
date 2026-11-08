// P-7: message translation's settings and a contact's switch (docs/plan.md §1.69). The operator
// sets everything for a client it serves, with a reason; the client admin sets the working language
// and the switches; client users read them. Every change is logged (`tenant_change`,
// `contact_change`), and every request is in the audit log as always.

import { clientTranslation } from "@countersign/agents";
import { routes } from "@countersign/core";
import type { Hono } from "hono";
import { type AppEnv, ensureClient, mount } from "../http";
import {
  opsSettingsView,
  saveTranslation,
  setContactTranslation,
  settingsView,
} from "../translate/service";

export function translationRoutes(app: Hono<AppEnv>): void {
  mount(app, routes.opsTranslation, async (ctx) => {
    ensureClient(ctx, ctx.params.id);
    return { translation: await opsSettingsView(ctx.tx, ctx.params.id) };
  });
  mount(app, routes.opsSetTranslation, async (ctx) => {
    ensureClient(ctx, ctx.params.id);
    await saveTranslation(ctx.tx, ctx.params.id, ctx.body, {
      id: ctx.session.user.id,
      side: "operator",
    });
    return { translation: await opsSettingsView(ctx.tx, ctx.params.id) };
  });
  mount(app, routes.portalTranslation, async (ctx) => {
    const tenantId = ctx.tenantIds[0] as string;
    return { translation: settingsView((await clientTranslation(ctx.tx, tenantId)).settings) };
  });
  mount(app, routes.portalSetTranslation, async (ctx) => {
    const tenantId = ctx.tenantIds[0] as string;
    const saved = await saveTranslation(ctx.tx, tenantId, ctx.body, {
      id: ctx.session.user.id,
      side: "client",
    });
    return { translation: settingsView(saved) };
  });
  mount(app, routes.opsContactTranslation, async (ctx) => {
    ensureClient(ctx, ctx.params.id);
    const translation = await setContactTranslation(
      ctx.tx,
      ctx.params.id,
      ctx.params.contactId,
      ctx.body.translation,
      { id: ctx.session.user.id, role: "operator" },
    );
    return { contactId: ctx.params.contactId, translation };
  });
  mount(app, routes.portalContactTranslation, async (ctx) => {
    const translation = await setContactTranslation(
      ctx.tx,
      ctx.tenantIds[0] as string,
      ctx.params.id,
      ctx.body.translation,
      { id: ctx.session.user.id, role: "client_admin" },
    );
    return { contactId: ctx.params.id, translation };
  });
}
