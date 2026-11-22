// The desktop app's routes (docs/plan.md §1.151, §1.199): pairing a computer and the folders it
// gives, with a client admin's session; then the computer's own requests, each signed with its key
// (DESKTOP_DEVICE_HEADER, DESKTOP_TIME_HEADER, DESKTOP_SIGNATURE_HEADER over `desktopRequestText`).
// The signed routes are `public` here: no session, the signature is the credential (as an inbound
// hook's token is), and apps/api checks it before anything is read.

import { z } from "zod";
import {
  DesktopFolder,
  DesktopFoldersBody,
  DesktopJobsResponse,
  PairDesktopBody,
  PairedDesktop,
} from "../desktop/protocol";
import { isUuid } from "../ids";
import { defineRoute } from "./contract";

const Id = z.string().refine((v) => isUuid(v), "not an id");
const ADMIN = ["client_admin"] as const;

export const DesktopOk = z.object({ ok: z.literal(true) });

export const DesktopFileResponse = z.object({
  documentId: z.string(),
  /** False when the client already had these bytes: nothing new was stored or started. */
  created: z.boolean(),
});

export const desktopRoutes = {
  pairDesktop: defineRoute({
    method: "POST",
    path: "/api/desktop/devices",
    auth: "session",
    roles: ADMIN,
    summary: "Pair this computer with the client: the public half of its key, never the private",
    body: PairDesktopBody,
    response: PairedDesktop,
  }),
  unpairDesktop: defineRoute({
    method: "DELETE",
    path: "/api/desktop/devices/:id",
    auth: "session",
    roles: ADMIN,
    summary: "Remove a computer: its key is cleared and nothing it signs is accepted again",
    params: z.object({ id: Id }),
    response: DesktopOk,
  }),
  setDesktopFolders: defineRoute({
    method: "PUT",
    path: "/api/desktop/devices/:id/folders",
    auth: "session",
    roles: ADMIN,
    summary: "The folders this computer gives Mezonas, replacing the list",
    params: z.object({ id: Id }),
    body: DesktopFoldersBody,
    response: z.object({ folders: z.array(DesktopFolder) }),
  }),
  desktopJobs: defineRoute({
    method: "GET",
    path: "/api/desktop/jobs",
    auth: "public",
    roles: [],
    summary: "The computer's jobs (signed by the computer): waits up to 25 seconds for one",
    query: z.object({ wait: z.coerce.number().int().min(0).max(25).optional() }),
    response: DesktopJobsResponse,
  }),
  desktopJobResult: defineRoute({
    method: "POST",
    path: "/api/desktop/jobs/:id/result",
    auth: "public",
    roles: [],
    summary: "A job's result (signed by the computer that was given it)",
    params: z.object({ id: Id }),
    response: DesktopOk,
  }),
  desktopFile: defineRoute({
    method: "POST",
    path: "/api/desktop/files",
    auth: "public",
    roles: [],
    summary: "A file from a folder set to send (signed by the computer): it becomes a document",
    response: DesktopFileResponse,
  }),
} as const;
