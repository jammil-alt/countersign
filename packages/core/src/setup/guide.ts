// Getting started's stored state and its pure rules (docs/setup-plan.md; docs/plan.md §1.206).
// Per agent, in `agent.stage_state.guide` (operational, never in a version): what the client said
// about each step, the tries started from the portal and their verdicts, and the scope's
// signature. Per client, in `tenant.settings.setupGuide`: the People chapter's "Looks right" and
// each tool's account check, first-look lines and who was asked to connect it. Pure: the API and
// the web app share it.

import { z } from "zod";

const Iso = z.string().min(1);
const By = { by: z.string().nullable(), byName: z.string().nullable(), at: Iso };

/** A step's mark: "Looks right", or "We do it differently" with the request it filed. */
export const StoredWalkMark = z.object({
  state: z.enum(["ok", "asked"]),
  ...By,
  text: z.string().max(2000).optional(),
  requestId: z.string().optional(),
  number: z.number().int().optional(),
});
export type StoredWalkMark = z.infer<typeof StoredWalkMark>;

/** A try started from the portal: a test run on one of the client's documents. */
export const StoredTry = z.object({
  runId: z.string(),
  documentId: z.string(),
  title: z.string().max(300),
  ...By,
  /** Step id → the client's verdict on it. */
  verdicts: z
    .record(z.string(), z.object({ right: z.boolean(), ...By, requestId: z.string().optional() }))
    .optional(),
});
export type StoredTry = z.infer<typeof StoredTry>;

/** `agent.stage_state.guide`. */
export const AgentGuideState = z
  .object({
    marks: z.record(z.string(), StoredWalkMark).optional(),
    tries: z.array(StoredTry).optional(),
    scope: z.object({ ...By, version: z.number().int() }).optional(),
  })
  .loose();
export type AgentGuideState = z.infer<typeof AgentGuideState>;

/** Reads `stage_state.guide` leniently: anything that doesn't parse reads as empty. */
export function readAgentGuide(stageState: unknown): AgentGuideState {
  const raw =
    stageState && typeof stageState === "object" && "guide" in stageState
      ? (stageState as { guide?: unknown }).guide
      : undefined;
  const parsed = AgentGuideState.safeParse(raw ?? {});
  return parsed.success ? parsed.data : {};
}

/** One tool's checks: its account, its first-look lines, who was asked to connect it. */
export const StoredToolGuide = z.object({
  /** SU3: `name` is the account said yes to, so signing in to another company asks again. */
  account: z.object({ ...By, name: z.string().max(200).optional() }).optional(),
  lines: z.record(z.string(), z.object(By)).optional(),
  askedOf: z.object({ userId: z.string(), ...By }).optional(),
});
export type StoredToolGuide = z.infer<typeof StoredToolGuide>;

/** `tenant.settings.setupGuide`. */
export const TenantGuideState = z
  .object({
    people: z.object(By).optional(),
    tools: z.record(z.string(), StoredToolGuide).optional(),
    nudges: z.record(z.string(), Iso).optional(),
    /** What the last nudge listed for each person (user id → lines), for the email at send. */
    nudgeItems: z.record(z.string(), z.array(z.string().max(300)).max(30)).optional(),
  })
  .loose();
export type TenantGuideState = z.infer<typeof TenantGuideState>;

export function readTenantGuide(settings: unknown): TenantGuideState {
  const raw =
    settings && typeof settings === "object" && "setupGuide" in settings
      ? (settings as { setupGuide?: unknown }).setupGuide
      : undefined;
  const parsed = TenantGuideState.safeParse(raw ?? {});
  return parsed.success ? parsed.data : {};
}

// ── "We think" for a seat ────────────────────────────────────────────────────────────────────

/** A member as the matcher reads them. */
export interface NamedMember {
  userId: string;
  name: string | null;
  email: string;
}

const words = (s: string) =>
  s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 1);

/**
 * The members an answer names, in the order it names them: a member is named when their full
 * name, or their first name alone where no other member shares it, appears as words in the
 * text ("Luis signs anything over five grand" names Luis Ortega). Deterministic, never a model;
 * the client confirms or changes it.
 */
export function membersNamedIn(text: string, members: readonly NamedMember[]): string[] {
  const said = words(text);
  const joined = ` ${said.join(" ")} `;
  const first = (m: NamedMember) => words(m.name ?? "")[0] ?? null;
  const firstCount = new Map<string, number>();
  for (const m of members) {
    const f = first(m);
    if (f) firstCount.set(f, (firstCount.get(f) ?? 0) + 1);
  }
  const hits: { userId: string; at: number }[] = [];
  for (const m of members) {
    const full = words(m.name ?? "");
    let at = -1;
    if (full.length > 1) at = joined.indexOf(` ${full.join(" ")} `);
    const f = full[0];
    if (at < 0 && f && firstCount.get(f) === 1) at = joined.indexOf(` ${f} `);
    if (at < 0) {
      const local = words(m.email.split("@")[0] ?? "")[0];
      if (local && local.length > 2 && firstCount.get(local) === undefined) {
        at = joined.indexOf(` ${local} `);
      }
    }
    if (at >= 0) hits.push({ userId: m.userId, at });
  }
  return hits.sort((a, b) => a.at - b.at).map((h) => h.userId);
}

// ── The runbook ──────────────────────────────────────────────────────────────────────────────

/** The days of the runbook after the invite (setup-plan §8.1). */
export const RUNBOOK_DAYS = { invite: 0, kickoff: 2, trial: 3, checkin: 10, live: 17 } as const;

/** What has happened for the runbook to read. */
export interface RunbookFacts {
  invitedAt: string | null;
  /** The first agent's scope signed, or its trial started. */
  trialStartedAt: string | null;
  liveAt: string | null;
  now: string;
}

const DAY = 86_400_000;

/**
 * Each step with when it happened or is due, and which is now: the first not done. The kickoff
 * counts as done once any chapter beyond the business was confirmed or the trial started; until
 * the invite date is known everything is next.
 */
export function runbook(
  facts: RunbookFacts,
  kickoffDone: boolean,
): { key: keyof typeof RUNBOOK_DAYS; day: number; at: string | null; done: boolean }[] {
  const start = facts.invitedAt ? Date.parse(facts.invitedAt) : null;
  const due = (day: number) => (start === null ? null : new Date(start + day * DAY).toISOString());
  const trialAt = facts.trialStartedAt ? Date.parse(facts.trialStartedAt) : null;
  const checkinDue = trialAt === null ? null : trialAt + 7 * DAY;
  const steps = [
    { key: "invite" as const, at: facts.invitedAt, done: facts.invitedAt !== null },
    { key: "kickoff" as const, at: due(RUNBOOK_DAYS.kickoff), done: kickoffDone },
    {
      key: "trial" as const,
      at: facts.trialStartedAt ?? due(RUNBOOK_DAYS.trial),
      done: trialAt !== null,
    },
    {
      key: "checkin" as const,
      at: checkinDue === null ? due(RUNBOOK_DAYS.checkin) : new Date(checkinDue).toISOString(),
      done: checkinDue !== null && checkinDue <= Date.parse(facts.now),
    },
    {
      key: "live" as const,
      at: facts.liveAt ?? due(RUNBOOK_DAYS.live),
      done: facts.liveAt !== null,
    },
  ];
  return steps.map((s) => ({ ...s, day: RUNBOOK_DAYS[s.key] }));
}

// ── Time left ────────────────────────────────────────────────────────────────────────────────

/** Rough minutes per thing left, by chapter: a question, a sign-in, a seat, a step, a signature. */
export const MINUTES_PER = { business: 1, tools: 3, people: 1, see: 1, live: 2 } as const;

/** Roughly how long the things left take, in minutes (at least 1 while anything is left). */
export function minutesLeft(left: readonly { chapter: keyof typeof MINUTES_PER }[]): number {
  if (left.length === 0) return 0;
  return Math.max(
    1,
    left.reduce((n, l) => n + MINUTES_PER[l.chapter], 0),
  );
}
