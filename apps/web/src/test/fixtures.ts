// Shared test data and a fake API: a router over `METHOD /path` that answers like the Worker.
import { AgentBundle, type AgentBundleInput, type SessionResponse } from "@countersign/core";
import { type ApiClient, createApiClient } from "../api/client";

export const OPERATOR_SESSION: SessionResponse = {
  user: {
    id: "00000000-0000-4000-8000-00000000d001",
    email: "operator@example.com",
    name: "Operator",
  },
  operator: true,
  tenants: [
    { id: "00000000-0000-4000-8000-00000000a001", name: "Sandbox", role: "operator" },
    { id: "00000000-0000-4000-8000-00000000a002", name: "Demo client", role: "operator" },
  ],
  activeTenantId: null,
  language: { effective: "en", user: null, client: null },
};

export const CLIENT_SESSION: SessionResponse = {
  user: {
    id: "00000000-0000-4000-8000-00000000d002",
    email: "admin@demo-client.example.com",
    name: "Demo admin",
  },
  operator: false,
  tenants: [
    { id: "00000000-0000-4000-8000-00000000a002", name: "Demo client", role: "client_admin" },
  ],
  activeTenantId: "00000000-0000-4000-8000-00000000a002",
  language: { effective: "en", user: null, client: null },
};

/** A bundle whose workflow has a trigger, skills, an action and a fork with two paths. */
export const FORK_BUNDLE_INPUT: AgentBundleInput = {
  schemaVersion: 1,
  definition: {
    schemaVersion: 2,
    identity: {
      name: "Material costs",
      role: "Purchasing",
      mission: "Keep bills itemized and flag price changes.",
    },
    kind: "functional",
    model: { id: "claude-opus-5-5" },
    instructions: "Itemize bills.",
    skills: [{ skill: "docs.extract" }, { skill: "docs.find-support" }],
  },
  workflows: [
    {
      slug: "new-bill",
      name: "New bill",
      workflow: {
        schemaVersion: 3,
        trigger: { id: "t1", on: { type: "event", event: "bill.created" } },
        steps: [
          {
            id: "find",
            kind: "skill",
            name: "Find supporting document",
            skill: "docs.find-support",
          },
          { id: "read", kind: "skill", name: "Read a document", skill: "docs.extract" },
          {
            id: "confidence",
            kind: "fork",
            name: "Match confidence",
            paths: [
              {
                id: "low",
                name: "Any line below 90%",
                when: {
                  match: "any",
                  rules: [{ field: "{{steps.read.output.confidence}}", op: "<", value: 0.9 }],
                },
                steps: [
                  {
                    id: "ask",
                    kind: "person",
                    name: "Ask Jammil",
                    mode: "ask",
                    assignee: "client_admin",
                    title: "Check the match",
                    timeout: "2 days",
                    onTimeout: "stop",
                  },
                ],
              },
              {
                id: "big",
                name: "Big change",
                when: { rules: [{ field: "steps.read.output.total", op: ">", value: 500 }] },
                steps: [],
              },
            ],
            otherwise: { id: "else", steps: [] },
          },
          {
            id: "update",
            kind: "action",
            name: "Update bill",
            tool: "qbo.bill.update_lines",
            input: { billId: "{{trigger.billId}}" },
          },
        ],
      },
    },
  ],
};

export const FORK_BUNDLE = AgentBundle.parse(FORK_BUNDLE_INPUT);

/** Version n of the fixture agent. */
export const versionId = (n: number) =>
  `00000000-0000-4000-8000-0000000e${String(n).padStart(4, "0")}`;

export const AGENT_SUMMARY = {
  id: "00000000-0000-4000-8000-00000000b001",
  tenantId: "00000000-0000-4000-8000-00000000a001",
  kind: "client" as const,
  slug: "material-costs",
  name: "Material costs",
  role: "Purchasing",
  templateId: null,
  linked: true,
  liveVersionId: versionId(1),
  status: "active",
  runStatus: "active",
  serviceName: null,
  serviceDescription: "Reads vendor invoices and keeps bills itemized.",
  bindings: { qbo: "00000000-0000-4000-8000-00000000c001" },
  approver: null,
  testCopy: false,
  createdAt: "2026-11-01T00:00:00.000Z",
};

const version = (n: number, status: string, changeNote: string) => ({
  id: versionId(n),
  agentId: "00000000-0000-4000-8000-00000000b001",
  version: n,
  status,
  bundleHash: `hash-${n}`,
  changeNote,
  releaseNote: null,
  authorType: "operator",
  authorId: null,
  parentVersionId: n > 1 ? versionId(n - 1) : null,
  basedOnTemplateVersionId: null,
  mergedFromVersionIds: null,
  createdAt: `2026-11-0${n}T10:00:00.000Z`,
});

/** As apps/api answers GET /api/ops/agents/:id: v1 live, v2 a draft with the fork. */
export const AGENT_DETAIL = {
  agent: AGENT_SUMMARY,
  versions: [version(2, "draft", "Adds the fork"), version(1, "live", "First version")],
  live: { ...version(1, "live", "First version"), bundle: FORK_BUNDLE_INPUT },
  latest: { ...version(2, "draft", "Adds the fork"), bundle: FORK_BUNDLE_INPUT },
  update: null,
};

export const SANDBOX_DETAIL = {
  client: {
    id: "00000000-0000-4000-8000-00000000a001",
    name: "Sandbox",
    timezone: "UTC",
    settings: {},
    createdAt: "2026-11-01T00:00:00.000Z",
  },
  agents: [AGENT_SUMMARY],
  connections: [],
  members: [],
};

type Handler = (req: { url: URL; init: RequestInit }) => unknown;

/** A JSON reply with a status, for handlers that need one other than 200. */
export class Reply {
  constructor(
    readonly status: number,
    readonly body: unknown,
  ) {}
}

export interface FakeApi {
  client: ApiClient;
  calls: string[];
  /** Replace or add a handler. */
  on(route: string, handler: Handler): void;
}

/** Unknown routes answer 404 `{ error: "not_found" }`, as the Worker does. */
export function fakeApi(routes: Record<string, Handler>): FakeApi {
  const table = new Map(Object.entries(routes));
  const calls: string[] = [];
  const fetch = async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = new URL(String(input), "http://localhost");
    const key = `${init.method ?? "GET"} ${url.pathname}`;
    calls.push(key);
    const handler = table.get(key);
    // A handler may answer later (a promise), e.g. to show a pending state.
    const out = await (handler ? handler({ url, init }) : new Reply(404, { error: "not_found" }));
    const reply = out instanceof Reply ? out : new Reply(200, out);
    return new Response(JSON.stringify(reply.body), {
      status: reply.status,
      headers: { "content-type": "application/json" },
    });
  };
  return {
    client: createApiClient({ fetch: fetch as typeof globalThis.fetch }),
    calls,
    on: (route, handler) => table.set(route, handler),
  };
}
