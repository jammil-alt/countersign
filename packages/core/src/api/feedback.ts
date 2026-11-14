import { z } from "zod";
import { isUuid } from "../ids";
import { defineRoute } from "./contract";

// The Feedback button's routes (docs/plan.md §1.10). Anyone in the back office, and client users of
// a client the operator has switched feedback on for, send feedback; only operators read it.

const Id = z.string().refine((v) => isUuid(v), "not an id");
const IdParams = z.object({ id: Id });
const OPS = ["operator"] as const;
const CLIENT = ["client_admin", "client_user"] as const;

/** Screenshots are JPEG only, at most this many bytes. */
export const FEEDBACK_SCREENSHOT_MAX_BYTES = 2_000_000;
export const FEEDBACK_SCREENSHOT_TYPE = "image/jpeg";
export const FEEDBACK_COMMENT_MAX = 4000;
export const FEEDBACK_REASON_MAX = 500;

export const FeedbackViewport = z.strictObject({
  width: z.number().int().min(1).max(20_000),
  height: z.number().int().min(1).max(20_000),
});
/** Where the pin was dropped, in CSS pixels of the viewport. */
export const FeedbackPin = z.strictObject({
  x: z.number().min(0).max(20_000),
  y: z.number().min(0).max(20_000),
});

/** How feedback was sent: the Feedback button, or "Report an issue" on a page that failed to load. */
export const FeedbackSource = z.enum(["button", "error_page"]);
export type FeedbackSource = z.infer<typeof FeedbackSource>;

const Short = z.string().max(300);
/**
 * What an error page knew when it failed, for us: never shown to the person sending it, and only
 * what debugging needs (no request or response bodies, no query strings of API calls).
 */
export const FeedbackErrorContext = z.strictObject({
  /** The app route pattern or path, e.g. `/runs/:id`. */
  route: Short,
  /** The page's full address. */
  url: z.string().max(2000),
  /** HTTP status of the call that failed; 0 when it never reached us. */
  status: z.number().int().min(0).max(999),
  code: Short,
  /** The call that failed, e.g. `GET /api/runs/not-a-uuid`. */
  request: z.string().max(2000).nullable(),
  /** When it failed, ISO 8601. */
  at: z.string().max(40),
  tenantId: Short.nullable(),
  userId: Short.nullable(),
  release: Short.nullable(),
  /** Sentry's event for a failure we report there (5xx, network); null for an expected 4xx. */
  sentryEventId: Short.nullable(),
});
export type FeedbackErrorContext = z.infer<typeof FeedbackErrorContext>;

export const FeedbackSubmission = z.strictObject({
  comment: z.string().trim().min(1).max(FEEDBACK_COMMENT_MAX),
  /** The app path (and query) it was sent from. */
  path: z.string().min(1).max(2000),
  viewport: FeedbackViewport,
  /** Null for "no particular spot". */
  pin: FeedbackPin.nullable(),
  /** A short description of what was under the pin, e.g. `button "Approve"`. */
  target: z.string().max(300).nullable(),
  /** Left out: the Feedback button. */
  source: FeedbackSource.optional(),
  /** An error page's context; only with `source: "error_page"`. */
  context: FeedbackErrorContext.optional(),
});
export type FeedbackSubmission = z.infer<typeof FeedbackSubmission>;

export const FeedbackStatus = z.enum(["open", "resolved"]);
export type FeedbackStatus = z.infer<typeof FeedbackStatus>;

const Person = z.object({ id: z.string(), email: z.string(), name: z.string().nullable() });

export const FeedbackItem = z.object({
  id: z.string(),
  surface: z.enum(["ops", "portal"]),
  /** Null for back-office feedback. */
  client: z.object({ id: z.string(), name: z.string() }).nullable(),
  from: Person,
  comment: z.string(),
  path: z.string(),
  viewport: FeedbackViewport,
  pin: FeedbackPin.nullable(),
  target: z.string().nullable(),
  hasScreenshot: z.boolean(),
  source: FeedbackSource,
  /** What failed, for "Report an issue" on an error page; null from the Feedback button. */
  context: FeedbackErrorContext.nullable(),
  status: FeedbackStatus,
  createdAt: z.string(),
  resolvedAt: z.string().nullable(),
  resolvedBy: Person.nullable(),
  resolutionNote: z.string().nullable(),
});
export type FeedbackItem = z.infer<typeof FeedbackItem>;

export const FeedbackSetting = z.object({
  enabled: z.boolean(),
  /** Newest first. */
  changes: z.array(
    z.object({
      id: z.string(),
      enabled: z.boolean(),
      reason: z.string(),
      by: Person.nullable(),
      createdAt: z.string(),
    }),
  ),
});

const Sent = z.object({ id: z.string() });
const Uploaded = z.object({ ok: z.literal(true), bytes: z.number().int() });

export const feedbackRoutes = {
  portalFeedbackStatus: defineRoute({
    method: "GET",
    path: "/api/feedback/status",
    auth: "session",
    roles: CLIENT,
    summary: "Whether this client can send feedback (the operator switches it on per client)",
    response: z.object({ enabled: z.boolean() }),
  }),
  portalSendFeedback: defineRoute({
    method: "POST",
    path: "/api/feedback",
    auth: "session",
    roles: CLIENT,
    summary: "Send feedback; 403 unless the operator switched feedback on for this client",
    body: FeedbackSubmission,
    response: Sent,
  }),
  portalFeedbackScreenshot: defineRoute({
    method: "PUT",
    path: "/api/feedback/:id/screenshot",
    auth: "session",
    roles: CLIENT,
    summary: "Attach the screenshot to feedback you just sent (body: the JPEG bytes)",
    params: IdParams,
    response: Uploaded,
  }),
  opsSendFeedback: defineRoute({
    method: "POST",
    path: "/api/ops/feedback",
    auth: "session",
    roles: OPS,
    summary: "Send feedback from the back office",
    body: FeedbackSubmission,
    response: Sent,
  }),
  opsFeedbackUploadScreenshot: defineRoute({
    method: "PUT",
    path: "/api/ops/feedback/:id/screenshot",
    auth: "session",
    roles: OPS,
    summary: "Attach the screenshot to back-office feedback you just sent (body: the JPEG bytes)",
    params: IdParams,
    response: Uploaded,
  }),
  opsFeedback: defineRoute({
    method: "GET",
    path: "/api/ops/feedback",
    auth: "session",
    roles: OPS,
    summary: "Feedback from the back office and the clients this operator serves, newest first",
    query: z.object({
      status: z.enum(["open", "resolved", "all"]).default("open"),
      /** Only the Feedback button's, or only error pages' reports; left out, both. */
      source: FeedbackSource.optional(),
    }),
    response: z.object({ items: z.array(FeedbackItem) }),
  }),
  opsFeedbackScreenshot: defineRoute({
    method: "GET",
    path: "/api/ops/feedback/:id/screenshot",
    auth: "session",
    roles: OPS,
    summary: "A 5-minute link to a feedback screenshot",
    params: IdParams,
    response: z.object({ url: z.string(), expiresAt: z.string() }),
  }),
  opsResolveFeedback: defineRoute({
    method: "POST",
    path: "/api/ops/feedback/:id/resolve",
    auth: "session",
    roles: OPS,
    summary: "Resolve feedback, with an optional note (e.g. a PR link)",
    params: IdParams,
    body: z.strictObject({ note: z.string().trim().max(2000).optional() }),
    response: z.object({ item: FeedbackItem }),
  }),
  opsReopenFeedback: defineRoute({
    method: "POST",
    path: "/api/ops/feedback/:id/reopen",
    auth: "session",
    roles: OPS,
    summary: "Reopen resolved feedback",
    params: IdParams,
    response: z.object({ item: FeedbackItem }),
  }),
  opsClientFeedback: defineRoute({
    method: "GET",
    path: "/api/ops/clients/:id/feedback",
    auth: "session",
    roles: OPS,
    summary: "Whether a client's portal shows the Feedback button, and who changed it and why",
    params: IdParams,
    response: FeedbackSetting,
  }),
  opsSetClientFeedback: defineRoute({
    method: "PUT",
    path: "/api/ops/clients/:id/feedback",
    auth: "session",
    roles: OPS,
    summary: "Switch the Feedback button on or off for a client's portal (a reason is optional)",
    params: IdParams,
    body: z.strictObject({
      enabled: z.boolean(),
      reason: z.string().trim().max(FEEDBACK_REASON_MAX).optional(),
    }),
    response: FeedbackSetting,
  }),
} as const;
