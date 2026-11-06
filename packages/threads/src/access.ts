// Who reads and posts in a thread (ARCHITECTURE §11.2). Pure: the routes and the agent port ask
// these questions of a thread row they already scoped to one client (RLS and a tenant filter,
// invariant 1). An operator is someone the session serves the thread's client as.
//
// | kind      | reads and posts                                                       |
// |-----------|-----------------------------------------------------------------------|
// | lead      | every member of the client; the client's operators                     |
// | account   | the person who started it, the client admins; the operators           |
// | agent     | every member of the client; the operators                              |
// | otherwise | (run, contact, record subjects) the operators, as before v0.12        |

import { isClientThreadKind, type MessageAudience } from "@countersign/core";

export type Viewer =
  | { kind: "operator"; userId: string }
  | { kind: "client"; role: "client_admin" | "client_user"; userId: string };

export interface ThreadAccessRow {
  subjectType: string | null;
  createdBy: string | null;
}

export function canRead(viewer: Viewer, thread: ThreadAccessRow): boolean {
  if (viewer.kind === "operator") return true;
  if (!isClientThreadKind(thread.subjectType)) return false;
  if (thread.subjectType === "account") {
    return viewer.role === "client_admin" || thread.createdBy === viewer.userId;
  }
  return true;
}

// DECISION: operators post in every thread they read except a contact's, whose messages are texts
// and calls with that person: a note there would read as something sent to them.
export function canPost(viewer: Viewer, thread: ThreadAccessRow): boolean {
  if (!canRead(viewer, thread)) return false;
  return viewer.kind === "client" || thread.subjectType !== "contact";
}

/** The audiences a viewer's message lists include: clients never see operator-only notes. */
export function visibleAudiences(viewer: Viewer): MessageAudience[] {
  return viewer.kind === "operator" ? ["client", "operator"] : ["client"];
}
