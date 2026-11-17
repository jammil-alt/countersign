// The welcome page (docs/plan.md §1.149; docs/cases-plan.md §4.4): `/start/<token>`, seen without
// sign-in, opened by the signed welcome link (../onboarding/link.ts). Reading it logs `opened` on
// the intake once (no tracking pixels). It shows names, the lead's note and what's in it; never the
// file, an answer or anything of ours. The token is never a way in on its own: the page leads to
// sign-in (WorkOS, with the invited address filled in), and after it the signed-in address must be
// the invited one ("This invite is for d•••@acme.com" otherwise, and nothing more). An expired or
// closed link offers "Ask <lead> for a new one", a to-do for the lead on Your call.

import { getSession } from "@countersign/auth";
import {
  maskEmail,
  type WelcomeSignedInView,
  welcomeRoutes as welcomeSpecs,
} from "@countersign/core";
import {
  intake,
  intakeEvent,
  intakePerson,
  type Tx,
  tenant,
  withOperator,
  withTenant,
} from "@countersign/db";
import { and, eq } from "drizzle-orm";
import type { Hono } from "hono";
import { auditAlone, requestOrigin } from "../audit";
import { authDirectory } from "../auth";
import { type AppContext, type AppEnv, errorResponse, HttpError, mountPublic } from "../http";
import { intakeLead, intakeSummaryOf, personLocale } from "../onboarding/emails";
import { verifyWelcomeLink } from "../onboarding/link";
import { addTodo } from "../work/todos-store";

const tokenOf = (c: { req: { param(name: string): string | undefined } }) =>
  c.req.param("token") ?? "";

const gone = () => new HttpError(404, "not_found", "This link has expired or doesn't exist.");

/** Where a person who signed in with the invited address goes: Getting started (stream INTAKE). */
export const GETTING_STARTED_PATH = "/start";

type IntakeRow = typeof intake.$inferSelect;
type PersonRow = typeof intakePerson.$inferSelect;

/** The person and intake a link names, in its own client; null when either is gone. */
async function invited(
  tx: Tx,
  ref: { t: string; i: string; p: string },
): Promise<{ person: PersonRow; it: IntakeRow; client: typeof tenant.$inferSelect } | null> {
  const [person] = await tx
    .select()
    .from(intakePerson)
    .where(
      and(
        eq(intakePerson.id, ref.p),
        eq(intakePerson.tenantId, ref.t),
        eq(intakePerson.intakeId, ref.i),
      ),
    );
  const [it] = await tx
    .select()
    .from(intake)
    .where(and(eq(intake.id, ref.i), eq(intake.tenantId, ref.t)));
  const [client] = await tx.select().from(tenant).where(eq(tenant.id, ref.t));
  return person && it && client ? { person, it, client } : null;
}

/** Closed: the intake is done or cancelled, or the client's account was retired. */
function isClosed(it: IntakeRow, client: typeof tenant.$inferSelect): boolean {
  return it.status === "done" || it.status === "cancelled" || client.retiredAt !== null;
}

/** Logs an intake event for a person once (a second opening or sign-in adds nothing). */
async function logOnce(
  tx: Tx,
  ref: { tenantId: string; intakeId: string; personId: string },
  kind: "opened" | "signed_in",
  meta: Record<string, unknown>,
): Promise<void> {
  const [seen] = await tx
    .select({ id: intakeEvent.id })
    .from(intakeEvent)
    .where(
      and(
        eq(intakeEvent.tenantId, ref.tenantId),
        eq(intakeEvent.intakeId, ref.intakeId),
        eq(intakeEvent.personId, ref.personId),
        eq(intakeEvent.kind, kind),
      ),
    )
    .limit(1);
  if (seen) return;
  await tx.insert(intakeEvent).values({ ...ref, kind, meta });
}

function sendCookies(c: AppContext, cookies: readonly string[]) {
  for (const cookie of cookies) c.header("Set-Cookie", cookie, { append: true });
}

export function welcomeRoutes(app: Hono<AppEnv>): void {
  // DECISION: the page and its "ask for a new one" are public and write no audit row: the person
  // acting has no session, as on a form's page (§1.121). What happened is kept on the intake's own
  // log (`opened`, with time, address and browser) and as the lead's to-do. The check after
  // sign-in has a person and writes its audit row.
  mountPublic(app, welcomeSpecs.welcomePage, async ({ c, services }) => {
    const link = await verifyWelcomeLink(services.env, tokenOf(c));
    if (!link) throw gone();
    const { t, i, p, e } = link.payload;
    return withTenant(services.db, t, async (tx) => {
      const found = await invited(tx, { t, i, p });
      if (!found) throw gone();
      const { person, it, client } = found;
      const state = isClosed(it, client) ? "closed" : link.expired ? "expired" : "open";
      if (state === "open") {
        await logOnce(
          tx,
          { tenantId: t, intakeId: it.id, personId: person.id },
          "opened",
          requestOrigin(c),
        );
      }
      const lead = await intakeLead(tx, it);
      const open = state === "open";
      const covers = intakeSummaryOf(it);
      const summary = { ...covers, areas: [...covers.areas] };
      return {
        state,
        client: client.name,
        lead: { name: lead.name, photoUrl: null },
        // Expired or closed: the names only.
        note: open && it.leadNote.trim() ? it.leadNote.trim() : null,
        summary: open ? summary : null,
        email: open ? person.email : null,
        expiresAt: new Date(e * 1000).toISOString(),
        language: personLocale(person, (client.settings ?? {}) as Record<string, unknown>),
      };
    });
  });

  // After sign-in. Outside mount(): any signed-in person may ask, whichever client or role they
  // have, and is told only whose invite it is when it isn't theirs.
  app.post(welcomeSpecs.welcomeSignedIn.path, async (c) => {
    try {
      const services = c.get("req").services();
      const choice = services.auth();
      if (!choice.ok) {
        sendCookies(c, choice.refusal.setCookies);
        const r = choice.refusal;
        return c.json({ error: { code: r.code, message: r.message } }, r.status);
      }
      const session = await getSession(c.req.raw, {
        adapter: choice.adapter,
        directory: authDirectory(services.db),
      });
      if (!session.ok) {
        sendCookies(c, session.setCookies);
        return c.json({ error: { code: session.code, message: session.message } }, session.status);
      }
      sendCookies(c, session.setCookies);
      const link = await verifyWelcomeLink(services.env, tokenOf(c));
      if (!link) throw gone();
      const { t, i, p } = link.payload;
      const who = session.session.user;
      const result = await withTenant(services.db, t, async (tx) => {
        const found = await invited(tx, { t, i, p });
        if (!found) throw gone();
        const { person, it, client } = found;
        if (isClosed(it, client)) return { view: { state: "closed" } as WelcomeSignedInView };
        if (link.expired) return { view: { state: "expired" } as WelcomeSignedInView };
        const ref = { tenantId: t, intakeId: it.id, personId: person.id };
        const sameAddress = who.email.trim().toLowerCase() === person.email;
        const member = session.session.memberships.some(
          (m) => m.tenantId === t && (m.role === "client_admin" || m.role === "client_user"),
        );
        if (!sameAddress) {
          // Nothing of the other account is kept on the client's record.
          await tx.insert(intakeEvent).values({ ...ref, kind: "wrong_account", meta: {} });
          return {
            view: {
              state: "wrong_account",
              invitedEmail: maskEmail(person.email),
            } as WelcomeSignedInView,
            refused: true,
          };
        }
        // The invited address, but not (or no longer) one of the client's people.
        if (!member) throw new HttpError(403, "no_access", "this account has no access here");
        if (!person.userId) {
          await tx
            .update(intakePerson)
            .set({ userId: who.id })
            .where(and(eq(intakePerson.id, person.id), eq(intakePerson.tenantId, t)));
        }
        await logOnce(tx, ref, "signed_in", {});
        return { view: { state: "ok", next: GETTING_STARTED_PATH } as WelcomeSignedInView };
      });
      await auditAlone(services.db, c, {
        tenantId: t,
        actorKind: "user",
        actorUserId: who.id,
        actorEmail: who.email,
        action: "intake.welcome_signed_in",
        outcome: result.refused ? "refused" : "ok",
        httpStatus: 200,
        target: { intake: i, person: p, state: result.view.state },
      });
      return c.json(welcomeSpecs.welcomeSignedIn.response.parse(result.view));
    } catch (error) {
      return errorResponse(c, error);
    }
  });

  mountPublic(app, welcomeSpecs.welcomeAskNew, async ({ c, services }) => {
    const link = await verifyWelcomeLink(services.env, tokenOf(c));
    if (!link) throw gone();
    const { t, i, p } = link.payload;
    const found = await withTenant(services.db, t, (tx) => invited(tx, { t, i, p }));
    if (!found) throw gone();
    const { person, it, client } = found;
    if (!link.expired && !isClosed(it, client)) {
      throw new HttpError(409, "still_open", "This link still works.");
    }
    const now = new Date();
    // DECISION: one to-do per person a day, however often the button is pressed; due the next
    // day, on the lead's list (or every operator's, when the intake names no lead).
    await withOperator(services.db, [t], (tx) =>
      addTodo(tx, {
        title: `Send ${person.name} at ${client.name} a new invite link`,
        owner: "operator",
        ownerUserId: it.leadUserId,
        clientId: t,
        about: { kind: "client", id: t },
        source: "system",
        why: link.expired
          ? "Their welcome link expired before they signed in."
          : "They opened an invite that is closed.",
        dueAt: new Date(now.getTime() + 24 * 60 * 60 * 1000),
        dedupeKey: `welcome-new-link:${person.id}:${now.toISOString().slice(0, 10)}`,
      }),
    );
    return { ok: true as const };
  });
}
