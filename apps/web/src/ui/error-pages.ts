// Which state a failed page is in, and what the page was for: read from the error and the address,
// so ErrorNotice (./ErrorState.tsx) needs nothing from the screen that shows it.
import { isApiError } from "../api/client";

/**
 * - `not_found`: a 404, a route id the API refused, or another client's item (`tenant_forbidden`).
 * - `forbidden`: a 403 for the person's role (`forbidden`).
 * - `failure`: we failed (5xx, no answer, 429, an answer we didn't expect): retry helps.
 * - `other`: the API refused what was sent (a form's 400, a 409), or a screen's own error: its
 *   own words, as before.
 */
export type ErrorKind = "not_found" | "forbidden" | "failure" | "other";

export function errorKind(error: unknown): ErrorKind {
  // A screen's own error (thrown with words for the reader) reads as it was written.
  if (!isApiError(error)) return "other";
  if (error.status === 404 || error.badParam || error.code === "tenant_forbidden") {
    return "not_found";
  }
  if (error.status === 403 && error.code === "forbidden") return "forbidden";
  if (
    error.code === "network" ||
    error.code === "invalid_response" ||
    error.status === 429 ||
    error.status >= 500
  ) {
    return "failure";
  }
  return "other";
}

export type ResourceKind =
  | "run"
  | "agent"
  | "record"
  | "document"
  | "conversation"
  | "connection"
  | "client"
  | "template"
  | "skill"
  | "page";

type BackKey =
  `errorPage.back.${"home" | "runs" | "records" | "sloan" | "accounts" | "clients" | "lab" | "skills"}`;

interface Way {
  to: string;
  label: BackKey;
}

export interface PageResource {
  kind: ResourceKind;
  /** The matching list. */
  back: Way;
  /** Home for this side of the app (the portal, or the back office). */
  home: Way;
}

const PORTAL_HOME: Way = { to: "/", label: "errorPage.back.home" };
const OPS_HOME: Way = { to: "/ops", label: "errorPage.back.home" };

/** What a page at this address shows, and where its list is. */
export function pageResource(pathname: string): PageResource {
  const parts = pathname.split("/").filter(Boolean);
  if (parts[0] === "ops") return opsResource(parts.slice(1));
  const at = (kind: ResourceKind, back: Way): PageResource => ({ kind, back, home: PORTAL_HOME });
  switch (parts[0]) {
    case "runs":
      return at("run", { to: "/runs", label: "errorPage.back.runs" });
    case "agents":
    case "services":
      // The portal has no list of agents: they are in the sidebar, from Home.
      return at("agent", PORTAL_HOME);
    case "records":
      return at("record", { to: "/records", label: "errorPage.back.records" });
    case "documents":
      return at("document", { to: "/records", label: "errorPage.back.records" });
    case "sloan":
      return at("conversation", { to: "/sloan", label: "errorPage.back.sloan" });
    case "connections":
    case "accounts":
      return at("connection", { to: "/connectors", label: "errorPage.back.accounts" });
    default:
      return at("page", PORTAL_HOME);
  }
}

function opsResource(parts: string[]): PageResource {
  const at = (kind: ResourceKind, back: Way): PageResource => ({ kind, back, home: OPS_HOME });
  const clients: Way = { to: "/ops/clients", label: "errorPage.back.clients" };
  switch (parts[0]) {
    case "runs":
      return at("run", { to: "/ops/runs", label: "errorPage.back.runs" });
    case "clients": {
      // A client's document or record: back to that client's list of them.
      const [, clientId, section, item] = parts;
      if (clientId && item && (section === "documents" || section === "records")) {
        return at(section === "documents" ? "document" : "record", {
          to: `/ops/clients/${clientId}/${section}`,
          label: "errorPage.back.clients",
        });
      }
      if (clientId && section === "agents" && parts[3]) {
        return at("agent", {
          to: `/ops/clients/${clientId}/agents`,
          label: "errorPage.back.clients",
        });
      }
      return at(clientId ? "client" : "page", clients);
    }
    case "agents":
      return at("agent", { to: "/ops/lab", label: "errorPage.back.lab" });
    case "templates":
      return at("template", { to: "/ops/lab", label: "errorPage.back.lab" });
    case "skills":
      return at("skill", { to: "/ops/library/skills", label: "errorPage.back.skills" });
    default:
      return at("page", OPS_HOME);
  }
}
