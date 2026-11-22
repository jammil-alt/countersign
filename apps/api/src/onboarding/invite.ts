// Invite and Sign up now (docs/cases-plan.md §4.2, §4.3; docs/plan.md §1.149): one function both
// routes run. From the draft it makes the client (or uses the one there is) with the operator
// serving it, invites its people (§1.14's refusals first: an operator's address, someone in another
// client), adds the covered templates' agents on the bench with approvals on and a build each at
// Requirements request, opens the intake with the guide built from the file's `theirs` facts
// (core `buildGuide`), files the client file to the client, and moves the deal (a New account deal
// at Set up the account with the stages before it skipped, "signed up directly"; an Expansion deal
// at Agreed) or opens one. What a later stage wants and wasn't given becomes a to-do on Your call.
// Always a person's confirm (cases-plan §6): only the operator's routes call this, never Reggie or
// the MCP server.
//
// How it commits, "as §1.14's new client": the client, its deal and its file in one transaction
// (`opsCreateClient` through `invokeRoute`, audited, which logs it in Sales once:
// ./account-deal.ts); then the people, the intake, the deal's agents and to-dos and the emails'
// outbox rows in a second (the emails go after the commit, from the outbox); then a build per
// template through `opsStartBuild`, each its own. A build that fails leaves a to-do to open it
// from the deal; nothing else is undone.

import {
  addToGuide,
  buildGuide,
  type Covers,
  clientLanguage,
  coversAnything,
  DEFAULT_LOCALE,
  type DealKind,
  type DealStage,
  dealStageIndex,
  dealStageOf,
  Guide,
  type GuideFact,
  type InviteDraft,
  type InvitePreview,
  type InviteProblem,
  type InviteSent,
  type Locale,
  type OnboardingEmailPreview,
  OPEN_INTAKE_STATUSES,
  parseCoveredProcessors,
  parseLocale,
  type RouteSpec,
  renderInviteEmail,
  renderMoreQuestionsEmail,
  routes,
  SIGNED_UP_DIRECTLY,
  type SignUpNowDraft,
  sectionKeysOf,
  shortDay,
  stagesBefore,
  toNumeric,
  WELCOME_LINK_TTL_DAYS,
  type WelcomePageView,
  welcomePagePath,
  wholeMoney,
} from "@countersign/core";
import {
  appUser,
  build,
  deal,
  dealPerson,
  intake,
  intakePerson,
  membershipsOfUser,
  type Tx,
  tenant,
  todo,
  withOperator,
} from "@countersign/db";
import { and, asc, desc, eq, inArray } from "drizzle-orm";
import type { Hono } from "hono";
import {
  type AppEnv,
  ensureClient,
  HttpError,
  invokeRoute,
  type LongHandlerCtx,
  type Services,
} from "../http";
import { notifyDepsFromEnv, sendNow } from "../notify/tick";
import { reportHandled } from "../observability/report";
import { inviteToClient } from "../routes/onboarding";
import { openBuilds, servingToo } from "../work/deal-setup";
import { addSkippedBefore, addWantedTodos, moveDealStage, wantedTodos } from "../work/deal-stages";
import { addActivity, type DealRow, readDeal, salesToday } from "../work/deals";
import { addTodo, closeTodosAbout } from "../work/todos-store";
import { brandedEmailCanGo, onboardingEmailRefusal, sendOnboardingEmail } from "./emails";
import {
  ensureClientFile,
  type FileRow,
  linkFileToClient,
  openNewDealFor,
  prospectFileNamed,
  readFile,
  servedClientNamed,
  theirFactsOf,
} from "./files";
import { guideSources } from "./guide-sources";
import { emptyGuide, coversOf as storedCovers } from "./intake";
import { AREA_WORDS, readStart, sellableTemplates } from "./starts";

/** Which route ran it: Invite's side panel, or Sign up now (a start's defaults, resolved to a draft). */
export type InviteVia = "invite" | "sign_up";

/** What the run needs from its route: the app (for `invokeRoute`) and the slow route's context. */
export interface InviteRun {
  app: Hono<AppEnv>;
  ctx: LongHandlerCtx<RouteSpec>;
  via: InviteVia;
  /** Sign up now: the start it came from (the draft's covers, note and mode are its own). */
  startId?: string;
}

type Session = LongHandlerCtx<RouteSpec>["session"];

/** Why the stages before Set up the account (or Agreed) were skipped, by route. */
// DECISION: Sign up now says "signed up directly" (cases-plan §4.3); Invite says it was invited
// (a general intake before the proposal moves the deal early, §3.1).
const WHY: Record<InviteVia, string> = {
  sign_up: SIGNED_UP_DIRECTLY,
  invite: "invited to set up the account",
};

interface PersonPlan {
  name: string;
  email: string;
  isAdmin: boolean;
  sections: string[] | null;
  language: Locale | null;
  /** Their user, when the address is known. */
  userId: string | null;
  /** Already in this client: asked in the intake, not invited again. */
  member: boolean;
}

interface DealPlan {
  /** The deal it moves; null: a new one is opened. */
  row: DealRow | null;
  kind: DealKind;
  /** Where it ends: Set up the account for a new account, Agreed for expansion. */
  to: DealStage;
  /** Null: no deal is moved (only people invited to an existing client). */
  none: boolean;
}

/** The client's open intake a later Invite adds to (cases-plan §3.2: one intake per client). */
interface OpenIntakePlan {
  id: string;
  /** What it covered before this Invite. */
  covers: Covers;
  people: (typeof intakePerson.$inferSelect)[];
  /** The cards this Invite adds: their keys and titles. */
  added: { key: string; title: string }[];
}

/** Someone already on the open intake who is told "A few more questions" about the new cards. */
interface ToldPlan {
  personId: string;
  email: string;
  name: string;
  language: Locale | null;
  /** The new cards they see. */
  titles: string[];
}

interface Plan {
  via: InviteVia;
  draft: InviteDraft;
  account: { clientId: string | null; name: string; language: Locale | null };
  /** Null: a new intake (or none). */
  openIntake: OpenIntakePlan | null;
  /** Those already on the open intake who see a new card. */
  told: ToldPlan[];
  /** Whether the branded email goes from here (else the sign-in provider's invitation does). */
  branded: boolean;
  /**
   * §1.220: Just the account for a new account, with our email able to go: an intake that covers
   * nothing is opened so each person gets our invite, which then reads as a welcome ("What's in
   * it: your account"), instead of the sign-in provider's invitation.
   */
  welcomeOnly: boolean;
  /** A new account's file or deal found in Sales by the company's name (shown to confirm). */
  foundByName: boolean;
  file: FileRow | null;
  deal: DealPlan;
  covers: Covers;
  hasIntake: boolean;
  guide: Guide | null;
  templates: { id: string; name: string }[];
  people: PersonPlan[];
  problems: InviteProblem[];
  todos: { title: string; dueOn: string }[];
  lead: { id: string; name: string; email: string };
  title: string;
}

const firstName = (name: string) => name.trim().split(/\s+/)[0] ?? name;

/** "A, B and C". */
function listWords(xs: readonly string[]): string {
  if (xs.length <= 1) return xs[0] ?? "";
  return `${xs.slice(0, -1).join(", ")} and ${xs.at(-1)}`;
}

/** What an intake covers, in the confirmation's words: "general, Purchasing, 1 agent". */
export function coversWords(covers: Covers): string {
  const parts = [
    ...(covers.general ? ["general"] : []),
    ...covers.areas.map((a) => AREA_WORDS[a]),
    ...(covers.templateIds.length > 0
      ? [`${covers.templateIds.length} ${covers.templateIds.length === 1 ? "agent" : "agents"}`]
      : []),
  ];
  return parts.join(", ");
}

/** A guide section key's title for the confirmation ("the Purchasing questions"). */
function sectionWords(key: string, templates: { id: string; name: string }[]): string {
  if (key === "general") return "general";
  if (key.startsWith("area:")) return AREA_WORDS[key.slice(5) as keyof typeof AREA_WORDS] ?? key;
  const id = key.slice("agent:".length);
  return templates.find((t) => t.id === id)?.name ?? "agent";
}

// ── Planning: what it will do, read only ────────────────────────────────────────────────────────

/** A person's sections once this Invite asks them more: null (the whole intake) stays null. */
function mergedSections(had: string[] | null, asked: string[] | null): string[] | null {
  if (had === null || asked === null) return null;
  return [...new Set([...had, ...asked])];
}

const parseLocaleOrNull = (v: string | null): Locale | null => (v ? parseLocale(v) : null);

async function leadOf(tx: Tx, session: Session): Promise<Plan["lead"]> {
  const [u] = await tx
    .select({ name: appUser.name, email: appUser.email })
    .from(appUser)
    .where(eq(appUser.id, session.user.id));
  const email = u?.email ?? session.user.email;
  return { id: session.user.id, name: u?.name?.trim() || email, email };
}

/** A person's refusal (§1.14): an operator's address, or someone in another client. */
async function personPlan(
  tx: Tx,
  p: InviteDraft["people"][number],
  clientId: string | null,
): Promise<{ plan: PersonPlan; problem: InviteProblem | null }> {
  const email = p.email.trim().toLowerCase();
  const plan: PersonPlan = {
    name: p.name,
    email,
    isAdmin: p.isAdmin,
    sections: p.sections ?? null,
    language: p.language ?? null,
    userId: null,
    member: false,
  };
  const [existing] = await tx
    .select({ id: appUser.id })
    .from(appUser)
    .where(eq(appUser.email, email));
  if (!existing) return { plan, problem: null };
  plan.userId = existing.id;
  const theirs = await membershipsOfUser(tx, existing.id);
  if (theirs.some((m) => m.role === "operator")) {
    return {
      plan,
      problem: { email, code: "is_operator", message: `${email} is a Mezonas operator` },
    };
  }
  if (clientId && theirs.some((m) => m.tenantId === clientId)) {
    plan.member = true;
    return { plan, problem: null };
  }
  if (theirs.length > 0) {
    return {
      plan,
      problem: { email, code: "other_client", message: `${email} belongs to another client` },
    };
  }
  return { plan, problem: null };
}

/** The open deal an existing client's invite moves, or what it opens. */
async function clientDeal(
  tx: Tx,
  tenantIds: readonly string[],
  clientId: string,
  named: DealRow | null,
  sells: boolean,
): Promise<DealPlan> {
  if (named) {
    if (named.clientId !== clientId) {
      throw new HttpError(422, "other_client", "that deal is another client's");
    }
    const kind = named.kind as DealKind;
    return { row: named, kind, to: kind === "new" ? "setup" : "agreed", none: false };
  }
  // DECISION: only people, no intake, no price and not a sign-up: nothing to sell, so no deal
  // moves. A sign-up or an agreed price is an Expansion deal at Agreed (cases-plan §4.3), even
  // with nothing covered (review).
  if (!sells) return { row: null, kind: "expansion", to: "agreed", none: true };
  const open = await tx
    .select()
    .from(deal)
    .where(
      and(
        eq(deal.clientId, clientId),
        eq(deal.outcome, "open"),
        inArray(deal.clientId, [...tenantIds]),
      ),
    )
    .orderBy(desc(deal.updatedAt));
  // An expansion in play moves to Agreed; a New account deal still at Set up the account takes the
  // intake (the account was made, the intake follows); else an Expansion deal opens at Agreed.
  const grow = open.find((d) => d.kind === "expansion");
  if (grow) return { row: grow, kind: "expansion", to: "agreed", none: false };
  const fresh = open.find((d) => d.kind === "new");
  if (fresh) return { row: fresh, kind: "new", to: "setup", none: false };
  return { row: null, kind: "expansion", to: "agreed", none: false };
}

async function planInvite(
  tx: Tx,
  tenantIds: readonly string[],
  session: Session,
  services: Services,
  draft: InviteDraft,
  via: InviteVia,
): Promise<Plan> {
  let named = draft.dealId ? await readDeal(tx, tenantIds, draft.dealId) : null;
  if (named && named.outcome !== "open") {
    throw new HttpError(409, "deal_closed", "that deal is closed");
  }
  let file = draft.fileId
    ? await readFile(tx, tenantIds, draft.fileId)
    : named?.clientFileId
      ? await readFile(tx, tenantIds, named.clientFileId)
      : null;
  const clientId = draft.clientId ?? file?.clientId ?? named?.clientId ?? null;
  if (clientId) {
    ensureClient({ tenantIds }, clientId);
    if (file?.clientId && file.clientId !== clientId) {
      throw new HttpError(422, "other_client", "that file is another client's");
    }
  }
  const covers = draft.covers;
  const hasIntake = coversAnything(covers);

  const problems: InviteProblem[] = [];
  let foundByName = false;
  let account: Plan["account"];
  let dealPlan: DealPlan;
  let settings: Record<string, unknown> | null = null;
  if (clientId) {
    const [t] = await tx
      .select({ name: tenant.name, settings: tenant.settings })
      .from(tenant)
      .where(eq(tenant.id, clientId));
    if (!t) throw new HttpError(404, "not_found", "client not found");
    settings = (t.settings ?? null) as Record<string, unknown> | null;
    account = { clientId, name: t.name, language: clientLanguage(t.settings) };
    const sells = hasIntake || !!draft.agreedMrr || via === "sign_up";
    dealPlan = await clientDeal(tx, tenantIds, clientId, named, sells);
  } else {
    const name = draft.clientName ?? file?.name ?? draft.company ?? named?.company ?? null;
    if (!name) throw new HttpError(422, "company_required", "name the company");
    // DECISION (review): a typed company that is already a client served here is stopped, not
    // made twice; the operator invites from its page. A retried sign-up whose account was made
    // but whose people weren't lands here too, rather than on a second account.
    const same = !file && !named ? await servedClientNamed(tx, tenantIds, name) : null;
    if (same) {
      problems.push({
        email: null,
        code: "client_exists",
        message: `${same.name} is already a client. Open it and invite from its page.`,
      });
    }
    if (!file && !named) file = await prospectFileNamed(tx, name);
    if (named && named.kind !== "new") {
      throw new HttpError(422, "not_new", "an expansion deal's client already exists");
    }
    named ??= await openNewDealFor(tx, tenantIds, { name, fileId: file?.id ?? null });
    if (!file && named?.clientFileId) file = await readFile(tx, tenantIds, named.clientFileId);
    foundByName = !draft.fileId && !draft.dealId && !!(file || named);
    account = { clientId: null, name, language: null };
    dealPlan = { row: named, kind: "new", to: "setup", none: false };
  }

  // HIPAA mode (§1.35, invariant 14): the branded emails name the client and its people to
  // Resend; refused before anything is made.
  const covered = parseCoveredProcessors(services.env.BAA_PROCESSORS);
  const refusal = hasIntake ? onboardingEmailRefusal(settings, covered) : null;
  if (refusal) problems.push({ email: null, code: "hipaa", message: refusal });
  // DECISION (§1.220): Just the account sends our own welcome only for a new account; on an
  // existing client, people added without an intake still get the sign-in provider's invitation
  // (its open intake, if any, is not touched).
  const welcomeOnly =
    !hasIntake && !clientId && draft.people.length > 0 && brandedEmailCanGo(services.env, settings);
  const branded = hasIntake ? brandedEmailCanGo(services.env, settings) : welcomeOnly;

  // The client's open intake: this Invite's cards are added to it (cases-plan §3.2).
  const [openRow] =
    clientId && hasIntake
      ? await tx
          .select()
          .from(intake)
          .where(
            and(eq(intake.tenantId, clientId), inArray(intake.status, [...OPEN_INTAKE_STATUSES])),
          )
          .orderBy(desc(intake.createdAt))
          .limit(1)
      : [];
  const openCovers = openRow ? storedCovers(openRow.covers) : null;
  const allCovers: Covers = openCovers
    ? {
        general: openCovers.general || covers.general,
        areas: [...new Set([...openCovers.areas, ...covers.areas])],
        templateIds: [...new Set([...openCovers.templateIds, ...covers.templateIds])],
      }
    : covers;

  const templates = (await sellableTemplates(tx, covers.templateIds)).filter(
    (t) => !openCovers?.templateIds.includes(t.id),
  );
  if (
    templates.length !==
    covers.templateIds.filter((id) => !openCovers?.templateIds.includes(id)).length
  ) {
    problems.push({
      email: null,
      code: "unknown_template",
      message: "a template in it is not published",
    });
  }
  // Keep the covers' order.
  templates.sort((a, b) => covers.templateIds.indexOf(a.id) - covers.templateIds.indexOf(b.id));

  const keys = new Set(sectionKeysOf(allCovers));
  const people: PersonPlan[] = [];
  for (const p of draft.people) {
    const { plan, problem } = await personPlan(tx, p, clientId);
    if (problem) problems.push(problem);
    if (hasIntake && plan.sections?.some((k) => !keys.has(k))) {
      problems.push({
        email: plan.email,
        code: "unknown_section",
        message: `${plan.name} is asked a part the intake doesn't cover`,
      });
    }
    if (!hasIntake) plan.sections = null;
    people.push(plan);
  }

  let guide: Guide | null = null;
  if (hasIntake) {
    const facts: GuideFact[] = file
      ? (await theirFactsOf(tx, file.id)).map((f) => ({
          id: f.id,
          section: f.section,
          text: f.text,
          sureness: f.sureness,
          fieldKey: null,
        }))
      : [];
    const sources = await guideSources(tx, services, allCovers);
    guide = buildGuide({
      covers: allCovers,
      ...sources,
      facts,
      ...(draft.edits ? { edits: draft.edits } : {}),
    });
  }

  // Adding to the open intake: its cards kept as they are, the new ones from the built guide.
  let openIntake: OpenIntakePlan | null = null;
  const told: ToldPlan[] = [];
  if (openRow && openCovers && guide) {
    const was = Guide.safeParse(openRow.guide);
    const merged = was.success ? addToGuide(was.data, guide) : { guide, added: guide.sections };
    guide = merged.guide;
    const onIt = await tx
      .select()
      .from(intakePerson)
      .where(
        and(eq(intakePerson.tenantId, openRow.tenantId), eq(intakePerson.intakeId, openRow.id)),
      )
      .orderBy(asc(intakePerson.createdAt));
    openIntake = {
      id: openRow.id,
      covers: openCovers,
      people: onIt,
      added: merged.added.map((s) => ({ key: s.key, title: s.title })),
    };
    // Those already on it who will see a new card: the admin, anyone asked the whole intake, and
    // anyone this Invite asks for one.
    for (const p of onIt) {
      const asked = people.find((x) => x.email === p.email);
      const sections = mergedSections(p.sections, asked ? asked.sections : []);
      const titles = openIntake.added
        .filter((a) => p.isAdmin || sections === null || sections.includes(a.key))
        .map((a) => a.title);
      if (titles.length === 0) continue;
      told.push({
        personId: p.id,
        email: p.email,
        name: p.name,
        language: parseLocaleOrNull(p.language),
        titles,
      });
    }
  }

  // What the deal will want once moved, and wasn't given.
  const who = account.name;
  const todos = dealPlan.none
    ? []
    : wantedTodos(
        {
          kind: dealPlan.kind,
          stage:
            dealPlan.row &&
            dealStageIndex(dealPlan.kind, dealPlan.row.stage as DealStage) >
              dealStageIndex(dealPlan.kind, dealPlan.to)
              ? dealPlan.row.stage
              : dealPlan.to,
          agreedMrr: draft.agreedMrr ?? dealPlan.row?.agreedMrr ?? null,
          signedCopyKey: dealPlan.row?.signedCopyKey ?? null,
        },
        who,
        { nothingChosen: !hasIntake && !clientId },
      );
  // A to-do the deal already has isn't made again (the dedupe key), so it isn't promised.
  const made =
    dealPlan.row && todos.length > 0
      ? new Set(
          (
            await tx
              .select({ key: todo.dedupeKey })
              .from(todo)
              .where(
                inArray(
                  todo.dedupeKey,
                  todos.map((t) => `deal:${dealPlan.row?.id}:wants:${t.want}`),
                ),
              )
          ).map((r) => r.key),
        )
      : new Set<string | null>();
  const newTodos = todos
    .filter((t) => !made.has(`deal:${dealPlan.row?.id}:wants:${t.want}`))
    .map(({ title, dueOn }) => ({ title, dueOn }));

  const startName = draft.startId ? (await readStart(tx, draft.startId)).name : null;
  return {
    via,
    draft,
    account,
    openIntake,
    told,
    branded,
    welcomeOnly,
    foundByName,
    file,
    deal: dealPlan,
    covers: allCovers,
    hasIntake,
    guide,
    templates,
    people,
    problems,
    todos: newTodos,
    lead: await leadOf(tx, session),
    title: startName ?? (dealPlan.kind === "new" ? "New account" : "Expansion"),
  };
}

// ── The confirmation's words ────────────────────────────────────────────────────────────────────

function confirmLines(plan: Plan): string[] {
  const out: string[] = [];
  const name = plan.account.name;
  if (!plan.account.clientId) out.push(`Makes ${name} a client in Mezonas, with you serving it.`);
  if (plan.foundByName) {
    // DECISION (review): found by the company's name, so the operator confirms it's the same one.
    const what = plan.file && plan.deal.row ? "file and deal" : plan.file ? "file" : "deal";
    out.push(`Uses the ${what} already in Sales for ${name}: check it's the same company.`);
  }
  const invited = plan.people.filter((p) => !p.member);
  const asked = plan.people.filter((p) => p.member);
  if (invited.length > 0) {
    const words = invited.map((p) => {
      if (p.isAdmin) return `${p.name} as its admin`;
      if (plan.hasIntake && p.sections && p.sections.length > 0) {
        return `${p.name} for the ${listWords(p.sections.map((k) => sectionWords(k, plan.templates)))} questions`;
      }
      return p.name;
    });
    out.push(`Invites ${listWords(words)}.`);
  }
  const onIntake = new Set(plan.openIntake?.people.map((p) => p.email) ?? []);
  const newlyAsked = asked.filter((p) => !onIntake.has(p.email));
  if (newlyAsked.length > 0 && plan.hasIntake) {
    out.push(`Asks ${listWords(newlyAsked.map((p) => p.name))}, already in ${name}.`);
  }
  if (plan.templates.length > 0) {
    const names = listWords(plan.templates.map((t) => t.name));
    out.push(
      plan.templates.length === 1
        ? `Adds ${names} (on the bench, approvals on) and opens its build.`
        : `Adds ${names} (on the bench, approvals on) and opens their builds.`,
    );
  }
  if (plan.openIntake) {
    if (plan.openIntake.added.length > 0) {
      out.push(
        `Adds ${listWords(plan.openIntake.added.map((a) => a.title))} to ${name}'s open intake.`,
      );
    }
  } else if (plan.hasIntake) {
    out.push(`Opens the intake (${coversWords(plan.covers)}).`);
  }
  if (!plan.deal.none) {
    const stage = dealStageOf(plan.deal.kind, plan.deal.to).name;
    const row = plan.deal.row;
    if (!row) {
      out.push(
        plan.deal.kind === "new"
          ? `Opens a New account deal at ${stage}.`
          : `Opens an Expansion deal at ${stage}.`,
      );
    } else if (
      dealStageIndex(plan.deal.kind, row.stage as DealStage) <
      dealStageIndex(plan.deal.kind, plan.deal.to)
    ) {
      out.push(`Moves the deal to ${stage}.`);
    }
  }
  if (plan.draft.agreedMrr) {
    out.push(
      `Records the agreed price: ${wholeMoney(toNumeric(plan.draft.agreedMrr), plan.draft.currency ?? "USD")} a month.`,
    );
  }
  const emailed = plan.people.filter((p) => !onIntake.has(p.email)).map((p) => firstName(p.name));
  if (plan.hasIntake && !plan.branded) {
    // The branded email can't go from here: the sign-in provider's invitation goes instead.
    if (invited.length > 0) {
      out.push(
        `Emails ${listWords(invited.map((p) => firstName(p.name)))} the sign-in invitation (our own email isn't set up here).`,
      );
    }
  } else if (plan.hasIntake) {
    if (emailed.length > 0) {
      const when = plan.draft.sendAt ? ` on ${shortDay(plan.draft.sendAt)}` : "";
      out.push(`Emails ${listWords(emailed)}${when}.`);
    }
    if (plan.told.length > 0) {
      out.push(
        `Emails ${listWords(plan.told.map((p) => firstName(p.name)))} a few more questions.`,
      );
    }
  } else if (plan.welcomeOnly && invited.length > 0) {
    const when = plan.draft.sendAt ? ` on ${shortDay(plan.draft.sendAt)}` : "";
    out.push(
      `Emails ${listWords(invited.map((p) => firstName(p.name)))} our welcome, with a link to sign in${when}.`,
    );
  } else if (invited.length > 0) {
    out.push(`Emails ${listWords(invited.map((p) => firstName(p.name)))} the sign-in invitation.`);
  }
  if (plan.todos.length > 0) {
    out.push(
      plan.todos.length === 1
        ? "Adds a to-do on Your call."
        : `Adds ${plan.todos.length} to-dos on Your call.`,
    );
  }
  return out;
}

// ── The emails and page, as they'll be seen ────────────────────────────────────────────────────

/** `<Lead> at Mezonas <hello@…>` (owner decision q9, §1.149). */
function senderOf(services: Services, lead: Plan["lead"]): string {
  const domain = services.env.EMAIL_FORWARDING_DOMAIN?.trim() || "mezonas.com";
  return `${lead.name} at Mezonas <hello@${domain}>`;
}

function originOf(run: InviteRun): string {
  return run.ctx.services.env.APP_ORIGIN?.trim() || new URL(run.ctx.c.req.url).origin;
}

function summaryOf(plan: Plan) {
  // §1.220: the welcome covers nothing; it reads "What's in it: your account".
  if (plan.welcomeOnly) return { general: false, areas: [], agents: 0, minutes: 0 };
  if (!plan.hasIntake || !plan.guide) return null;
  return {
    general: plan.covers.general,
    areas: [...plan.covers.areas],
    agents: plan.covers.templateIds.length,
    minutes: plan.guide.totals.minutes,
  };
}

function previewOf(run: InviteRun, plan: Plan): InvitePreview {
  const origin = originOf(run);
  const expiresAt = new Date(Date.now() + WELCOME_LINK_TTL_DAYS * 86_400_000);
  const link = `${origin}${welcomePagePath("preview")}`;
  const summary = summaryOf(plan);
  const localeOf = (p: PersonPlan): Locale => p.language ?? plan.account.language ?? DEFAULT_LOCALE;
  const onIntake = new Set(plan.openIntake?.people.map((p) => p.email) ?? []);
  const told: OnboardingEmailPreview[] = summary
    ? plan.told.map((p) => {
        const rendered = renderMoreQuestionsEmail({
          locale: p.language ?? plan.account.language ?? DEFAULT_LOCALE,
          client: plan.account.name,
          to: { name: p.name, email: p.email },
          lead: { name: plan.lead.name, photoUrl: null },
          link,
          expiresAt,
          origin,
          note: plan.draft.note,
          added: p.titles,
          summary,
        });
        return {
          to: p.email,
          kind: "more_questions",
          from: senderOf(run.ctx.services, plan.lead),
          replyTo: plan.lead.email,
          subject: rendered.subject,
          text: rendered.text,
          html: rendered.html,
          sendAt: null,
        };
      })
    : [];
  const invites: OnboardingEmailPreview[] = summary
    ? plan.people
        .filter((p) => !onIntake.has(p.email))
        .map((p) => {
          const rendered = renderInviteEmail({
            locale: localeOf(p),
            client: plan.account.name,
            to: { name: p.name, email: p.email },
            lead: { name: plan.lead.name, photoUrl: null },
            link,
            expiresAt,
            origin,
            note: plan.draft.note,
            summary,
          });
          return {
            to: p.email,
            kind: "invite",
            from: senderOf(run.ctx.services, plan.lead),
            replyTo: plan.lead.email,
            subject: rendered.subject,
            text: rendered.text,
            html: rendered.html,
            sendAt: plan.draft.sendAt ?? null,
          };
        })
    : [];
  const emails = plan.branded ? [...invites, ...told] : [];
  const first = plan.people[0];
  const welcome: WelcomePageView = {
    state: "open",
    client: plan.account.name,
    lead: { name: plan.lead.name, photoUrl: null },
    note: plan.draft.note || null,
    summary,
    email: first?.email ?? null,
    expiresAt: expiresAt.toISOString(),
    language: first ? localeOf(first) : (plan.account.language ?? DEFAULT_LOCALE),
  };
  return {
    confirm: confirmLines(plan),
    account: { clientId: plan.account.clientId, name: plan.account.name },
    intake:
      plan.hasIntake && plan.guide
        ? {
            covers: plan.covers,
            startMode: plan.draft.startMode,
            guide: plan.guide,
            totals: plan.guide.totals,
          }
        : null,
    emails,
    welcome,
    todos: plan.todos,
    problems: plan.problems,
  };
}

/** What it will do, in the confirmation's words, and the emails and page as they'll be seen. */
export async function previewInvite(run: InviteRun, draft: InviteDraft): Promise<InvitePreview> {
  const { ctx } = run;
  const plan = await ctx.inTx((s) =>
    planInvite(s.tx, s.tenantIds, ctx.session, ctx.services, draft, run.via),
  );
  return previewOf(run, plan);
}

/** Sign up now's form as a whole Invite draft: the start's covers, note and mode, the person. */
export async function signUpDraft(
  run: Pick<InviteRun, "ctx">,
  body: SignUpNowDraft,
): Promise<InviteDraft> {
  const start = await run.ctx.inTx((s) => readStart(s.tx, body.startId));
  if (start.archivedAt) throw new HttpError(409, "start_archived", "that start is archived");
  const covers = start.covers as Covers;
  return {
    ...(body.fileId ? { fileId: body.fileId } : {}),
    ...(body.clientId ? { clientId: body.clientId } : {}),
    ...(body.company ? { company: body.company } : {}),
    ...(body.website ? { website: body.website } : {}),
    ...(body.dealId ? { dealId: body.dealId } : {}),
    people: [
      {
        name: body.person.name,
        email: body.person.email,
        // The one person is the new account's admin; on an existing client, one of its people.
        isAdmin: !body.clientId,
        sections: null,
        ...(body.person.language ? { language: body.person.language } : {}),
      },
    ],
    covers: {
      general: covers.general,
      areas: [...covers.areas],
      templateIds: [...covers.templateIds],
    },
    startId: start.id,
    startMode: start.startMode,
    note: start.note,
    ...(body.agreedMrr ? { agreedMrr: body.agreedMrr } : {}),
    ...(body.currency ? { currency: body.currency } : {}),
  };
}

// ── Doing it ────────────────────────────────────────────────────────────────────────────────────

/** Runs `work` in one operator transaction over `ids`, then its after-commit tasks. */
async function inClients<T>(
  services: Services,
  ids: readonly string[],
  work: (s: { tx: Tx; afterCommit(task: () => Promise<unknown>): void }) => Promise<T>,
): Promise<T> {
  const after: (() => Promise<unknown>)[] = [];
  const out = await withOperator(services.db, ids, (tx) =>
    work({ tx, afterCommit: (task) => after.push(task) }),
  );
  for (const task of after) {
    await task().catch((error: unknown) =>
      reportHandled("an invite's after-commit task failed", error, { kind: "after_commit" }),
    );
  }
  return out;
}

/** Does it: one transaction for the account, one for the rest, then the builds. */
export async function runInvite(run: InviteRun, draft: InviteDraft): Promise<InviteSent> {
  const { app, ctx, via } = run;
  const services = ctx.services;
  const userId = ctx.session.user.id;
  const plan = await ctx.inTx((s) =>
    planInvite(s.tx, s.tenantIds, ctx.session, services, draft, via),
  );
  const refused = plan.problems[0];
  if (refused) throw new HttpError(422, refused.code, refused.message);

  // 1. The account: the client, its deal at Set up the account and its file, in one transaction
  //    (`opsCreateClient`, the path New client and Reggie take, audited as the deal's).
  let clientId = plan.account.clientId;
  let session = ctx.session;
  let dealId = plan.deal.none ? null : (plan.deal.row?.id ?? null);
  let fileId = plan.file?.id ?? null;
  if (!clientId) {
    const admin = plan.people.find((p) => p.isAdmin);
    const language = admin?.language ?? null;
    const created = await invokeRoute(
      app,
      ctx.c,
      ctx.session,
      routes.opsCreateClient,
      {
        body: {
          name: plan.account.name,
          ...(draft.timezone ? { timezone: draft.timezone } : {}),
          ...(language ? { language } : {}),
          sales: {
            ...(dealId ? { dealId } : {}),
            ...(fileId ? { fileId } : {}),
            ...(draft.website ? { website: draft.website } : {}),
            title: plan.title,
            why: WHY[via],
            ...(draft.agreedMrr ? { agreedMrr: draft.agreedMrr } : {}),
            ...(draft.currency ? { currency: draft.currency } : {}),
            chosen: plan.hasIntake,
          },
        },
      },
      "deal",
    );
    clientId = created.client.id;
    dealId = created.sales.dealId;
    fileId = created.sales.fileId;
    // The operator's cookie drops the clients it carries, so the next request serves this one.
    ctx.accountChanged();
    session = servingToo(ctx.session, clientId);
  }
  const client = clientId;

  // 2. The rest of the account in one transaction: the people, the intake, the deal's agents and
  //    to-dos, and the emails' outbox rows (sent after the commit by the notification pass).
  const done = await inClients(services, session.servedTenantIds, async (s) => {
    const { tx } = s;
    // A prospect's file named for an existing client becomes its file; else the client's own.
    const file =
      plan.file && plan.account.clientId && !plan.file.clientId
        ? await linkFileToClient(tx, plan.file, client)
        : await ensureClientFile(tx, client, plan.account.name, userId);
    fileId = file.id;
    let row: DealRow | null = dealId
      ? await readDeal(tx, session.servedTenantIds, dealId, true)
      : null;
    if (plan.account.clientId && !plan.deal.none) {
      row = await moveClientDeal(tx, session.servedTenantIds, plan, row, client, file, userId);
      dealId = row.id;
    }
    const todoIds: string[] = [];
    if (row) {
      await recordAgents(tx, row, plan);
      await recordPeople(tx, row.id, plan.people);
      // The new account's to-dos were made with it; an existing client's deal makes its own.
      if (plan.account.clientId) {
        for (const t of await addWantedTodos(tx, row, plan.account.name, userId)) {
          todoIds.push(t.id);
        }
      } else {
        todoIds.push(...(await dealTodoIds(tx, row.id)));
      }
    }

    // §1.14's invite for each new person: the user and membership now; the sign-in provider sends
    // nothing of its own when Mezonas sends the branded invite (one email, not two).
    const people: InviteSent["people"] = [];
    const userIds = new Map<string, string>();
    for (const p of plan.people) {
      if (p.member && p.userId) {
        userIds.set(p.email, p.userId);
        continue;
      }
      const invited = await inviteToClient(
        { tx, services, afterCommit: s.afterCommit },
        client,
        { email: p.email, name: p.name, role: p.isAdmin ? "client_admin" : "client_user" },
        // DECISION: Just the account has no intake, so no branded invite yet: the sign-in
        // provider's own invitation goes, as New client's does (cases-plan §4.3's welcome-only
        // email is the EMAIL stream's to add). With an intake, the provider sends nothing only
        // when our branded email can go from here (review): else theirs goes, so nobody is left
        // without one.
        { surface: "ops", ...(plan.branded ? { providerEmail: false } : {}) },
      );
      userIds.set(p.email, invited.member.userId);
    }

    let intakeId: string | null = null;
    let anyQueued = false;
    const emails: InviteSent["emails"] = [];
    const sendAt = draft.sendAt ? new Date(draft.sendAt) : null;
    if (plan.openIntake && plan.guide) {
      // One intake per client (cases-plan §3.2): the new cards go on the open one; its people are
      // told "A few more questions", anyone new gets the invite.
      const open = plan.openIntake;
      intakeId = open.id;
      await tx
        .update(intake)
        .set({ covers: plan.covers, guide: plan.guide })
        .where(and(eq(intake.id, open.id), eq(intake.tenantId, client)));
      for (const p of plan.people) {
        const had = open.people.find((x) => x.email === p.email);
        if (had) {
          const sections = mergedSections(had.sections, p.sections);
          if (JSON.stringify(sections) !== JSON.stringify(had.sections)) {
            await tx
              .update(intakePerson)
              .set({ sections })
              .where(and(eq(intakePerson.id, had.id), eq(intakePerson.tenantId, client)));
          }
          people.push({
            personId: had.id,
            userId: userIds.get(p.email) ?? had.userId ?? "",
            email: p.email,
            isAdmin: had.isAdmin,
          });
          continue;
        }
        const [person] = await tx
          .insert(intakePerson)
          .values({
            tenantId: client,
            intakeId: open.id,
            userId: userIds.get(p.email) ?? null,
            email: p.email,
            name: p.name,
            sections: p.sections,
            isAdmin: p.isAdmin,
            language: p.language,
            invitedBy: userId,
          })
          .returning({ id: intakePerson.id });
        if (!person) throw new Error("intake person insert returned nothing");
        people.push({
          personId: person.id,
          userId: userIds.get(p.email) ?? "",
          email: p.email,
          isAdmin: p.isAdmin,
        });
        if (!plan.branded) continue;
        const queued = await sendOnboardingEmail(
          { tx, env: services.env },
          { kind: "invite", tenantId: client, intakeId: open.id, personId: person.id, sendAt },
        );
        emails.push({ to: p.email, status: queued.status });
        if (queued.status === "queued") anyQueued = true;
      }
      if (plan.branded) {
        for (const p of plan.told) {
          const queued = await sendOnboardingEmail(
            { tx, env: services.env },
            {
              kind: "more_questions",
              tenantId: client,
              intakeId: open.id,
              personId: p.personId,
              added: p.titles,
              note: draft.note,
            },
          );
          emails.push({ to: p.email, status: queued.status });
          if (queued.status === "queued") anyQueued = true;
        }
      }
    } else if ((plan.hasIntake && plan.guide) || plan.welcomeOnly) {
      // §1.220: Just the account's welcome opens an intake that covers nothing, so its link and
      // the welcome page work as an invite's; a later Invite adds its cards to it.
      const [made] = await tx
        .insert(intake)
        .values({
          tenantId: client,
          dealId: row?.id ?? null,
          fileId: file.id,
          covers: plan.covers,
          guide: plan.guide ?? emptyGuide(),
          startMode: draft.startMode,
          leadUserId: userId,
          leadNote: draft.note,
          status: "sent",
          sendAt,
          createdBy: userId,
        })
        .returning({ id: intake.id });
      if (!made) throw new Error("intake insert returned nothing");
      intakeId = made.id;
      for (const p of plan.people) {
        const [person] = await tx
          .insert(intakePerson)
          .values({
            tenantId: client,
            intakeId: made.id,
            userId: userIds.get(p.email) ?? null,
            email: p.email,
            name: p.name,
            sections: p.sections,
            isAdmin: p.isAdmin,
            language: p.language,
            invitedBy: userId,
          })
          .returning({ id: intakePerson.id });
        if (!person) throw new Error("intake person insert returned nothing");
        people.push({
          personId: person.id,
          userId: userIds.get(p.email) ?? "",
          email: p.email,
          isAdmin: p.isAdmin,
        });
        // The email's own record on the intake (`scheduled`, or `sent` once it goes or can't) is
        // written by sendOnboardingEmail and the notification pass, once each. When ours can't go
        // from here, the sign-in provider's invitation went instead (above).
        if (!plan.branded) continue;
        const queued = await sendOnboardingEmail(
          { tx, env: services.env },
          { kind: "invite", tenantId: client, intakeId: made.id, personId: person.id, sendAt },
        );
        emails.push({ to: p.email, status: queued.status });
        if (queued.status === "queued") anyQueued = true;
      }
    } else {
      for (const p of plan.people) {
        people.push({
          personId: null,
          userId: userIds.get(p.email) ?? "",
          email: p.email,
          isAdmin: p.isAdmin,
        });
      }
    }
    // Sent at once after the commit; a later "Send at" waits for the pass.
    if (anyQueued) {
      s.afterCommit(() =>
        sendNow(
          services.db,
          notifyDepsFromEnv(services.env, services.deps.fetch?.(services.env)),
          client,
          new Date(),
        ),
      );
    }

    if (row) {
      await addActivity(tx, row.id, {
        kind: "system",
        actor: "operator",
        userId,
        body: activityLine(plan),
        meta: { via, intakeId, people: plan.people.map((p) => p.email) },
      });
    }
    return { intakeId, people, emails, todoIds, file: file.id };
  });

  // 3. A build per template at the client (each forks its template onto the bench, approvals on),
  //    opened at Requirements request: the intake's card for it is the request.
  const buildIds: string[] = [];
  const agentIds: string[] = [];
  const failed: string[] = [];
  for (const t of plan.templates) {
    try {
      const [id] = await openBuilds(app, ctx.c, session, dealId, client, [
        { name: t.name, templateId: t.id },
      ]);
      if (id) buildIds.push(id);
    } catch {
      failed.push(t.name);
    }
  }
  if (buildIds.length > 0 || failed.length > 0) {
    await inClients(services, session.servedTenantIds, async ({ tx }) => {
      if (buildIds.length > 0) {
        for (const b of await tx
          .select({ agentId: build.agentId })
          .from(build)
          .where(inArray(build.id, buildIds))) {
          if (b.agentId) agentIds.push(b.agentId);
        }
      }
      for (const name of failed) {
        const todo = await addTodo(tx, {
          clientId: client,
          owner: "operator",
          title: `Open the build for ${name} at ${plan.account.name}`,
          why: "The invite went, but this build didn't open.",
          dueAt: new Date(`${salesToday()}T23:59:59Z`),
          about: dealId ? { kind: "deal", id: dealId } : null,
          source: "system",
          dedupeKey: dealId ? `deal:${dealId}:build:${name}` : null,
          createdBy: userId,
        });
        done.todoIds.push(todo.id);
      }
      if (dealId && buildIds.length > 0) {
        await addActivity(tx, dealId, {
          kind: "system",
          actor: "operator",
          userId,
          body: `Opened ${buildIds.length === 1 ? "1 build" : `${buildIds.length} builds`} at Requirements request.`,
          meta: { buildIds },
        });
      }
    });
  }

  return {
    clientId: client,
    fileId: done.file,
    dealId,
    intakeId: done.intakeId,
    agentIds,
    buildIds,
    people: done.people,
    emails: done.emails,
    todoIds: done.todoIds,
  };
}

/** An existing client's deal: the one planned moved to its stage, or an Expansion deal opened at Agreed. */
async function moveClientDeal(
  tx: Tx,
  tenantIds: readonly string[],
  plan: Plan,
  planned: DealRow | null,
  clientId: string,
  file: FileRow,
  userId: string,
): Promise<DealRow> {
  const by = { actor: "operator" as const, userId, why: WHY[plan.via] };
  if (planned) {
    const row = await readDeal(tx, tenantIds, planned.id, true);
    const kind = row.kind as DealKind;
    const set: Partial<typeof deal.$inferInsert> = {};
    if (dealStageIndex(kind, row.stage as DealStage) < dealStageIndex(kind, plan.deal.to)) {
      Object.assign(set, await moveDealStage(tx, row, plan.deal.to, by));
    }
    if (!row.clientFileId) set.clientFileId = file.id;
    if (Object.keys(set).length > 0) await tx.update(deal).set(set).where(eq(deal.id, row.id));
    await recordTerms(tx, row.id, plan, userId);
    return readDeal(tx, tenantIds, row.id);
  }
  const [made] = await tx
    .insert(deal)
    .values({
      kind: "expansion",
      clientId,
      title: plan.title,
      stage: "agreed",
      mrr: toNumeric(plan.draft.agreedMrr ?? "0"),
      currency: plan.draft.currency ?? "USD",
      source: "ops",
      clientFileId: file.id,
      createdBy: userId,
    })
    .returning();
  if (!made) throw new Error("deal insert returned nothing");
  await addSkippedBefore(tx, made, stagesBefore("expansion", "agreed"), by);
  await addActivity(tx, made.id, {
    kind: "system",
    actor: "operator",
    userId,
    body: "Opened at Agreed.",
    meta: { clientId },
  });
  await recordTerms(tx, made.id, plan, userId);
  return readDeal(tx, tenantIds, made.id);
}

/** The agreed price given with the invite, as the deal's terms from today. */
async function recordTerms(tx: Tx, dealId: string, plan: Plan, userId: string): Promise<void> {
  if (!plan.draft.agreedMrr) return;
  const agreed = toNumeric(plan.draft.agreedMrr);
  const [row] = await tx.select().from(deal).where(eq(deal.id, dealId));
  if (!row) return;
  const currency = plan.draft.currency ?? row.currency;
  const from = salesToday();
  await tx
    .update(deal)
    .set({ agreedMrr: agreed, agreedFrom: from, currency })
    .where(eq(deal.id, dealId));
  await addActivity(tx, dealId, {
    kind: "terms",
    actor: "operator",
    userId,
    body: `Recorded the agreed terms: ${wholeMoney(agreed, currency)} a month from ${shortDay(from)}.`,
    meta: { agreedMrr: agreed, currency, from },
  });
  // The deal's "Record X's agreed price" is done now (as opsRecordTerms closes it).
  await closeTodosAbout(tx, "deal", dealId, userId, { titlePrefix: "Record " });
}

/** The templates chosen become the deal's agents when it named none. */
async function recordAgents(tx: Tx, row: DealRow, plan: Plan): Promise<void> {
  if (plan.templates.length === 0 || row.agentsSold.length > 0) return;
  await tx
    .update(deal)
    .set({
      agentsSold: plan.templates.map((t) => ({ name: t.name, templateId: t.id })),
      agentCount: Math.max(row.agentCount, plan.templates.length),
    })
    .where(eq(deal.id, row.id));
}

/** The people invited, on the deal too (by address, once each); the admin is its primary contact. */
async function recordPeople(tx: Tx, dealId: string, people: readonly PersonPlan[]): Promise<void> {
  const known = await tx
    .select({ email: dealPerson.email, isPrimary: dealPerson.isPrimary })
    .from(dealPerson)
    .where(eq(dealPerson.dealId, dealId));
  const have = new Set(known.map((k) => k.email?.toLowerCase()));
  const hasPrimary = known.some((k) => k.isPrimary);
  const fresh = people.filter((p) => !have.has(p.email));
  if (fresh.length === 0) return;
  await tx.insert(dealPerson).values(
    fresh.map((p) => ({
      dealId,
      name: p.name,
      email: p.email,
      role: p.isAdmin ? "Admin" : null,
      isPrimary: !hasPrimary && p.isAdmin,
    })),
  );
}

/** The open to-dos about a deal (a new account's were made with it). */
async function dealTodoIds(tx: Tx, dealId: string): Promise<string[]> {
  const rows = await tx
    .select({ id: todo.id })
    .from(todo)
    .where(
      and(eq(todo.aboutKind, "deal"), eq(todo.aboutId, dealId), inArray(todo.state, ["open"])),
    );
  return rows.map((r) => r.id);
}

/** The deal's line for the invite: "Invited Dana Ruiz and Mark Lee; opened the intake (general, 1 agent)." */
function activityLine(plan: Plan): string {
  const names = listWords(plan.people.map((p) => p.name));
  const verb = plan.via === "sign_up" ? "Signed up" : "Invited";
  if (plan.openIntake) {
    const added = plan.openIntake.added.map((a) => a.title);
    return added.length > 0
      ? `${verb} ${names}; added ${listWords(added)} to the open intake.`
      : `${verb} ${names} to the open intake.`;
  }
  return plan.hasIntake
    ? `${verb} ${names}; opened the intake (${coversWords(plan.covers)}).`
    : `${verb} ${names}.`;
}
