// P-8: US texting registration (A2P 10DLC) by Twilio's ISV API (docs/plan.md §1.70). The client
// admin's details live on the client's `twilio` connection (config.a2p.registration), the EIN in
// its encrypted credentials (write-only); the operator submits; the cron and "Check status" follow
// Twilio's statuses, make the campaign once the brand is approved and add the numbers once it is
// verified. Twilio's fees are recorded once each as the client's usage (raw records `ProviderFee`,
// summed into usage_platform_daily by the platform rollup). People are told in plain words with
// inbox items. Twilio's calls are in `@countersign/connectors` (twilio/a2p.ts).

import { rollupPlatformDaily, utcDay } from "@countersign/agents";
import {
  addServiceNumber,
  assignToBundle,
  brandUseCases,
  businessAttributes,
  createA2pService,
  createAddress,
  createBrand,
  createBundle,
  createCampaign,
  createEndUser,
  deleteCampaign,
  evaluateBundle,
  type FetchLike,
  fetchBrand,
  fetchBundle,
  fetchCampaign,
  readTwilioConfig,
  representativeAttributes,
  serviceNumbers,
  submitBundle,
  TWILIO_CONNECTOR_ID,
  type TwilioAuth,
  type TwilioConfig,
  TwilioError,
  twilioCredentialsOf,
  updateAddress,
  updateBrand,
  updateEndUser,
} from "@countersign/connectors";
import {
  A2P_FEES,
  type A2pBusinessDetails,
  type A2pCampaignText,
  type A2pFeeKind,
  type A2pIssue,
  type A2pRegistrationState,
  type A2pRegistrationView,
  type A2pStage,
  a2pBrandTypeOf,
  a2pCampaignTextOf,
  a2pEditable,
  a2pFeePreview,
  a2pIssueWords,
  a2pSubmittable,
  a2pUseCaseOf,
  campaignMarketingWords,
  einHint,
  emptyA2pRegistration,
  isNanpNumber,
  PROVIDER_FEE_ENTITY,
  type ProviderFeePayload,
  readA2pRegistration,
  redactEin,
  type TextingRegistrationView,
} from "@countersign/core";
import {
  connection,
  connectionChange,
  type Db,
  inboxItem,
  rawRecord,
  type Tx,
  tenant,
  withTenant,
} from "@countersign/db";
import { and, desc, eq } from "drizzle-orm";
import type { Bindings } from "../env";
import { HttpError } from "../http";
import { reportHandled } from "../observability/report";
import { connectionCredentials } from "../secrets";

type ConnectionRow = typeof connection.$inferSelect;
type Secrets = Pick<Bindings, "ENCRYPTION_KEY" | "ENCRYPTION_KEY_PREVIOUS">;

/** The cron's minute for the status pass (hourly). */
export const A2P_CRON_MINUTE = 23;
/** `inbox_item.subject_type` of a registration notice; `subject_id` is the connection. */
export const A2P_SUBJECT = "a2p_registration";
/** Where the EIN sits in the twilio connection's encrypted credentials. */
const EIN_FIELD = "a2pEin";
/** Stages the cron follows. */
const FOLLOWED: readonly A2pStage[] = ["submitted", "campaign", "ready"];

export interface A2pSettings {
  primaryProfileSid: string;
  email: string;
}

/** Mezonas' primary profile and Trust Hub email, or null when this deployment has neither. */
export function a2pSettings(env: Bindings): A2pSettings | null {
  const primaryProfileSid = env.TWILIO_PRIMARY_PROFILE_SID?.trim();
  const email = env.TWILIO_A2P_EMAIL?.trim();
  if (!primaryProfileSid || !/^BU[0-9a-fA-F]{32}$/.test(primaryProfileSid) || !email) return null;
  return { primaryProfileSid, email };
}

export function registrationOf(config: TwilioConfig | null): A2pRegistrationState {
  return readA2pRegistration(config?.a2p.registration) ?? emptyA2pRegistration();
}

export async function twilioConnectionOf(
  tx: Tx,
  tenantId: string,
): Promise<ConnectionRow | undefined> {
  const [row] = await tx
    .select()
    .from(connection)
    .where(and(eq(connection.tenantId, tenantId), eq(connection.connector, TWILIO_CONNECTOR_ID)))
    .orderBy(desc(connection.createdAt))
    .limit(1);
  return row;
}

// ── Views ────────────────────────────────────────────────────────────────────────────────────────

const issueView = (i: A2pIssue) => ({ ...i, words: a2pIssueWords(i) });

/** The portal's view: no SID, fee or cost. */
export function portalView(
  row: ConnectionRow | undefined,
  config: TwilioConfig | null,
): TextingRegistrationView {
  const reg = registrationOf(config);
  return {
    available: Boolean(row && config && row.status === "connected"),
    stage: reg.stage,
    details: reg.details,
    einSet: reg.einHint !== null,
    einHint: reg.einHint,
    editable: a2pEditable(reg.stage),
    // Twilio's reasons when it asks for changes; a passing refusal stays the operator's.
    needs: reg.stage === "needs_changes" ? reg.issues.map(a2pIssueWords) : [],
    updatedAt: reg.updatedAt ?? reg.detailsUpdatedAt,
  };
}

/** The back office's view, with the fees the next submit charges. */
export function opsView(config: TwilioConfig, env: Bindings): A2pRegistrationView {
  const reg = registrationOf(config);
  const volume = reg.details?.volume ?? "low";
  const brandType = reg.brandType ?? a2pBrandTypeOf(volume);
  const missing = a2pSubmittable(reg, reg.einHint !== null);
  if (!a2pSettings(env)) missing.push("settings");
  return {
    stage: reg.stage,
    details: reg.details,
    detailsUpdatedAt: reg.detailsUpdatedAt,
    einSet: reg.einHint !== null,
    einHint: reg.einHint,
    missing,
    brandType,
    useCase: reg.useCase ?? a2pUseCaseOf(brandType),
    campaign: reg.campaign ?? (reg.details ? a2pCampaignTextOf(reg.details) : null),
    campaignEdited: reg.campaign !== null,
    statuses: {
      customerProfile: reg.customerProfileStatus,
      trustProduct: reg.trustProductStatus,
      brand: config.a2p.brandStatus,
      campaign: config.a2p.campaignStatus,
    },
    sids: {
      customerProfile: reg.customerProfileSid,
      trustProduct: reg.trustProductSid,
      brand: config.a2p.brandSid,
      messagingService: config.a2p.messagingServiceSid,
    },
    issues: reg.issues.map(issueView),
    fees: a2pFeePreview(reg, volume),
    recorded: reg.fees,
    submissions: reg.submissions,
    brandUpdates: reg.brandUpdates,
    campaignAttempts: reg.campaignAttempts,
    serviceNumbers: reg.serviceNumbers,
    updatedAt: reg.updatedAt,
  };
}

/** The setup's `a2p` without the stored registration (the view carries what the operator needs). */
export function a2pWithoutRegistration(a2p: TwilioConfig["a2p"]): TwilioConfig["a2p"] {
  const { registration: _stored, ...rest } = a2p;
  return rest;
}

// ── Saving ───────────────────────────────────────────────────────────────────────────────────────

async function save(
  tx: Tx,
  row: ConnectionRow,
  config: TwilioConfig,
  actorId: string | null,
  change: Record<string, unknown>,
): Promise<void> {
  await tx
    .update(connection)
    .set({ config: config as unknown as Record<string, unknown> })
    .where(and(eq(connection.id, row.id), eq(connection.tenantId, row.tenantId)));
  await tx.insert(connectionChange).values({
    tenantId: row.tenantId,
    connectionId: row.id,
    actorId,
    change: { kind: "a2p_registration", ...change },
  });
}

/** The EIN, read from the connection's encrypted credentials for one Twilio call. */
async function einOf(tx: Tx, env: Secrets, row: ConnectionRow): Promise<string | null> {
  const creds = (await (await connectionCredentials(tx, env, row)).get()) as Record<
    string,
    unknown
  > | null;
  const v = creds?.[EIN_FIELD];
  return typeof v === "string" ? v : null;
}

/**
 * Writes the EIN into the connection's encrypted credentials beside the subaccount's own fields.
 */
// DECISION: the stored credentials are read and written back with the EIN (the one merge plan
// §1.26's form rule doesn't cover: the other fields are ours, not the form's); the connector's own
// parse of its credentials leaves the EIN out (plan §1.70).
async function setEin(tx: Tx, env: Secrets, row: ConnectionRow, ein: string): Promise<void> {
  const accessor = await connectionCredentials(tx, env, row);
  const current = (await accessor.get()) as Record<string, unknown> | null;
  if (!twilioCredentialsOf(current as never)) {
    throw new HttpError(409, "not_provisioned", "texting isn't set up for this client yet");
  }
  await accessor.set({ ...(current ?? {}), [EIN_FIELD]: ein } as never);
}

// ── The client admin's details ───────────────────────────────────────────────────────────────────

export async function saveDetails(
  tx: Tx,
  env: Secrets,
  input: {
    row: ConnectionRow;
    config: TwilioConfig;
    details: A2pBusinessDetails;
    ein: string | null;
    actorId: string;
    now: Date;
  },
): Promise<TwilioConfig> {
  const reg = registrationOf(input.config);
  if (!a2pEditable(reg.stage)) {
    throw new HttpError(
      409,
      "registration_locked",
      "your details are with Twilio now; you can change them if Twilio asks for changes",
    );
  }
  if (input.ein) await setEin(tx, env, input.row, input.ein);
  const at = input.now.toISOString();
  const next: A2pRegistrationState = {
    ...reg,
    details: input.details,
    detailsUpdatedAt: at,
    ...(input.ein ? { einHint: einHint(input.ein), einSetAt: at } : {}),
    updatedAt: at,
  };
  const config = { ...input.config, a2p: { ...input.config.a2p, registration: next } };
  await save(tx, input.row, config, input.actorId, {
    by: "client",
    what: "details",
    fields: Object.keys(input.details),
    ...(input.ein ? { ein: "set" } : {}),
  });
  return config;
}

// ── Fees ─────────────────────────────────────────────────────────────────────────────────────────

const FEE_WORDS: Record<A2pFeeKind, string> = {
  brand: "Twilio A2P 10DLC brand registration",
  vetting: "Twilio A2P 10DLC campaign vetting",
  monthly: "Twilio A2P 10DLC campaign, monthly",
};

/**
 * Records a fee once (by its key) as a `ProviderFee` raw record on the connection; the platform
 * rollup turns it into the client's usage. Answers whether it was new.
 */
async function recordFee(
  tx: Tx,
  row: ConnectionRow,
  reg: A2pRegistrationState,
  fee: { key: string; kind: A2pFeeKind; amountUsd: string },
  now: Date,
): Promise<boolean> {
  const payload: ProviderFeePayload = {
    kind: `a2p_${fee.kind}`,
    description: FEE_WORDS[fee.kind],
    amountUsd: fee.amountUsd,
    currency: "USD",
  };
  const [stored] = await tx
    .insert(rawRecord)
    .values({
      tenantId: row.tenantId,
      connectionId: row.id,
      connector: TWILIO_CONNECTOR_ID,
      entityType: PROVIDER_FEE_ENTITY,
      externalId: fee.key,
      payload,
      syncedAt: now,
    })
    .onConflictDoNothing()
    .returning({ id: rawRecord.id });
  if (!stored) return false;
  reg.fees.push({ ...fee, at: now.toISOString() });
  return true;
}

// ── Twilio's answers ─────────────────────────────────────────────────────────────────────────────

/** A Twilio refusal as one of the registration's issues, the EIN redacted. */
function refusal(error: TwilioError, source: A2pIssue["source"], ein: string | null): A2pIssue {
  return {
    source,
    code: error.code == null ? null : String(error.code),
    fields: [],
    description: redactEin(`Twilio: ${error.message}`, ein).slice(0, 500),
  };
}

const redactIssues = (issues: A2pIssue[], ein: string | null) =>
  issues.map((i) => ({ ...i, description: redactEin(i.description, ein) }));

interface Run {
  tx: Tx;
  fetch: FetchLike;
  auth: TwilioAuth;
  row: ConnectionRow;
  config: TwilioConfig;
  reg: A2pRegistrationState;
  ein: string | null;
  now: Date;
}

function configOf(run: Run): TwilioConfig {
  const ready = run.reg.stage === "ready";
  return {
    ...run.config,
    a2p: {
      ...run.config.a2p,
      // US texts go once the campaign is verified and the numbers are in the service.
      status: ready
        ? "approved"
        : run.reg.stage === "needs_changes" || run.reg.stage === "suspended"
          ? "failed"
          : "pending",
      registration: { ...run.reg, updatedAt: run.now.toISOString() },
    },
  };
}

async function assignOnce(
  run: Run,
  kind: "CustomerProfiles" | "TrustProducts",
  bundleSid: string,
  objectSid: string,
) {
  const key = `${bundleSid}:${objectSid}`;
  if (run.reg.assigned.includes(key)) return;
  await assignToBundle(run.fetch, run.auth, kind, bundleSid, objectSid);
  run.reg.assigned.push(key);
}

/** The secondary customer profile: made, or updated after a rejection; evaluated; submitted. */
async function profileStep(run: Run, settings: A2pSettings, name: string): Promise<boolean> {
  const { reg, fetch, auth } = run;
  const details = reg.details as A2pBusinessDetails;
  const ein = run.ein as string;
  if (!reg.customerProfileSid) {
    const b = await createBundle(fetch, auth, "CustomerProfiles", {
      friendlyName: `${name} customer profile`,
      email: settings.email,
    });
    reg.customerProfileSid = b.sid;
    reg.customerProfileStatus = b.status;
  }
  const profile = reg.customerProfileSid;
  if (!reg.endUsers.business) {
    reg.endUsers.business = await createEndUser(fetch, auth, {
      type: "customer_profile_business_information",
      friendlyName: `${name} business information`,
      attributes: businessAttributes(details, ein),
    });
  } else {
    await updateEndUser(fetch, auth, reg.endUsers.business, businessAttributes(details, ein));
  }
  if (!reg.endUsers.representative) {
    reg.endUsers.representative = await createEndUser(fetch, auth, {
      type: "authorized_representative_1",
      friendlyName: `${name} authorized representative`,
      attributes: representativeAttributes(details),
    });
  } else {
    await updateEndUser(
      fetch,
      auth,
      reg.endUsers.representative,
      representativeAttributes(details),
    );
  }
  if (!reg.addressSid || !reg.supportingDocumentSid) {
    const a = await createAddress(fetch, auth, details);
    reg.addressSid = a.addressSid;
    reg.supportingDocumentSid = a.documentSid;
  } else {
    await updateAddress(fetch, auth, reg.addressSid, details);
  }
  await assignOnce(run, "CustomerProfiles", profile, reg.endUsers.business);
  await assignOnce(run, "CustomerProfiles", profile, reg.endUsers.representative);
  await assignOnce(run, "CustomerProfiles", profile, reg.supportingDocumentSid);
  await assignOnce(run, "CustomerProfiles", profile, settings.primaryProfileSid);
  const evaluation = await evaluateBundle(fetch, auth, "CustomerProfiles", profile);
  if (!evaluation.compliant) {
    reg.issues.push(...redactIssues(evaluation.issues, run.ein));
    return false;
  }
  if (reg.customerProfileStatus !== "twilio-approved") {
    reg.customerProfileStatus = await submitBundle(fetch, auth, "CustomerProfiles", profile);
  }
  return true;
}

/** The A2P trust product: made, or updated; evaluated; submitted. */
async function trustProductStep(run: Run, settings: A2pSettings, name: string): Promise<boolean> {
  const { reg, fetch, auth } = run;
  const details = reg.details as A2pBusinessDetails;
  if (!reg.trustProductSid) {
    const b = await createBundle(fetch, auth, "TrustProducts", {
      friendlyName: `${name} A2P trust product`,
      email: settings.email,
    });
    reg.trustProductSid = b.sid;
    reg.trustProductStatus = b.status;
  }
  const trust = reg.trustProductSid;
  const attributes = { company_type: details.companyType };
  if (!reg.endUsers.messagingProfile) {
    reg.endUsers.messagingProfile = await createEndUser(fetch, auth, {
      type: "us_a2p_messaging_profile_information",
      friendlyName: `${name} messaging profile`,
      attributes,
    });
  } else {
    await updateEndUser(fetch, auth, reg.endUsers.messagingProfile, attributes);
  }
  await assignOnce(run, "TrustProducts", trust, reg.endUsers.messagingProfile);
  await assignOnce(run, "TrustProducts", trust, reg.customerProfileSid as string);
  const evaluation = await evaluateBundle(fetch, auth, "TrustProducts", trust);
  if (!evaluation.compliant) {
    reg.issues.push(...redactIssues(evaluation.issues, run.ein));
    return false;
  }
  if (reg.trustProductStatus !== "twilio-approved") {
    reg.trustProductStatus = await submitBundle(fetch, auth, "TrustProducts", trust);
  }
  return true;
}

/** Makes the campaign on the service (the brand is approved), recording its vetting fee. */
async function campaignStep(run: Run): Promise<void> {
  const { reg, fetch, auth } = run;
  const service = run.config.a2p.messagingServiceSid as string;
  const brand = run.config.a2p.brandSid as string;
  const details = reg.details as A2pBusinessDetails;
  const useCase = reg.useCase ?? a2pUseCaseOf(reg.brandType ?? a2pBrandTypeOf(details.volume));
  const offered = await brandUseCases(fetch, auth, service, brand);
  if (!offered.includes(useCase)) {
    reg.issues.push({
      source: "use_case",
      code: null,
      fields: [],
      description: `Twilio doesn't offer the ${useCase} use case for this brand. Ask Twilio support why.`,
    });
    reg.stage = "needs_changes";
    return;
  }
  const text = reg.campaign ?? a2pCampaignTextOf(details);
  const made = await createCampaign(fetch, auth, service, {
    brandSid: brand,
    useCase,
    text,
    details,
  });
  reg.campaignAttempts += 1;
  reg.submittedCampaign = text;
  run.config = {
    ...run.config,
    a2p: { ...run.config.a2p, campaignStatus: made.status ?? "PENDING" },
  };
  await recordFee(
    run.tx,
    run.row,
    reg,
    {
      key: `a2p:vetting:${service}:${reg.campaignAttempts}`,
      kind: "vetting",
      amountUsd: A2P_FEES.vetting,
    },
    run.now,
  );
  reg.stage = "campaign";
}

/**
 * The campaign is verified: the client's US texting numbers join the service (those already in
 * it are skipped), and the month's campaign fee is recorded once.
 */
async function verifiedStep(run: Run): Promise<void> {
  const { reg, fetch, auth } = run;
  const service = run.config.a2p.messagingServiceSid as string;
  const inService = new Set(await serviceNumbers(fetch, auth, service));
  for (const n of run.config.numbers) {
    if (!n.capabilities.sms || !isNanpNumber(n.phoneNumber)) continue;
    if (!inService.has(n.sid)) await addServiceNumber(fetch, auth, service, n.sid);
    inService.add(n.sid);
  }
  reg.serviceNumbers = run.config.numbers.map((n) => n.sid).filter((sid) => inService.has(sid));
  reg.stage = "ready";
  const useCase = reg.useCase ?? "LOW_VOLUME";
  // DECISION: the month's fee is recorded at the first pass of each UTC month while the campaign
  // is verified (plan §1.70).
  await recordFee(
    run.tx,
    run.row,
    reg,
    {
      key: `a2p:monthly:${service}:${run.now.toISOString().slice(0, 7)}`,
      kind: "monthly",
      amountUsd: A2P_FEES.monthly[useCase],
    },
    run.now,
  );
}

/** Applies a brand status read from Twilio. */
function applyBrand(run: Run, status: string, issues: A2pIssue[]) {
  run.config = { ...run.config, a2p: { ...run.config.a2p, brandStatus: status } };
  const s = status.toUpperCase();
  if (s === "FAILED") {
    run.reg.issues.push(...redactIssues(issues, run.ein));
    if (issues.length === 0) {
      run.reg.issues.push({
        source: "brand",
        code: null,
        fields: [],
        description: "Twilio couldn't verify the brand and gave no reason.",
      });
    }
    run.reg.stage = "needs_changes";
  } else if (s === "SUSPENDED") {
    run.reg.stage = "suspended";
  }
}

/** Applies a campaign status read from Twilio. */
function applyCampaign(run: Run, status: string | null, issues: A2pIssue[]) {
  run.config = { ...run.config, a2p: { ...run.config.a2p, campaignStatus: status } };
  const s = status?.toUpperCase() ?? null;
  if (s === "FAILED") {
    run.reg.issues.push(...redactIssues(issues, run.ein));
    run.reg.stage = "needs_changes";
  } else if (s === "SUSPENDED") {
    run.reg.stage = "suspended";
  }
}

/**
 * One pass over a registration being followed: the bundles' reviews, the brand, then the
 * campaign; the campaign is made once the brand is approved, and the numbers added once it is
 * verified. Twilio refusing a call stops the pass and is kept as an issue for the operator; the
 * next pass tries again.
 */
async function follow(run: Run): Promise<void> {
  const { reg, fetch, auth } = run;
  try {
    for (const [kind, sid] of [
      ["CustomerProfiles", reg.customerProfileSid],
      ["TrustProducts", reg.trustProductSid],
    ] as const) {
      if (!sid) continue;
      const b = await fetchBundle(fetch, auth, kind, sid);
      if (kind === "CustomerProfiles") reg.customerProfileStatus = b.status;
      else reg.trustProductStatus = b.status;
      if (b.status === "twilio-rejected") {
        reg.issues.push(
          ...redactIssues(
            b.issues.length > 0
              ? b.issues
              : [
                  {
                    source: kind === "CustomerProfiles" ? "profile" : "trust_product",
                    code: null,
                    fields: [],
                    description: "Twilio rejected the business profile and gave no reason.",
                  },
                ],
            run.ein,
          ),
        );
        reg.stage = "needs_changes";
        return;
      }
    }
    const brandSid = run.config.a2p.brandSid;
    if (!brandSid) return;
    const brand = await fetchBrand(fetch, auth, brandSid);
    applyBrand(run, brand.status, brand.issues);
    if (reg.stage === "needs_changes" || reg.stage === "suspended") return;
    if (brand.status.toUpperCase() !== "APPROVED") return;
    if (reg.stage === "submitted") {
      await campaignStep(run);
      return;
    }
    const campaign = await fetchCampaign(fetch, auth, run.config.a2p.messagingServiceSid as string);
    applyCampaign(run, campaign?.status ?? null, campaign?.issues ?? []);
    if (campaign?.status?.toUpperCase() === "VERIFIED") await verifiedStep(run);
  } catch (error) {
    if (!(error instanceof TwilioError)) throw error;
    reg.issues.push(refusal(error, "brand", run.ein));
  }
}

/** The Messaging Service and the brand: registered (and charged) once; a failed brand updated. */
async function brandStep(run: Run, name: string): Promise<void> {
  const { reg, fetch, auth } = run;
  if (!run.config.a2p.messagingServiceSid) {
    const service = await createA2pService(fetch, auth, {
      friendlyName: name,
      inboundUrl: run.config.webhooks.messages,
      statusUrl: run.config.webhooks.status,
    });
    run.config = { ...run.config, a2p: { ...run.config.a2p, messagingServiceSid: service } };
  }
  const brandSid = run.config.a2p.brandSid;
  if (!brandSid) {
    const brand = await createBrand(fetch, auth, {
      customerProfileSid: reg.customerProfileSid as string,
      trustProductSid: reg.trustProductSid as string,
      lowVolume: reg.brandType === "low_volume",
    });
    run.config = {
      ...run.config,
      a2p: { ...run.config.a2p, brandSid: brand.sid, brandStatus: brand.status },
    };
    await recordFee(
      run.tx,
      run.row,
      reg,
      {
        key: `a2p:brand:${brand.sid}`,
        kind: "brand",
        amountUsd: A2P_FEES.brand[reg.brandType ?? "low_volume"],
      },
      run.now,
    );
    reg.stage = "submitted";
    return;
  }
  if (run.config.a2p.brandStatus?.toUpperCase() === "FAILED") {
    // DECISION: Twilio updates a failed brand free three times, then refuses (21724): we stop
    // before a fourth and say so (plan §1.70).
    if (reg.brandUpdates >= 3) {
      reg.issues.push({
        source: "brand",
        code: "21724",
        fields: [],
        description:
          "Twilio allows three free brand updates and they are used. Ask Twilio support to look at the brand.",
      });
      reg.stage = "needs_changes";
      return;
    }
    const brand = await updateBrand(fetch, auth, brandSid);
    reg.brandUpdates += 1;
    run.config = { ...run.config, a2p: { ...run.config.a2p, brandStatus: brand.status } };
  }
  reg.stage = "submitted";
}

/**
 * The campaign at a submit: when the brand is approved, a rejected campaign is deleted and made
 * again (a new vetting fee: Twilio's edit-in-place is a private beta for API users), and a
 * campaign never made is made now; otherwise the cron makes it once the brand is approved.
 */
async function campaignResubmit(run: Run, campaignRejected: boolean): Promise<void> {
  if (run.config.a2p.brandStatus?.toUpperCase() !== "APPROVED") return;
  const service = run.config.a2p.messagingServiceSid as string;
  if (campaignRejected && run.config.a2p.campaignStatus?.toUpperCase() === "FAILED") {
    await deleteCampaign(run.fetch, run.auth, service);
    run.config = { ...run.config, a2p: { ...run.config.a2p, campaignStatus: null } };
  }
  if (run.config.a2p.campaignStatus === null) await campaignStep(run);
  else run.reg.stage = "campaign";
}

// ── Telling people ───────────────────────────────────────────────────────────────────────────────

const NOTICES: Partial<Record<A2pStage, { title: string; explanation: string }>> = {
  ready: {
    title: "Texting is ready",
    explanation:
      "Twilio approved your US texting registration. Your agents can now text US numbers from your number.",
  },
  needs_changes: {
    title: "Twilio needs changes to your texting registration",
    explanation:
      "Twilio couldn't approve the registration as it is. Here is what it said and what to change. Once it is fixed, we send it again.",
  },
  suspended: {
    title: "Texting is on hold",
    explanation:
      "Twilio has put your US texting registration on hold. We are working with Twilio support on it; texts to US numbers can't go until then.",
  },
};

/** Raises one item each for the operator and the client admin when the stage is worth a word. */
async function tell(tx: Tx, row: ConnectionRow, reg: A2pRegistrationState): Promise<void> {
  if (reg.notifiedStage === reg.stage) return;
  const notice = NOTICES[reg.stage];
  if (!notice) return;
  // Older notices about this registration close: the new one says where it stands now.
  await tx
    .update(inboxItem)
    .set({ status: "resolved", resolvedAt: new Date(), resolution: { superseded: true } })
    .where(
      and(
        eq(inboxItem.tenantId, row.tenantId),
        eq(inboxItem.subjectType, A2P_SUBJECT),
        eq(inboxItem.subjectId, row.id),
        eq(inboxItem.status, "open"),
      ),
    );
  const needs = reg.stage === "needs_changes" ? reg.issues.map(a2pIssueWords) : [];
  for (const role of ["operator", "client_admin"] as const) {
    await tx.insert(inboxItem).values({
      tenantId: row.tenantId,
      kind: "review",
      subjectType: A2P_SUBJECT,
      subjectId: row.id,
      assigneeRole: role,
      title: notice.title,
      payload: {
        kind: A2P_SUBJECT,
        stage: reg.stage,
        explanation: notice.explanation,
        needs,
      },
    });
  }
  reg.notifiedStage = reg.stage;
}

// ── The operator's submit ────────────────────────────────────────────────────────────────────────

export interface SubmitInput {
  row: ConnectionRow;
  config: TwilioConfig;
  auth: TwilioAuth;
  fetch: FetchLike;
  actor: { id: string; label: string };
  reason: string;
  campaign?: A2pCampaignText | undefined;
  now: Date;
}

/**
 * Submits the client's details (a first submit or a resubmit after an edit). Twilio's refusals are
 * kept as issues and every SID made so far is saved, so a retry carries on where this stopped and
 * no brand is registered (and charged) twice.
 */
export async function submitRegistration(
  tx: Tx,
  env: Bindings,
  input: SubmitInput,
): Promise<TwilioConfig> {
  const settings = a2pSettings(env);
  if (!settings) {
    throw new HttpError(
      503,
      "not_configured",
      "Mezonas' Twilio primary profile and Trust Hub email aren't set up here yet",
    );
  }
  const reg = registrationOf(input.config);
  const ein = await einOf(tx, env, input.row);
  const missing = a2pSubmittable(reg, ein !== null);
  if (missing.length > 0 || !reg.details) {
    throw new HttpError(
      409,
      "not_ready",
      `the registration can't be submitted yet: ${missing.join(", ")}`,
    );
  }
  const details = reg.details;
  const campaign = input.campaign ?? reg.campaign;
  const words = campaignMarketingWords(campaign ?? a2pCampaignTextOf(details));
  if (words.length > 0) {
    throw new HttpError(
      422,
      "marketing_refused",
      `we register texting for the company's own team, vendors and customer care, never marketing (found: ${words.join(", ")})`,
    );
  }
  // The brand's type can't change once it is registered.
  const brandType =
    input.config.a2p.brandSid && reg.brandType ? reg.brandType : a2pBrandTypeOf(details.volume);
  const previous = reg.issues.map((i) => i.source);
  const resubmit = reg.stage === "needs_changes";
  const run: Run = {
    tx,
    fetch: input.fetch,
    auth: input.auth,
    row: input.row,
    config: input.config,
    reg: {
      ...reg,
      brandType,
      useCase: a2pUseCaseOf(brandType),
      campaign: campaign ?? null,
      issues: [],
      submissions: [
        ...reg.submissions,
        { at: input.now.toISOString(), by: input.actor.label, reason: input.reason },
      ],
    },
    ein,
    now: input.now,
  };
  const [t] = await tx
    .select({ name: tenant.name })
    .from(tenant)
    .where(eq(tenant.id, input.row.tenantId));
  const name = `Mezonas - ${t?.name ?? details.legalName}`.slice(0, 60);
  // A resubmit after only the campaign was rejected leaves the approved profile and brand alone.
  const businessWork =
    !resubmit ||
    previous.some((p) => p === "profile" || p === "trust_product" || p === "brand") ||
    !reg.customerProfileSid ||
    !reg.trustProductSid ||
    !input.config.a2p.brandSid;
  let step: A2pIssue["source"] = "profile";
  const stepTo = async (next: A2pIssue["source"]) => {
    step = next;
    return true;
  };
  try {
    let ok = true;
    if (businessWork) {
      ok =
        (await profileStep(run, settings, name)) &&
        (await stepTo("trust_product")) &&
        (await trustProductStep(run, settings, name));
    }
    if (!ok) {
      run.reg.stage = "needs_changes";
    } else {
      step = "brand";
      await brandStep(run, name);
      if (run.reg.stage !== "needs_changes") {
        step = "campaign";
        await campaignResubmit(run, previous.includes("campaign"));
      }
    }
  } catch (error) {
    if (!(error instanceof TwilioError)) throw error;
    run.reg.issues.push(refusal(error, step, ein));
  }
  await tell(tx, input.row, run.reg);
  const next = configOf(run);
  await save(tx, input.row, next, input.actor.id, {
    by: "operator",
    what: "submit",
    stage: run.reg.stage,
    reason: input.reason,
  });
  return next;
}

// ── Following, on the cron and "Check status" ────────────────────────────────────────────────────

/**
 * One status pass for a registration Twilio has (submitted, campaign or ready). Answers the new
 * config, or null when there is nothing to follow.
 */
export async function pollRegistration(
  tx: Tx,
  env: Bindings,
  input: {
    row: ConnectionRow;
    config: TwilioConfig;
    auth: TwilioAuth;
    fetch: FetchLike;
    now: Date;
  },
): Promise<TwilioConfig | null> {
  const reg = registrationOf(input.config);
  if (!FOLLOWED.includes(reg.stage)) return null;
  const run: Run = {
    tx,
    fetch: input.fetch,
    auth: input.auth,
    row: input.row,
    config: input.config,
    reg: { ...reg, issues: [], fees: [...reg.fees] },
    ein: await einOf(tx, env, input.row),
    now: input.now,
  };
  await follow(run);
  await tell(tx, input.row, run.reg);
  const next = configOf(run);
  const changed =
    run.reg.stage !== reg.stage ||
    next.a2p.brandStatus !== input.config.a2p.brandStatus ||
    next.a2p.campaignStatus !== input.config.a2p.campaignStatus ||
    run.reg.customerProfileStatus !== reg.customerProfileStatus ||
    run.reg.trustProductStatus !== reg.trustProductStatus ||
    run.reg.fees.length !== reg.fees.length;
  next.a2p.checkedAt = input.now.toISOString();
  await tx
    .update(connection)
    .set({ config: next as unknown as Record<string, unknown> })
    .where(and(eq(connection.id, input.row.id), eq(connection.tenantId, input.row.tenantId)));
  if (changed) {
    await tx.insert(connectionChange).values({
      tenantId: input.row.tenantId,
      connectionId: input.row.id,
      actorId: null,
      change: {
        kind: "a2p_registration",
        by: "system",
        what: "status",
        stage: run.reg.stage,
        brandStatus: next.a2p.brandStatus,
        campaignStatus: next.a2p.campaignStatus,
      },
    });
  }
  if (run.reg.fees.length !== reg.fees.length) {
    await rollupPlatformDaily(tx, { tenantId: input.row.tenantId, day: utcDay(input.now) });
  }
  return next;
}

/** After a submit that recorded fees: today's usage counts them at once. */
export async function rollupFees(tx: Tx, tenantId: string, now: Date): Promise<void> {
  await rollupPlatformDaily(tx, { tenantId, day: utcDay(now) });
}

/** The hourly pass: every client whose registration Twilio has, one withTenant each. */
export async function a2pCronTick(
  db: Db,
  deps: { env: Bindings; fetch: FetchLike },
  at: Date,
): Promise<number> {
  if (at.getUTCMinutes() !== A2P_CRON_MINUTE) return 0;
  const clients = await db.select({ id: tenant.id }).from(tenant);
  let passes = 0;
  for (const client of clients) {
    try {
      await withTenant(db, client.id, async (tx) => {
        const row = await twilioConnectionOf(tx, client.id);
        const config = row ? readTwilioConfig(row.config) : null;
        if (!row || !config || row.status !== "connected") return;
        if (!FOLLOWED.includes(registrationOf(config).stage)) return;
        const auth = twilioCredentialsOf(
          await (await connectionCredentials(tx, deps.env, row)).get(),
        );
        if (!auth) return;
        await pollRegistration(tx, deps.env, { row, config, auth, fetch: deps.fetch, now: at });
        passes++;
      });
    } catch (error) {
      reportHandled(`texting registration pass for client ${client.id} failed`, error, {
        job: "a2p",
        client: client.id,
      });
    }
  }
  return passes;
}

/**
 * A number bought after the campaign was verified joins the client's Messaging Service, so it
 * texts under the campaign too.
 */
export async function joinService(
  fetch: FetchLike,
  auth: TwilioAuth,
  config: TwilioConfig,
  number: { sid: string; phoneNumber: string; capabilities: { sms: boolean } },
): Promise<TwilioConfig> {
  const reg = readA2pRegistration(config.a2p.registration);
  const service = config.a2p.messagingServiceSid;
  if (reg?.stage !== "ready" || !service) return config;
  if (!number.capabilities.sms || !isNanpNumber(number.phoneNumber)) return config;
  await addServiceNumber(fetch, auth, service, number.sid);
  return {
    ...config,
    a2p: {
      ...config.a2p,
      registration: { ...reg, serviceNumbers: [...reg.serviceNumbers, number.sid] },
    },
  };
}
