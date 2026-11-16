// Forms, "Request info" (docs/plan.md §1.115): the built-in skill `forms.request`, carried out here
// like reach out and conversations. It checks the form (the agent's or the operator's) against the
// step's ask, keeps one `form_request` row, and sends the link as a reach-out of its own, so every
// check reach out makes holds: consent, opt-out, quiet hours, the bound channel, the person's daily
// cap and the plan's approval (invariant 8), whose card also shows the form. Once sent, the step
// waits for the answers (the page's submit wakes the run) or the due date.

import {
  type Duration,
  documentsOf,
  dueProblem,
  FORM_MESSAGE_WORDS,
  FORMS_REQUEST_FIXED_INPUTS,
  type FormAsk,
  type FormDefinition,
  FormRequestInput,
  type FormRequestOutcome,
  type FormRequestOutput,
  fixedInputProblem,
  formEventType,
  formForRequest,
  formRequestId,
  isPlainObject,
  type JsonObject,
  LOCALES,
  type Locale,
  matchLocale,
  parseDuration,
  type ReachOutOutput,
  splitAnswers,
} from "@countersign/core";
import {
  contact,
  formRequest,
  inboxItem,
  reachOut,
  run,
  type Tx,
  tenant,
  withTenant,
} from "@countersign/db";
import type {
  ResumeRequest,
  SkillStepRequest,
  StepOutcome,
  WaitRequest,
} from "@countersign/workflows";
import { and, eq, gte, inArray, isNull, lte, sql } from "drizzle-orm";
import { reportHandled } from "../observability/report";
import { type ReachDeps, type ReachPort, reachOutEventType } from "../reach/service";
import { type FormLinks, formLinkUrl } from "./link";

export type FormRequestRow = typeof formRequest.$inferSelect;

export interface FormsDeps extends ReachDeps {
  /** Where links point and what signs them; without it nothing is sent. */
  links?: FormLinks;
}

export interface FormsPort {
  start(req: SkillStepRequest): Promise<StepOutcome>;
  resume(req: ResumeRequest): Promise<StepOutcome>;
  waitDone(req: WaitRequest): Promise<boolean>;
  afterWait(req: WaitRequest & { timedOut: boolean }): Promise<StepOutcome>;
}

/** What a waiting or approving step carries: the request, and the reach-out's own state while sending. */
interface FormState {
  id: string;
  reach?: unknown;
}

/** The form request a step's state names, or null for anything else. */
export function formsState(state: unknown): FormState | null {
  const form = isPlainObject(state) ? state.form : undefined;
  if (!isPlainObject(form) || typeof form.id !== "string") return null;
  return { id: form.id, ...(form.reach !== undefined ? { reach: form.reach } : {}) };
}

const wrap = (id: string, reach?: unknown) => ({
  form: { id, ...(reach !== undefined ? { reach } : {}) },
});

// DECISION: the page keeps working a day past the due date only to cover clocks and time zones;
// the request itself closes at its due date, when the step goes on without the answers.
const LINK_SLACK_MS = 24 * 3600_000;

function formatDue(due: Date, locale: Locale, timeZone: string | null): string {
  try {
    return new Intl.DateTimeFormat(locale, {
      dateStyle: "long",
      ...(timeZone ? { timeZone } : {}),
    }).format(due);
  } catch {
    return due.toISOString().slice(0, 10);
  }
}

/** The message that carries the link, in each language reach out may pick for the person. */
function messageTemplate(p: {
  client: string;
  title: string;
  dueAt: Date;
  timeZone: string | null;
  link: string;
}): Record<string, string> {
  const out: Record<string, string> = {};
  for (const locale of LOCALES) {
    out[locale] = FORM_MESSAGE_WORDS[locale]
      .text({ ...p, due: formatDue(p.dueAt, locale, p.timeZone) })
      .slice(0, 1600);
  }
  return out;
}

/** The form as an approval card shows it: titles and questions, never anything else. */
function cardForm(form: FormDefinition, ask: FormAsk) {
  const required = new Set(ask.required.map((q) => q.id));
  return {
    title: form.title,
    ...(form.intro ? { intro: form.intro } : {}),
    questions: form.questions.map((q) => ({
      id: q.id,
      label: q.label,
      type: q.type,
      required: q.required,
      // Whether the operator fixed it (else the agent added it).
      fixed: required.has(q.id),
    })),
  };
}

function output(
  row: FormRequestRow | null,
  end: {
    outcome: FormRequestOutcome;
    reason: string | null;
    contact: { id: string; name: string } | null;
    channel: string | null;
  },
  fallbackSources: string[] = [],
): FormRequestOutput {
  const definition = row?.definition as FormDefinition | undefined;
  const answers = row?.status === "submitted" && isPlainObject(row.answers) ? row.answers : null;
  const split = answers ? splitAnswers(answers, row?.ask as FormAsk) : null;
  const documents = answers && definition ? documentsOf(definition, answers) : [];
  return {
    outcome: end.outcome,
    formRequestId: row?.id ?? null,
    answers: split?.answers ?? null,
    extra: split?.extra ?? null,
    documents,
    contact: end.contact,
    channel: end.channel,
    submittedAt: row?.submittedAt?.toISOString() ?? null,
    reason: end.reason,
    sources: [...new Set([...(row?.sources ?? fallbackSources), ...documents])],
  };
}

/** The channel the link went out on, from the request's log. */
function sentChannel(row: FormRequestRow): string | null {
  const sent = (row.log ?? []).find((l) => l.kind === "sent");
  return typeof sent?.channel === "string" ? sent.channel : null;
}

export function formsPort(deps: FormsDeps, reach: ReachPort): FormsPort {
  const now = () => deps.now?.() ?? deps.runtime.now?.() ?? new Date();
  const { db } = deps;

  const getRow = (tenantId: string, id: string) =>
    withTenant(db, tenantId, async (tx) => {
      const [row] = await tx
        .select()
        .from(formRequest)
        .where(and(eq(formRequest.id, id), eq(formRequest.tenantId, tenantId)));
      const [who] = row
        ? await tx
            .select({ id: contact.id, name: contact.name })
            .from(contact)
            .where(and(eq(contact.id, row.contactId), eq(contact.tenantId, tenantId)))
        : [];
      return { row: row ?? null, who: who ?? null };
    });

  /** The step is over: kept on the row, so a retried step returns the same. */
  const finish = async (
    row: FormRequestRow,
    who: { id: string; name: string } | null,
    end: { outcome: FormRequestOutcome; reason: string | null; channel?: string | null },
  ): Promise<StepOutcome> => {
    await withTenant(db, row.tenantId, (tx) =>
      tx
        .update(formRequest)
        .set({ runReceivedAt: now() })
        .where(and(eq(formRequest.id, row.id), eq(formRequest.tenantId, row.tenantId))),
    );
    return {
      kind: "done",
      output: output(row, { ...end, contact: who, channel: end.channel ?? sentChannel(row) }),
    };
  };

  /** What an answered, expired or still-open request means for the step now. */
  const settle = async (tenantId: string, id: string, timedOut = false): Promise<StepOutcome> => {
    let { row, who } = await getRow(tenantId, id);
    if (!row) return { kind: "failed", error: "the form request is gone" };
    if (row.status === "submitted") return finish(row, who, { outcome: "submitted", reason: null });
    if (row.status === "open" && (timedOut || row.dueAt.getTime() <= now().getTime())) {
      row =
        (await withTenant(db, tenantId, (tx) => expireTx(tx, row as FormRequestRow, now()))) ?? row;
      if (row.status === "submitted") {
        return finish(row, who, { outcome: "submitted", reason: null });
      }
    }
    if (row.status === "expired") {
      return finish(row, who, { outcome: "no_answer", reason: "no answer by the due date" });
    }
    if (row.status === "cancelled" || row.status === "not_sent") {
      return finish(row, who, { outcome: "not_sent", reason: "the request was closed" });
    }
    const remaining = Math.max(60_000, row.dueAt.getTime() - now().getTime());
    return {
      kind: "waiting",
      wait: {
        eventType: formEventType(row.id),
        timeout: `${Math.ceil(remaining / 60_000)} minutes` as Duration,
        state: wrap(row.id),
      },
    };
  };

  /** The reach-out that carries the link answered: sent (wait for the form), or not. */
  const afterReach = async (
    tenantId: string,
    id: string,
    outcome: StepOutcome,
  ): Promise<StepOutcome> => {
    if (outcome.kind === "approval") {
      return {
        ...outcome,
        pending: { ...outcome.pending, state: wrap(id, outcome.pending.state) },
      };
    }
    if (outcome.kind === "waiting") {
      // Quiet hours hold the message: wait on the reach-out, and on the form too (the page's
      // submit sends the reach-out's event as well, so a quick answer wakes the run).
      return { ...outcome, wait: { ...outcome.wait, state: wrap(id, outcome.wait.state) } };
    }
    if (outcome.kind !== "done") return outcome;
    const sent = outcome.output as ReachOutOutput;
    const { row, who } = await getRow(tenantId, id);
    if (!row) return { kind: "failed", error: "the form request is gone" };
    if (row.status === "submitted") {
      return finish(row, who, { outcome: "submitted", reason: null, channel: sent.channel });
    }
    if (sent.attempts > 0 && sent.outcome !== "declined" && sent.outcome !== "opted_out") {
      await withTenant(db, tenantId, (tx) =>
        tx
          .update(formRequest)
          .set({
            status: "open",
            log: sql`${formRequest.log} || ${JSON.stringify([{ at: now().toISOString(), kind: "sent", channel: sent.channel }])}::jsonb`,
          })
          .where(
            and(
              eq(formRequest.id, id),
              eq(formRequest.tenantId, tenantId),
              eq(formRequest.status, "sending"),
            ),
          ),
      );
      return settle(tenantId, id);
    }
    const [closed] = await withTenant(db, tenantId, (tx) =>
      tx
        .update(formRequest)
        .set({ status: "not_sent" })
        .where(
          and(
            eq(formRequest.id, id),
            eq(formRequest.tenantId, tenantId),
            eq(formRequest.status, "sending"),
          ),
        )
        .returning(),
    );
    return finish(closed ?? row, who, {
      outcome: sent.outcome === "declined" ? "declined" : "not_sent",
      reason: sent.reason ?? "the message didn't go out",
      channel: sent.channel,
    });
  };

  return {
    async start(req) {
      const { run: info } = req;
      const parsed = FormRequestInput.safeParse(req.input);
      if (!parsed.success) {
        return { kind: "failed", error: `invalid input: ${parsed.error.message}` };
      }
      const input = parsed.data;
      // The purpose and the ask are the operator's: the step's own text, never a model's (§1.23).
      const problem = fixedInputProblem(FORMS_REQUEST_FIXED_INPUTS, req.step.input, req.input);
      if (problem) return { kind: "failed", error: `refused: forms.request: ${problem}` };
      const due = dueProblem(input.due);
      if (due) return { kind: "failed", error: `refused: forms.request: due ${due}` };
      const built = formForRequest(input);
      if (!built.ok) {
        // A form the agent wrote outside the step's limits fails the step, so its owner can
        // correct the input and retry; nothing was sent.
        const list = built.problems
          .map((p) => (p.question ? `${p.question}: ${p.message}` : p.message))
          .join("; ");
        return { kind: "failed", error: `refused: the form doesn't fit this step: ${list}` };
      }
      const form = built.form;
      const blank = { contact: null, channel: null };
      if (info.mode === "test") {
        // Test runs never send: the form as it would have gone.
        return {
          kind: "done",
          output: {
            ...output(
              null,
              { outcome: "not_sent", reason: "a test run: nothing was sent", ...blank },
              input.about,
            ),
            testRun: true,
            form,
          },
          notWritten: true,
        };
      }
      if (!deps.links) {
        return { kind: "failed", error: "forms.request needs the app's address and key" };
      }

      // A retried step finds its request.
      const [existing] = await withTenant(db, info.tenantId, (tx) =>
        tx
          .select()
          .from(formRequest)
          .where(
            and(
              eq(formRequest.tenantId, info.tenantId),
              eq(formRequest.runId, info.id),
              eq(formRequest.nodeId, req.nodeId),
            ),
          ),
      );
      if (existing) {
        if (existing.status !== "sending") return settle(info.tenantId, existing.id);
        // Still sending: the reach-out's own retry finds its row and answers where it is.
        const again = await reach.start(reachRequest(req, await messageFor(existing)));
        return afterReach(info.tenantId, existing.id, again);
      }

      const t = now();
      const dueAt = new Date(t.getTime() + parseDuration(input.due));
      const id = await formRequestId({ runId: info.id, nodeId: req.nodeId });
      const draft = {
        id,
        dueAt,
        purpose: input.purpose,
        definition: form,
        tenantId: info.tenantId,
      };
      const message = await messageFor(draft);
      const outcome = await reach.start(reachRequest(req, message));

      // The reach-out made its row (a plan waiting for approval, or sent), or refused outright.
      const [carrier] = await withTenant(db, info.tenantId, (tx) =>
        tx
          .select()
          .from(reachOut)
          .where(
            and(
              eq(reachOut.tenantId, info.tenantId),
              eq(reachOut.runId, info.id),
              eq(reachOut.nodeId, req.nodeId),
            ),
          ),
      );
      if (!carrier) {
        if (outcome.kind !== "done") return outcome;
        const sent = outcome.output as ReachOutOutput;
        return {
          kind: "done",
          output: output(
            null,
            {
              outcome: "not_sent",
              reason: sent.reason ?? "the message couldn't go out",
              contact: sent.contact,
              channel: null,
            },
            input.about,
          ),
        };
      }
      const language = (matchLocale(
        isPlainObject(carrier.plan) && typeof carrier.plan.language === "string"
          ? carrier.plan.language
          : null,
      ) ?? "en") as Locale;
      await withTenant(db, info.tenantId, async (tx) => {
        await tx
          .insert(formRequest)
          .values({
            id,
            tenantId: info.tenantId,
            agentId: info.agentId,
            agentVersionId: info.agentVersionId,
            runId: info.id,
            stepRunId: req.stepRunId,
            nodeId: req.nodeId,
            contactId: carrier.contactId,
            reachOutId: carrier.id,
            purpose: input.purpose,
            definition: form as unknown as JsonObject,
            ask: input.ask as unknown as JsonObject,
            status: "sending",
            language,
            dueAt,
            sources: input.about,
            log: [{ at: t.toISOString(), kind: "created" }],
          })
          .onConflictDoNothing();
        // The plan's card shows the form as it will go, so a person reads what the agent wrote
        // before the contact does.
        if (carrier.inboxItemId) {
          await tx
            .update(inboxItem)
            .set({
              payload: sql`${inboxItem.payload} || ${JSON.stringify({
                form: cardForm(form, input.ask),
              })}::jsonb`,
            })
            .where(
              and(eq(inboxItem.id, carrier.inboxItemId), eq(inboxItem.tenantId, info.tenantId)),
            );
        }
      });
      return afterReach(info.tenantId, id, outcome);

      // The message's words, with a link that names the request.
      async function messageFor(r: {
        id: string;
        dueAt: Date;
        purpose: string;
        definition: unknown;
        tenantId: string;
      }) {
        const [client] = await withTenant(db, r.tenantId, (tx) =>
          tx
            .select({ name: tenant.name, timezone: tenant.timezone })
            .from(tenant)
            .where(eq(tenant.id, r.tenantId)),
        );
        const title = (r.definition as FormDefinition).title;
        const link = await formLinkUrl(deps.links as FormLinks, {
          tenantId: r.tenantId,
          formRequestId: r.id,
          expiresAt: new Date(r.dueAt.getTime() + LINK_SLACK_MS),
        });
        const name = client?.name ?? "";
        return {
          template: messageTemplate({
            client: name,
            title,
            dueAt: r.dueAt,
            timeZone: client?.timezone ?? null,
            link,
          }),
          subject: FORM_MESSAGE_WORDS.en
            .subject({ client: name, title, due: "", link })
            .slice(0, 200),
        };
      }

      function reachRequest(
        r: SkillStepRequest,
        m: { template: Record<string, string>; subject: string },
      ): SkillStepRequest {
        return {
          ...r,
          // The reach-out checks its purpose against the step's own text, which is ours here.
          step: { ...r.step, input: { purpose: input.purpose } },
          input: {
            to: input.to,
            about: input.about,
            purpose: input.purpose,
            message: { template: m.template },
            subject: m.subject,
            urgency: "normal",
            // DECISION: the answer is the form, not a reply: the reach-out ends once the link is
            // sent, and the step waits on the form.
            expectReply: false,
            timeout: input.due,
          },
        };
      }
    },

    async resume(req) {
      const state = formsState(req.pending.state);
      if (!state) return { kind: "failed", error: "not a form request" };
      if (state.reach === undefined) return settle(req.run.tenantId, state.id);
      const r = await reach.resume({ ...req, pending: { ...req.pending, state: state.reach } });
      return afterReach(req.run.tenantId, state.id, r);
    },

    async waitDone(req) {
      const state = formsState(req.wait.state);
      if (!state) return true;
      const { row } = await getRow(req.run.tenantId, state.id);
      if (row?.status !== "open") {
        if (row?.status === "sending" && state.reach !== undefined) {
          return reach.waitDone({ ...req, wait: { ...req.wait, state: state.reach } });
        }
        return true;
      }
      return row.dueAt.getTime() <= now().getTime();
    },

    async afterWait(req) {
      const state = formsState(req.wait.state);
      if (!state) return { kind: "failed", error: "not a form request" };
      const { tenantId } = req.run;
      const { row } = await getRow(tenantId, state.id);
      if (row?.status === "sending" && state.reach !== undefined) {
        const r = await reach.afterWait({ ...req, wait: { ...req.wait, state: state.reach } });
        return afterReach(tenantId, state.id, r);
      }
      return settle(tenantId, state.id, req.timedOut);
    },
  };
}

/** Closes an open request at its due date; null when it was answered or closed meanwhile. */
async function expireTx(tx: Tx, row: FormRequestRow, at: Date): Promise<FormRequestRow | null> {
  const [updated] = await tx
    .update(formRequest)
    .set({
      status: "expired",
      log: sql`${formRequest.log} || ${JSON.stringify([{ at: at.toISOString(), kind: "expired" }])}::jsonb`,
    })
    .where(
      and(
        eq(formRequest.id, row.id),
        eq(formRequest.tenantId, row.tenantId),
        inArray(formRequest.status, ["open", "sending"]),
      ),
    )
    .returning();
  if (updated) return updated;
  const [now] = await tx
    .select()
    .from(formRequest)
    .where(and(eq(formRequest.id, row.id), eq(formRequest.tenantId, row.tenantId)));
  return now ?? null;
}

/** Wakes the run waiting on a request (best effort: the cron re-sends until the run takes it). */
export async function wakeForm(
  deps: Pick<ReachDeps, "instances">,
  row: Pick<FormRequestRow, "id" | "runId" | "reachOutId">,
): Promise<void> {
  if (!deps.instances) return;
  try {
    await deps.instances.sendEvent(row.runId, {
      type: formEventType(row.id),
      payload: { formRequestId: row.id },
    });
    // A request whose link was held by quiet hours waits on its reach-out's event.
    if (row.reachOutId) {
      await deps.instances.sendEvent(row.runId, {
        type: reachOutEventType(row.reachOutId),
        payload: { reachOutId: row.reachOutId },
      });
    }
  } catch (error) {
    reportHandled(`waking run ${row.runId} for form request ${row.id} failed`, error, {
      job: "forms",
    });
  }
}

const REDELIVER_WINDOW_MS = 24 * 3600_000;
const REDELIVER_AFTER_MS = 60_000;

/**
 * One client's form requests, each minute: close those past their due date (the run goes on
 * without the answers) and re-send the event of each answered or closed one its run hasn't taken.
 */
export async function formsTick(
  deps: Pick<ReachDeps, "db" | "instances">,
  tenantId: string,
  at: Date,
): Promise<{ expired: number; woken: number }> {
  const { db } = deps;
  const result = { expired: 0, woken: 0 };
  const overdue = await withTenant(db, tenantId, async (tx) => {
    const rows = await tx
      .select()
      .from(formRequest)
      .where(
        and(
          eq(formRequest.tenantId, tenantId),
          eq(formRequest.status, "open"),
          lte(formRequest.dueAt, at),
        ),
      )
      .limit(200);
    const out: FormRequestRow[] = [];
    for (const row of rows) {
      const e = await expireTx(tx, row, at);
      if (e?.status === "expired") out.push(e);
    }
    return out;
  });
  for (const row of overdue) {
    result.expired++;
    await wakeForm(deps, row);
  }
  const pending = await withTenant(db, tenantId, (tx) =>
    tx
      .select({ id: formRequest.id, runId: formRequest.runId, reachOutId: formRequest.reachOutId })
      .from(formRequest)
      .innerJoin(run, and(eq(run.id, formRequest.runId), eq(run.tenantId, formRequest.tenantId)))
      .where(
        and(
          eq(formRequest.tenantId, tenantId),
          inArray(formRequest.status, ["submitted", "expired"]),
          isNull(formRequest.runReceivedAt),
          lte(formRequest.updatedAt, new Date(at.getTime() - REDELIVER_AFTER_MS)),
          gte(formRequest.updatedAt, new Date(at.getTime() - REDELIVER_WINDOW_MS)),
          inArray(run.status, ["queued", "running", "waiting"]),
        ),
      )
      .limit(200),
  );
  for (const row of pending) {
    result.woken++;
    await wakeForm(deps, row);
  }
  return result;
}
