// §1.160: calls that carry the client's name. The operator asks once, with the name calls show;
// we make two Trust Hub trust products in the client's subaccount on the business profile its
// texting registration made (SHAKEN/STIR, so calls are signed "A"; CNAM, so the name shows) and
// put each calling number on the profile and both products. Twilio reviews them (free; about
// three days). The hourly pass reads the reviews and adds numbers bought since. A number is taken
// off before it is released. Facts and sources: connectors' twilio/NOTES.md.

import {
  assignNumber,
  assignToBundle,
  type BundleKind,
  createCallingProduct,
  createCnamEndUser,
  type FetchLike,
  fetchBundle,
  isTwilioNotFound,
  submitBundle,
  type TwilioAuth,
  type TwilioConfig,
  TwilioError,
  unassignNumber,
  updateCnamEndUser,
} from "@countersign/connectors";
import {
  type CallingRegistration,
  type CallingView,
  callingStatusOf,
  cnamNameFrom,
  readCallingRegistration,
} from "@countersign/core";
import { connection, connectionChange, type Tx } from "@countersign/db";
import { and, eq } from "drizzle-orm";
import { registrationOf } from "./a2p";

type ConnectionRow = typeof connection.$inferSelect;

const EMPTY: CallingRegistration = {
  displayName: null,
  shakenStir: { sid: null, status: null, issues: [] },
  cnam: { sid: null, status: null, issues: [] },
  cnamEndUserSid: null,
  assignments: {},
  error: null,
  submittedAt: null,
  checkedAt: null,
};

export function callingOf(config: TwilioConfig): CallingRegistration {
  return readCallingRegistration(config.calling) ?? structuredClone(EMPTY);
}

/** The business profile the products sit on, once Twilio has approved it; else null. */
function approvedProfile(config: TwilioConfig): string | null {
  const reg = registrationOf(config);
  return reg.customerProfileSid && reg.customerProfileStatus === "twilio-approved"
    ? reg.customerProfileSid
    : null;
}

// DECISION: only US and Canadian (+1) numbers that take calls are registered: Twilio's CNAM and
// SHAKEN/STIR are for US long codes. A Canadian number Twilio refuses shows as the error.
const callingNumbers = (config: TwilioConfig) =>
  config.numbers.filter((n) => n.capabilities.voice && n.phoneNumber.startsWith("+1"));

export function callingView(config: TwilioConfig, businessName: string): CallingView {
  const c = callingOf(config);
  const covered = callingNumbers(config)
    .map((n) => n.sid)
    .filter(
      (sid) =>
        (!c.shakenStir.sid || c.assignments[`${c.shakenStir.sid}:${sid}`]) &&
        (!c.cnam.sid || c.assignments[`${c.cnam.sid}:${sid}`]) &&
        (c.shakenStir.sid || c.cnam.sid),
    );
  return {
    profileReady: approvedProfile(config) !== null,
    displayName: c.displayName,
    suggestedName: cnamNameFrom(registrationOf(config).details?.legalName ?? businessName),
    shakenStir: { status: callingStatusOf(c.shakenStir.status), issues: c.shakenStir.issues },
    cnam: { status: callingStatusOf(c.cnam.status), issues: c.cnam.issues },
    numbersCovered: covered,
    error: c.error,
    submittedAt: c.submittedAt,
    checkedAt: c.checkedAt,
  };
}

interface Run {
  fetch: FetchLike;
  auth: TwilioAuth;
  config: TwilioConfig;
  c: CallingRegistration;
}

async function assignOnce(run: Run, kind: BundleKind, bundle: string, numberSid: string) {
  const key = `${bundle}:${numberSid}`;
  if (run.c.assignments[key]) return;
  run.c.assignments[key] = await assignNumber(run.fetch, run.auth, kind, bundle, numberSid);
}

/** Every calling number on the profile and on each product made so far. */
async function assignAll(run: Run, profile: string): Promise<void> {
  for (const n of callingNumbers(run.config)) {
    await assignOnce(run, "CustomerProfiles", profile, n.sid);
    if (run.c.shakenStir.sid) await assignOnce(run, "TrustProducts", run.c.shakenStir.sid, n.sid);
    if (run.c.cnam.sid) await assignOnce(run, "TrustProducts", run.c.cnam.sid, n.sid);
  }
}

async function save(
  tx: Tx,
  row: ConnectionRow,
  config: TwilioConfig,
  c: CallingRegistration,
  actorId: string | null,
  change: Record<string, unknown>,
): Promise<TwilioConfig> {
  const next = { ...config, calling: c };
  await tx
    .update(connection)
    .set({ config: next as unknown as Record<string, unknown> })
    .where(and(eq(connection.id, row.id), eq(connection.tenantId, row.tenantId)));
  await tx.insert(connectionChange).values({
    tenantId: row.tenantId,
    connectionId: row.id,
    actorId,
    change: { kind: "calling_registration", by: actorId ? "operator" : "system", ...change },
  });
  return next;
}

export class CallingRefused extends Error {
  constructor(
    readonly code: "profile_not_approved" | "already_approved" | "in_review" | "twilio_error",
    message: string,
  ) {
    super(message);
  }
}

/**
 * The operator's ask: makes what is missing, puts the numbers on, and sends each product that
 * isn't approved or in review for review. Asking again after a rejection changes the name and
 * sends it again. Progress is saved even when Twilio refuses a step, so the next try goes on.
 */
export async function registerCalling(
  tx: Tx,
  input: {
    row: ConnectionRow;
    config: TwilioConfig;
    auth: TwilioAuth;
    fetch: FetchLike;
    email: string;
    clientName: string;
    displayName: string;
    actorId: string;
    now: Date;
  },
): Promise<TwilioConfig> {
  const profile = approvedProfile(input.config);
  if (!profile) {
    throw new CallingRefused(
      "profile_not_approved",
      "the client's business profile (texting registration) isn't approved by Twilio yet",
    );
  }
  const c = callingOf(input.config);
  const shaken = callingStatusOf(c.shakenStir.status);
  const cnam = callingStatusOf(c.cnam.status);
  if (shaken === "approved" && cnam === "approved" && c.displayName === input.displayName) {
    throw new CallingRefused("already_approved", "both are approved with this name");
  }
  if (cnam === "pending" && c.cnam.status !== "draft" && c.displayName !== input.displayName) {
    throw new CallingRefused("in_review", "Twilio is reviewing the caller name: wait for it");
  }
  const run: Run = { fetch: input.fetch, auth: input.auth, config: input.config, c };
  const name = input.clientName.slice(0, 40);
  try {
    if (!c.shakenStir.sid) {
      const b = await createCallingProduct(run.fetch, run.auth, "shaken_stir", {
        friendlyName: `${name} SHAKEN/STIR`,
        email: input.email,
      });
      c.shakenStir = { sid: b.sid, status: b.status, issues: [] };
    }
    if (!c.cnam.sid) {
      const b = await createCallingProduct(run.fetch, run.auth, "cnam", {
        friendlyName: `${name} caller name`,
        email: input.email,
      });
      c.cnam = { sid: b.sid, status: b.status, issues: [] };
    }
    const nameChanged = c.displayName !== input.displayName;
    if (!c.cnamEndUserSid) {
      c.cnamEndUserSid = await createCnamEndUser(run.fetch, run.auth, input.displayName);
    } else if (nameChanged) {
      await updateCnamEndUser(run.fetch, run.auth, c.cnamEndUserSid, input.displayName);
    }
    c.displayName = input.displayName;
    for (const [bundle, object] of [
      [c.shakenStir.sid, profile],
      [c.cnam.sid, profile],
      [c.cnam.sid, c.cnamEndUserSid],
    ] as const) {
      const key = `${bundle}:${object}`;
      if (c.assignments[key]) continue;
      await assignToBundle(run.fetch, run.auth, "TrustProducts", bundle as string, object);
      // An entity, not a number: kept so a retry skips it (only numbers are ever taken off).
      c.assignments[key] = "entity";
    }
    await assignAll(run, profile);
    for (const p of [c.shakenStir, c.cnam]) {
      const s = callingStatusOf(p.status);
      // Sent (again) unless approved or already with Twilio; a changed name sends CNAM again.
      const resend = p === c.cnam && nameChanged && s === "approved";
      if (s === "approved" && !resend) continue;
      if (s === "pending" && p.status !== "draft") continue;
      p.status = await submitBundle(run.fetch, run.auth, "TrustProducts", p.sid as string);
      p.issues = [];
    }
    c.error = null;
    c.submittedAt = input.now.toISOString();
  } catch (error) {
    if (!(error instanceof TwilioError)) throw error;
    c.error = `Twilio: ${error.message}`;
    await save(tx, input.row, input.config, c, input.actorId, {
      action: "submit",
      error: c.error,
    });
    throw new CallingRefused("twilio_error", c.error);
  }
  return save(tx, input.row, input.config, c, input.actorId, {
    action: "submit",
    displayName: input.displayName,
    shakenStir: c.shakenStir.status,
    cnam: c.cnam.status,
  });
}

/**
 * The hourly pass (and the operator's refresh): each product's review, and numbers bought since
 * put on. Returns the config, changed or not; records a change only when something moved.
 */
export async function followCalling(
  tx: Tx,
  input: {
    row: ConnectionRow;
    config: TwilioConfig;
    auth: TwilioAuth;
    fetch: FetchLike;
    actorId: string | null;
    now: Date;
  },
): Promise<TwilioConfig> {
  const c = callingOf(input.config);
  if (!c.shakenStir.sid && !c.cnam.sid) return input.config;
  const profile = approvedProfile(input.config);
  const before = JSON.stringify(c);
  const run: Run = { fetch: input.fetch, auth: input.auth, config: input.config, c };
  try {
    for (const p of [c.shakenStir, c.cnam]) {
      if (!p.sid || p.status === "twilio-approved") continue;
      const b = await fetchBundle(run.fetch, run.auth, "TrustProducts", p.sid);
      p.status = b.status;
      p.issues = b.issues.map((i) => i.description);
    }
    if (profile) await assignAll(run, profile);
    c.error = null;
  } catch (error) {
    if (!(error instanceof TwilioError)) throw error;
    c.error = `Twilio: ${error.message}`;
  }
  const moved = JSON.stringify(c) !== before;
  c.checkedAt = input.now.toISOString();
  if (!moved && !input.actorId) {
    // Nothing new: keep the config as it was, without a change row each hour.
    return input.config;
  }
  return save(tx, input.row, input.config, c, input.actorId, {
    action: "checked",
    shakenStir: c.shakenStir.status,
    cnam: c.cnam.status,
    ...(c.error ? { error: c.error } : {}),
  });
}

/**
 * A number about to be released comes off the products and the profile first, so the caller name
 * doesn't stay on a number Twilio may give someone else. Something already gone is fine.
 */
export async function unassignBeforeRelease(
  fetch: FetchLike,
  auth: TwilioAuth,
  config: TwilioConfig,
  numberSid: string,
): Promise<TwilioConfig> {
  const c = readCallingRegistration(config.calling);
  if (!c) return config;
  const profile = registrationOf(config).customerProfileSid;
  const assignments = { ...c.assignments };
  for (const [key, ra] of Object.entries(c.assignments)) {
    const [bundle, object] = key.split(":");
    if (object !== numberSid || !bundle) continue;
    const kind: BundleKind = bundle === profile ? "CustomerProfiles" : "TrustProducts";
    try {
      await unassignNumber(fetch, auth, kind, bundle, ra);
    } catch (error) {
      if (!isTwilioNotFound(error)) throw error;
    }
    delete assignments[key];
  }
  return { ...config, calling: { ...c, assignments } };
}
