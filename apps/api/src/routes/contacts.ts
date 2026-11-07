// Contacts (docs/plan.md §1.22): the back office edits any served client's; the portal's client
// admin edits its own client's. The same rules either way (messaging/contacts.ts): numbers in
// E.164, consent with its source, opt-outs, and STOP opt-outs lifted only by the contact.

import { routes } from "@countersign/core";
import type { Hono } from "hono";
import { setContactAutonomy } from "../directory/autonomy";
import { voiceSampleRouteHandlers } from "../directory/voice-samples";
import { type AppEnv, ensureClient, mount } from "../http";
import {
  changeConsent,
  contactMessages,
  contactOut,
  createContact,
  getContact,
  listContacts,
  updateContact,
} from "../messaging/contacts";

export function contactRoutes(app: Hono<AppEnv>): void {
  // ── Back office ──
  mount(app, routes.opsContacts, async (ctx) => {
    ensureClient(ctx, ctx.params.id);
    return { items: await listContacts(ctx.tx, ctx.params.id) };
  });
  mount(app, routes.opsCreateContact, async (ctx) => {
    ensureClient(ctx, ctx.params.id);
    const row = await createContact(ctx.tx, ctx.params.id, ctx.body, ctx.session.user.id);
    return { contact: await contactOut(ctx.tx, row) };
  });
  mount(app, routes.opsUpdateContact, async (ctx) => {
    ensureClient(ctx, ctx.params.id);
    const row = await updateContact(
      ctx.tx,
      ctx.params.id,
      ctx.params.contactId,
      ctx.body,
      ctx.session.user.id,
    );
    return { contact: await contactOut(ctx.tx, row) };
  });
  mount(app, routes.opsContactConsent, async (ctx) => {
    ensureClient(ctx, ctx.params.id);
    const row = await changeConsent(ctx.tx, ctx.params.id, ctx.params.contactId, ctx.body, {
      id: ctx.session.user.id,
      role: "operator",
    });
    return { contact: await contactOut(ctx.tx, row) };
  });
  mount(app, routes.opsContactMessages, async (ctx) => {
    ensureClient(ctx, ctx.params.id);
    await getContact(ctx.tx, ctx.params.id, ctx.params.contactId);
    return { items: await contactMessages(ctx.tx, ctx.params.id, ctx.params.contactId) };
  });

  // ── Portal (client admin) ──
  mount(app, routes.portalContacts, async (ctx) => ({
    items: await listContacts(ctx.tx, ctx.tenantIds[0] as string),
  }));
  mount(app, routes.portalCreateContact, async (ctx) => {
    const row = await createContact(
      ctx.tx,
      ctx.tenantIds[0] as string,
      ctx.body,
      ctx.session.user.id,
    );
    return { contact: await contactOut(ctx.tx, row) };
  });
  mount(app, routes.portalUpdateContact, async (ctx) => {
    const row = await updateContact(
      ctx.tx,
      ctx.tenantIds[0] as string,
      ctx.params.id,
      ctx.body,
      ctx.session.user.id,
    );
    return { contact: await contactOut(ctx.tx, row) };
  });
  mount(app, routes.portalContactConsent, async (ctx) => {
    const row = await changeConsent(ctx.tx, ctx.tenantIds[0] as string, ctx.params.id, ctx.body, {
      id: ctx.session.user.id,
      role: ctx.role,
    });
    return { contact: await contactOut(ctx.tx, row) };
  });
  mount(app, routes.portalContactMessages, async (ctx) => {
    const tenantId = ctx.tenantIds[0] as string;
    await getContact(ctx.tx, tenantId, ctx.params.id);
    return { items: await contactMessages(ctx.tx, tenantId, ctx.params.id) };
  });

  // ── v0.12 W1-G: a person's autonomy per channel (docs/plan.md §1.42) ──
  mount(app, routes.opsContactAutonomy, async (ctx) => {
    ensureClient(ctx, ctx.params.id);
    const row = await setContactAutonomy(
      ctx.tx,
      ctx.params.id,
      ctx.params.contactId,
      ctx.body.autonomy,
      { id: ctx.session.user.id, role: "operator" },
    );
    return { contact: await contactOut(ctx.tx, row) };
  });
  mount(app, routes.portalContactAutonomy, async (ctx) => {
    const row = await setContactAutonomy(
      ctx.tx,
      ctx.tenantIds[0] as string,
      ctx.params.id,
      ctx.body.autonomy,
      { id: ctx.session.user.id, role: ctx.role },
    );
    return { contact: await contactOut(ctx.tx, row) };
  });

  // ── v0.12 W1-G: voice samples (docs/plan.md §1.42) ──
  voiceSampleRouteHandlers(app);
}
