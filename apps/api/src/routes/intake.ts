// The intake (docs/plan.md §1.149, §1.149.2; docs/cases-plan.md §4.5): the back office reads a
// client's intakes (the build's Requirements panel reads its card from them); the client's people
// read and answer theirs on Getting started, each only the sections they were asked (all of them for
// the admin). Answers are data (invariant 9), checked against their field's kind (core
// `checkAnswer`); secrets are never asked and pasted card and social security numbers are redacted
// before storage. The portal's views carry no `ours` fact, no fact id and nothing of ours
// (invariant 11). Every route goes through `mount`, which writes the audit row (invariant 14).

import {
  checkAnswer,
  fieldFor,
  type GuideField,
  type IntakeAnswerInput,
  opsIntakeRoutes,
  parseCoveredProcessors,
  portalIntakeRoutes,
  redactAnswer,
  visibleSectionKeys,
} from "@countersign/core";
import {
  appUser,
  connection,
  document,
  intake,
  intakeAnswer,
  intakeEvent,
  intakePerson,
  membership,
  type Tx,
  tenant,
  todo,
} from "@countersign/db";
import { and, desc, eq, inArray } from "drizzle-orm";
import type { Hono } from "hono";
import { type AppEnv, HttpError, mount, notFound } from "../http";
import { notifyDepsFromEnv, sendNow } from "../notify/tick";
import {
  brandedEmailCanGo,
  onboardingEmailRefusal,
  sendOnboardingEmail,
  unsentInvite,
  unsentTodoKey,
} from "../onboarding/emails";
import {
  claimPerson,
  currentIntake,
  ensureOpen,
  isOpen,
  loadIntake,
  markOpen,
  opsSummary,
  opsView,
  type PersonRow,
  personView,
  portalView,
  readIntake,
  type Viewer,
  viewerOn,
} from "../onboarding/intake";
import { createAsk } from "../work/asks";
import { inviteToClient } from "./onboarding";

const viewerOf = (ctx: {
  session: { user: { id: string; email: string } };
  role: string;
}): Viewer => ({
  userId: ctx.session.user.id,
  email: ctx.session.user.email,
  role: ctx.role,
});

const tenantOf = (tenantIds: readonly string[]): string => {
  const id = tenantIds[0];
  if (!id) throw new HttpError(403, "forbidden", "a portal request acts for exactly one client");
  return id;
};

/** The intake a client's person may act on, with who they are on it and what they see. */
async function acting(tx: Tx, tenantIds: readonly string[], id: string, viewer: Viewer) {
  const row = await readIntake(tx, tenantIds, id, true);
  const d = await loadIntake(tx, row);
  const who = viewerOn(d.people, viewer);
  // An intake that didn't ask this person is not theirs to see.
  if (!who) throw notFound("intake");
  ensureOpen(row);
  return { row, d, who, visible: visibleSectionKeys(d.guide, who.sections) };
}

/** The field, if this person may answer it; else 422. */
function answerable(
  d: Awaited<ReturnType<typeof loadIntake>>,
  fieldKey: string,
  visible: readonly string[],
): GuideField {
  const field = fieldFor(d.guide, fieldKey, visible);
  if (!field || field.state === "known") {
    throw new HttpError(422, "unknown_field", `${fieldKey} isn't a question on your cards`);
  }
  return field;
}

/** A tool's answer names one of the client's own connections of that tool; files its documents. */
async function checkRefs(tx: Tx, tenantId: string, field: GuideField, value: unknown) {
  if (field.kind === "tool") {
    const id = (value as { connectionId: string }).connectionId;
    const [c] = await tx
      .select({ id: connection.id })
      .from(connection)
      .where(
        and(
          eq(connection.id, id),
          eq(connection.tenantId, tenantId),
          eq(connection.connector, field.connector ?? ""),
        ),
      );
    if (!c)
      throw new HttpError(422, "invalid_answer", `${field.label}: not one of your connections`);
  }
  if (field.kind === "files") {
    const ids = [...new Set((value as { documentIds: string[] }).documentIds)];
    const found = await tx
      .select({ id: document.id })
      .from(document)
      .where(and(inArray(document.id, ids), eq(document.tenantId, tenantId)));
    if (found.length !== ids.length) {
      throw new HttpError(422, "invalid_answer", `${field.label}: not one of your documents`);
    }
  }
}

async function logEvent(
  tx: Tx,
  row: { id: string; tenantId: string },
  kind: (typeof intakeEvent.$inferInsert)["kind"],
  personId: string | null,
  meta: Record<string, unknown>,
) {
  await tx
    .insert(intakeEvent)
    .values({ tenantId: row.tenantId, intakeId: row.id, kind, personId, meta });
}

export function intakeRoutes(app: Hono<AppEnv>): void {
  // ── The back office ────────────────────────────────────────────────────────────────────────────
  mount(app, opsIntakeRoutes.opsIntakes, async ({ tx, tenantIds, query }) => {
    if (query.client && !tenantIds.includes(query.client)) return { intakes: [] };
    const rows = await tx
      .select()
      .from(intake)
      .where(
        and(
          inArray(intake.tenantId, query.client ? [query.client] : [...tenantIds]),
          ...(query.file ? [eq(intake.fileId, query.file)] : []),
          ...(query.status ? [eq(intake.status, query.status)] : []),
        ),
      )
      .orderBy(desc(intake.createdAt))
      .limit(200);
    return { intakes: await opsSummary(tx, rows) };
  });

  mount(app, opsIntakeRoutes.opsIntake, async ({ tx, tenantIds, params }) =>
    opsView(tx, await readIntake(tx, tenantIds, params.id)),
  );

  // §1.220 (C7): Send it again, for an invite that didn't go out (skipped, failed or bounced). The
  // same invite is queued under a key of its own (once per invite it replaces), sent at once, and
  // the lead's "didn't go out" to-do is done.
  mount(app, opsIntakeRoutes.opsIntakeSendAgain, async (ctx) => {
    const { tx, tenantIds, params, services, session } = ctx;
    const row = await readIntake(tx, tenantIds, params.id, true);
    if (!isOpen(row)) {
      throw new HttpError(409, "closed", "This intake is done or cancelled.");
    }
    const [person] = await tx
      .select()
      .from(intakePerson)
      .where(
        and(
          eq(intakePerson.id, params.personId),
          eq(intakePerson.tenantId, row.tenantId),
          eq(intakePerson.intakeId, row.id),
        ),
      );
    if (!person) throw notFound("person");
    const previous = await unsentInvite(tx, row.tenantId, person.id);
    if (!previous) {
      throw new HttpError(409, "not_unsent", "Their invite went out, or is still waiting to.");
    }
    const [t] = await tx.select().from(tenant).where(eq(tenant.id, row.tenantId));
    const settings = (t?.settings ?? {}) as Record<string, unknown>;
    const refusal = onboardingEmailRefusal(
      settings,
      parseCoveredProcessors(services.env.BAA_PROCESSORS),
    );
    if (refusal) throw new HttpError(409, "hipaa", refusal);
    // DECISION: it is refused while it would only be skipped again (no Resend, no link key here),
    // so the lead's to-do stays until it can go.
    if (!brandedEmailCanGo(services.env, settings)) {
      throw new HttpError(409, "cannot_send", "Email can't be sent from here yet.");
    }
    const sent = await sendOnboardingEmail(
      { tx, env: services.env },
      {
        kind: "invite",
        tenantId: row.tenantId,
        intakeId: row.id,
        personId: person.id,
        again: previous,
      },
    );
    await tx
      .update(todo)
      .set({ state: "done", doneAt: new Date(), doneBy: session.user.id })
      .where(
        and(eq(todo.dedupeKey, unsentTodoKey(previous)), inArray(todo.state, ["open", "snoozed"])),
      );
    if (sent.status === "queued") {
      ctx.afterCommit(() =>
        sendNow(
          services.db,
          notifyDepsFromEnv(services.env, services.deps.fetch?.(services.env)),
          row.tenantId,
          new Date(),
        ),
      );
    }
    return { status: sent.status, notificationId: sent.notificationId };
  });

  // ── The portal: Getting started ────────────────────────────────────────────────────────────────
  mount(app, portalIntakeRoutes.portalCurrentIntake, async (ctx) => {
    const tenantId = tenantOf(ctx.tenantIds);
    const viewer = viewerOf(ctx);
    for (const row of await currentIntake(ctx.tx, tenantId, new Date())) {
      const d = await loadIntake(ctx.tx, row);
      if (viewerOn(d.people, viewer)) return { intake: await portalView(ctx.tx, row, viewer) };
    }
    return { intake: null };
  });

  mount(app, portalIntakeRoutes.portalIntake, async (ctx) =>
    portalView(ctx.tx, await readIntake(ctx.tx, ctx.tenantIds, ctx.params.id), viewerOf(ctx)),
  );

  mount(app, portalIntakeRoutes.portalIntakeAnswer, async (ctx) => {
    const { tx, tenantIds, params, body, session } = ctx;
    const viewer = viewerOf(ctx);
    const { row, d, who, visible } = await acting(tx, tenantIds, params.id, viewer);
    const values: (typeof intakeAnswer.$inferInsert)[] = [];
    for (const a of body.answers as IntakeAnswerInput[]) {
      const field = answerable(d, a.fieldKey, visible);
      let value: unknown = null;
      if (a.state === "answered") {
        const checked = checkAnswer(field, a.value);
        if (!checked.ok) {
          throw new HttpError(422, "invalid_answer", `${field.label}: ${checked.message}`);
        }
        await checkRefs(tx, row.tenantId, field, checked.value);
        value = checked.value;
      }
      values.push({
        tenantId: row.tenantId,
        intakeId: row.id,
        fieldKey: field.key,
        value,
        state: a.state,
        source: body.source,
        userId: session.user.id,
      });
    }
    await tx.insert(intakeAnswer).values(values);
    await claimPerson(tx, who.person, session.user.id);
    await logEvent(tx, row, "answered", who.person?.id ?? null, {
      fields: values.map((v) => v.fieldKey),
      source: body.source,
    });
    await markOpen(tx, row);
    return portalView(tx, await readIntake(tx, tenantIds, row.id), viewer);
  });

  mount(app, portalIntakeRoutes.portalIntakeConfirm, async (ctx) => {
    const { tx, tenantIds, params, body, session } = ctx;
    const viewer = viewerOf(ctx);
    const { row, d, who, visible } = await acting(tx, tenantIds, params.id, viewer);
    if (!visible.includes(body.sectionKey)) throw notFound("section");
    const values: (typeof intakeAnswer.$inferInsert)[] = [];
    for (const f of body.fields) {
      const field = answerable(d, f.fieldKey, visible);
      let value: unknown;
      let state: "confirmed" | "corrected";
      if (f.value === undefined) {
        // Yes: what we think is right. Only a "We think" line can be said yes to.
        if (!field.weThink) {
          throw new HttpError(422, "nothing_to_confirm", `${field.label}: answer it instead`);
        }
        value = redactAnswer(field.weThink.value);
        state = "confirmed";
      } else {
        const checked = checkAnswer(field, f.value);
        if (!checked.ok) {
          throw new HttpError(422, "invalid_answer", `${field.label}: ${checked.message}`);
        }
        await checkRefs(tx, row.tenantId, field, checked.value);
        value = checked.value;
        state = "corrected";
      }
      values.push({
        tenantId: row.tenantId,
        intakeId: row.id,
        fieldKey: field.key,
        value,
        state,
        source: "form",
        userId: session.user.id,
      });
    }
    if (values.length > 0) {
      await tx.insert(intakeAnswer).values(values);
      await logEvent(tx, row, "answered", who.person?.id ?? null, {
        fields: values.map((v) => v.fieldKey),
        source: "form",
      });
    }
    if (body.decision) {
      await logEvent(
        tx,
        row,
        body.decision === "start" ? "section_started" : "section_not_now",
        who.person?.id ?? null,
        { sectionKey: body.sectionKey },
      );
    }
    await claimPerson(tx, who.person, session.user.id);
    await markOpen(tx, row);
    return portalView(tx, await readIntake(tx, tenantIds, row.id), viewer);
  });

  mount(app, portalIntakeRoutes.portalIntakeAsk, async (ctx) => {
    const { tx, tenantIds, params, body, session, services } = ctx;
    const viewer = viewerOf(ctx);
    const { row, d, who, visible } = await acting(tx, tenantIds, params.id, viewer);
    // HIPAA mode (§1.35, invariant 14): the colleague's email names them and the client to Resend.
    const [client] = await tx
      .select({ settings: tenant.settings })
      .from(tenant)
      .where(eq(tenant.id, row.tenantId));
    const settings = (client?.settings ?? null) as Record<string, unknown> | null;
    const refusal = onboardingEmailRefusal(
      settings,
      parseCoveredProcessors(services.env.BAA_PROCESSORS),
    );
    if (refusal) throw new HttpError(409, "hipaa", refusal);
    const branded = brandedEmailCanGo(services.env, settings);
    // A card, or one question (its card goes to them, the question marked as theirs).
    let sectionKey: string;
    let about: string;
    if (body.fieldKey) {
      const field = answerable(d, body.fieldKey, visible);
      sectionKey = field.sectionKey;
      about = field.label;
    } else {
      sectionKey = body.sectionKey as string;
      if (!visible.includes(sectionKey)) throw notFound("section");
      about = d.guide.sections.find((s) => s.key === sectionKey)?.title ?? sectionKey;
    }

    // Who: one of the client's people already, or a new address (the admin's to invite, §1.14).
    let colleague: { userId: string; email: string; name: string };
    if (body.userId) {
      const [m] = await tx
        .select({
          userId: appUser.id,
          email: appUser.email,
          name: appUser.name,
          role: membership.role,
        })
        .from(membership)
        .innerJoin(appUser, eq(appUser.id, membership.userId))
        .where(and(eq(membership.tenantId, row.tenantId), eq(membership.userId, body.userId)));
      // The portal never learns who serves the client: an operator is "not found".
      if (!m || m.role === "operator") throw notFound("member");
      colleague = { userId: m.userId, email: m.email, name: m.name?.trim() || m.email };
    } else {
      if (ctx.role !== "client_admin") {
        throw new HttpError(403, "admin_only", "only your admin can invite someone new");
      }
      const email = (body.email as string).toLowerCase();
      const [existing] = await tx
        .select({ userId: appUser.id, name: appUser.name, role: membership.role })
        .from(membership)
        .innerJoin(appUser, eq(appUser.id, membership.userId))
        .where(and(eq(membership.tenantId, row.tenantId), eq(appUser.email, email)));
      if (existing && existing.role !== "operator") {
        colleague = {
          userId: existing.userId,
          email,
          name: existing.name?.trim() || (body.name as string),
        };
      } else {
        // DECISION (cases-plan §4.4, one email, not two): the sign-in provider sends nothing; the
        // colleague gets our own branded email ("A colleague asked"). When ours can't go from
        // here, the provider's invitation goes instead (review).
        const invited = await inviteToClient(
          ctx,
          row.tenantId,
          { email, name: body.name, role: "client_user" },
          { surface: "portal", ...(branded ? { providerEmail: false } : {}) },
        );
        colleague = { userId: invited.member.userId, email, name: invited.member.name ?? email };
      }
    }
    if (colleague.userId === session.user.id) {
      throw new HttpError(422, "yourself", "ask someone other than yourself");
    }

    // Their place on the intake: the card added to theirs, or a new person with that card.
    const [had] = await tx
      .select()
      .from(intakePerson)
      .where(and(eq(intakePerson.intakeId, row.id), eq(intakePerson.email, colleague.email)));
    let person: PersonRow;
    if (had) {
      const sections =
        had.sections === null || had.sections.includes(sectionKey)
          ? had.sections
          : [...had.sections, sectionKey];
      const [updated] = await tx
        .update(intakePerson)
        .set({ sections, userId: had.userId ?? colleague.userId })
        .where(and(eq(intakePerson.id, had.id), eq(intakePerson.tenantId, row.tenantId)))
        .returning();
      person = updated ?? had;
    } else {
      const [made] = await tx
        .insert(intakePerson)
        .values({
          tenantId: row.tenantId,
          intakeId: row.id,
          userId: colleague.userId,
          email: colleague.email,
          name: colleague.name.slice(0, 200),
          sections: [sectionKey],
          isAdmin: false,
          invitedBy: session.user.id,
        })
        .returning();
      if (!made) throw new Error("intake person insert returned nothing");
      person = made;
    }
    // The ask itself, in the asker's words (data, redacted): sendOnboardingEmail logs the email's
    // own `colleague_invited`.
    await logEvent(tx, row, "asked", who.person?.id ?? null, {
      personId: person.id,
      sectionKey,
      ...(body.fieldKey ? { fieldKey: body.fieldKey } : {}),
      ...(body.note ? { note: redactAnswer(body.note) } : {}),
    });
    const sent = branded
      ? await sendOnboardingEmail(
          { tx, env: services.env },
          {
            kind: "colleague",
            tenantId: row.tenantId,
            intakeId: row.id,
            personId: person.id,
            askedByUserId: session.user.id,
            about: [about],
          },
        )
      : null;
    if (sent?.status === "queued") {
      ctx.afterCommit(() =>
        sendNow(
          services.db,
          notifyDepsFromEnv(services.env, services.deps.fetch?.(services.env)),
          row.tenantId,
          new Date(),
        ),
      );
    }
    await claimPerson(tx, who.person, session.user.id);
    await markOpen(tx, row);
    return {
      person: personView(person),
      emailed: sent !== null && sent.status !== "skipped",
    };
  });

  mount(app, portalIntakeRoutes.portalIntakeDifferentProcess, async (ctx) => {
    const { tx, tenantIds, params, body, session } = ctx;
    const viewer = viewerOf(ctx);
    const { row, d, who, visible } = await acting(tx, tenantIds, params.id, viewer);
    if (body.sectionKey && !visible.includes(body.sectionKey)) throw notFound("section");
    const title = body.sectionKey
      ? d.guide.sections.find((s) => s.key === body.sectionKey)?.title
      : undefined;
    const text = redactAnswer(body.text);
    // To the lead as an ask (§1.124's Build), in the client's words: data, never instructions.
    // DECISION: it goes into the client file with the next wave's filing (Reggie, O5); until then
    // the ask and the intake's log hold it, and the lead files it by hand.
    const ask = await createAsk(tx, {
      tenantId: row.tenantId,
      title: title ? `A different process: ${title}` : "A different process in mind",
      text,
      source: "portal",
      raisedBy: session.user.id,
      opening: true,
    });
    await logEvent(tx, row, "different_process", who.person?.id ?? null, {
      askId: ask.id,
      ...(body.sectionKey ? { sectionKey: body.sectionKey } : {}),
    });
    await claimPerson(tx, who.person, session.user.id);
    await markOpen(tx, row);
    return { ok: true as const };
  });
}
