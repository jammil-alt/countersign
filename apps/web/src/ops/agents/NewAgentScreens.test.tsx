// New template and new client agent (O5): the Builder conversation first (a turn starts a session,
// the draft shows beside it, a change can be undone, "Open in workflow builder" saves it), then the
// other starts: required fields are checked before sending, and each (blank, template fork) sends
// the right request.
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { ApiProvider } from "../../api/useApi";
import { SessionProvider, useSessionState } from "../../session/session";
import {
  AGENT_DETAIL,
  AGENT_SUMMARY,
  fakeApi,
  OPERATOR_SESSION,
  SANDBOX_DETAIL,
} from "../../test/fixtures";
import { NewClientAgentScreen } from "./NewClientAgentScreen";
import { NewTemplateScreen } from "./TemplateScreens";

const CLIENT = SANDBOX_DETAIL.client.id;
const TEMPLATE = {
  ...AGENT_SUMMARY,
  id: "00000000-0000-4000-8000-00000000f001",
  kind: "template" as const,
  tenantId: null,
  slug: "purchasing-clerk",
  name: "Purchasing clerk",
};

function SignedIn({ children }: { children: ReactNode }) {
  const { state } = useSessionState();
  return state.status === "signed_in" ? children : null;
}

function renderAt(path: string, routes: Parameters<typeof fakeApi>[0]) {
  const api = fakeApi({ "GET /api/session": () => OPERATOR_SESSION, ...routes });
  render(
    <MemoryRouter initialEntries={[path]}>
      <ApiProvider client={api.client}>
        <SessionProvider>
          <SignedIn>
            <Routes>
              <Route path="/ops/templates/new" element={<NewTemplateScreen />} />
              <Route path="/ops/templates/:slug/*" element={<p>template page</p>} />
              <Route path="/ops/clients/:clientId/agents/new" element={<NewClientAgentScreen />} />
              <Route path="/ops/clients/:clientId/agents/:slug/*" element={<p>agent page</p>} />
            </Routes>
          </SignedIn>
        </SessionProvider>
      </ApiProvider>
    </MemoryRouter>,
  );
  return { api, user: userEvent.setup() };
}

describe("new template", () => {
  it("needs a name, then creates a blank draft template and opens it", async () => {
    const sent: {
      slug: string;
      bundle: { workflows: unknown[]; definition: { identity: { name: string } } };
    }[] = [];
    const { user } = renderAt("/ops/templates/new", {
      "POST /api/ops/templates": ({ init }) => {
        const body = JSON.parse(String(init.body));
        sent.push(body);
        return { agent: { ...TEMPLATE, slug: body.slug }, version: AGENT_DETAIL.versions[1] };
      },
    });
    await user.click(await screen.findByTestId("new-template-start-blank"));
    await user.click(await screen.findByTestId("new-template-create"));
    expect(screen.getByTestId("new-template-name-error")).toBeInTheDocument();
    expect(sent).toEqual([]);

    await user.type(screen.getByTestId("new-template-name-input"), "Purchasing clerk");
    expect(screen.getByTestId("new-template-slug-input")).toHaveValue("purchasing-clerk");
    await user.click(screen.getByTestId("new-template-create"));
    expect(await screen.findByText("template page")).toBeInTheDocument();
    expect(sent[0]?.slug).toBe("purchasing-clerk");
    expect(sent[0]?.bundle.definition.identity.name).toBe("Purchasing clerk");
    expect(sent[0]?.bundle.workflows).toHaveLength(1);
  });
});

const SESSION_ID = "00000000-0000-4000-8000-0000000c5001";
const TURN_ID = "00000000-0000-4000-8000-0000000c5102";

function turn(seq: number, role: "operator" | "builder", text: string, extra = {}) {
  return {
    id: seq === 2 ? TURN_ID : `00000000-0000-4000-8000-0000000c51${String(seq).padStart(2, "0")}`,
    seq,
    role,
    text,
    command: seq === 0 ? "/start" : null,
    changes: [],
    questions: [],
    gaps: [],
    notes: [],
    errors: [],
    savedVersionId: null,
    costUsd: "0",
    undoneAt: null,
    createdAt: "2026-11-06T10:00:00.000Z",
    ...extra,
  };
}

/** A Builder conversation as the API answers it: its draft, and its turns so far. */
function sessionDetail(clientId: string | null, turns: ReturnType<typeof turn>[], undone = false) {
  return {
    session: {
      id: SESSION_ID,
      kind: "agent",
      clientId,
      clientName: clientId ? "Sandbox" : null,
      agentId: null,
      skillId: null,
      baseVersionId: null,
      status: "open",
      bundle: AGENT_DETAIL.live.bundle,
      errors: [],
      closest: [
        {
          agentId: TEMPLATE.id,
          slug: TEMPLATE.slug,
          name: "Purchasing clerk",
          version: 2,
          score: 0.62,
        },
      ],
      createdAt: "2026-11-06T10:00:00.000Z",
      updatedAt: "2026-11-06T10:00:00.000Z",
    },
    turns: turns.map((t) =>
      undone ? { ...t, changes: t.changes.map((c: object) => ({ ...c, undone: true })) } : t,
    ),
  };
}

const ANSWERED = [
  turn(0, "operator", "Started a new template."),
  turn(1, "operator", "Itemize bills and ask about big changes"),
  turn(2, "builder", "Here's a first plan. Two questions before I go on:", {
    changes: [
      { id: "step:confidence", label: "fork “Match confidence”", after: {}, undone: false },
    ],
    questions: ["Should contractors be included?"],
    gaps: ["There is no card feed connector."],
  }),
];

describe("new agent by conversation", () => {
  it("talks to the Builder, shows the draft, undoes a change and opens it in the builder", async () => {
    const sent: { path: string; body: unknown }[] = [];
    const record = (path: string, init: RequestInit) =>
      sent.push({ path, body: init.body ? JSON.parse(String(init.body)) : null });
    const { user } = renderAt("/ops/templates/new", {
      "POST /api/ops/builder/sessions": ({ init }) => {
        record("start", init);
        return sessionDetail(null, ANSWERED.slice(0, 1));
      },
      [`POST /api/ops/builder/sessions/${SESSION_ID}/turns`]: ({ init }) => {
        record("turn", init);
        return { ...sessionDetail(null, ANSWERED), turn: ANSWERED[2] };
      },
      [`POST /api/ops/builder/sessions/${SESSION_ID}/undo`]: ({ init }) => {
        record("undo", init);
        return { ...sessionDetail(null, ANSWERED, true), turn: ANSWERED[2] };
      },
      [`POST /api/ops/builder/sessions/${SESSION_ID}/save`]: ({ init }) => {
        record("save", init);
        return {
          ...sessionDetail(null, ANSWERED),
          turn: ANSWERED[2],
          agent: { id: TEMPLATE.id, slug: "material-costs" },
          skill: null,
          version: { id: AGENT_DETAIL.live.id, version: 1 },
          cases: [],
          errors: [],
        };
      },
    });
    expect(await screen.findByTestId("new-agent-chat-empty")).toBeInTheDocument();
    expect(screen.getByTestId("new-agent-plan-empty")).toBeInTheDocument();
    await user.type(
      screen.getByTestId("builder-composer-input"),
      "Itemize bills and ask about big changes",
    );
    await user.click(screen.getByTestId("builder-composer-send"));

    expect(await screen.findByTestId("new-agent-draft-name")).toHaveTextContent("Material costs");
    expect(sent.slice(0, 2)).toEqual([
      { path: "start", body: { kind: "agent" } },
      { path: "turn", body: { text: "Itemize bills and ask about big changes" } },
    ]);
    expect(screen.getByTestId("builder-questions")).toHaveTextContent(/contractors/);
    expect(screen.getByTestId("builder-turn-gaps")).toHaveTextContent(/card feed/);
    expect(screen.getAllByTestId("new-agent-plan-step")).toHaveLength(5);
    expect(screen.getByTestId("new-agent-starts")).toHaveTextContent("When bill created");
    expect(screen.getByTestId("new-agent-access-qbo")).toHaveTextContent("QuickBooks · Itemize a bill");
    expect(screen.getByTestId("new-agent-closest")).toHaveTextContent("62% alike");

    await user.click(screen.getByTestId("builder-change-undo"));
    expect(await screen.findByText("Undone")).toBeInTheDocument();
    expect(sent[2]).toEqual({
      path: "undo",
      body: { turnId: TURN_ID, changeId: "step:confidence" },
    });

    await user.click(screen.getByTestId("new-agent-open-builder"));
    expect(await screen.findByText("template page")).toBeInTheDocument();
    expect(sent[3]?.path).toBe("save");
  });

  it("drafts a client agent for that client and shows the access it will ask for", async () => {
    const sent: unknown[] = [];
    const { user } = renderAt(`/ops/clients/${CLIENT}/agents/new`, {
      [`GET /api/ops/clients/${CLIENT}`]: () => SANDBOX_DETAIL,
      "GET /api/ops/templates": () => ({ templates: [] }),
      "POST /api/ops/builder/sessions": ({ init }) => {
        sent.push(JSON.parse(String(init.body)));
        return sessionDetail(CLIENT, ANSWERED.slice(0, 1));
      },
      [`POST /api/ops/builder/sessions/${SESSION_ID}/turns`]: () => ({
        ...sessionDetail(CLIENT, ANSWERED),
        turn: ANSWERED[2],
      }),
    });
    expect(await screen.findByText("New agent for Sandbox")).toBeInTheDocument();
    await user.type(screen.getByTestId("builder-composer-input"), "Chase receipts");
    await user.click(screen.getByTestId("builder-composer-send"));
    expect(await screen.findByTestId("new-agent-access-qbo")).toHaveTextContent("Not connected");
    expect(sent).toEqual([{ kind: "agent", clientId: CLIENT }]);
  });
});

describe("new client agent", () => {
  it("forks the chosen template version with the slug and service name", async () => {
    const sent: unknown[] = [];
    const { user } = renderAt(`/ops/clients/${CLIENT}/agents/new`, {
      [`GET /api/ops/clients/${CLIENT}`]: () => SANDBOX_DETAIL,
      "GET /api/ops/templates": () => ({ templates: [TEMPLATE] }),
      [`GET /api/ops/agents/${TEMPLATE.id}`]: () => ({ ...AGENT_DETAIL, agent: TEMPLATE }),
      [`GET /api/ops/agents/${TEMPLATE.id}/versions/${AGENT_DETAIL.live.id}`]: () => ({
        version: AGENT_DETAIL.live,
      }),
      [`POST /api/ops/templates/${TEMPLATE.id}/fork`]: ({ init }) => {
        sent.push(JSON.parse(String(init.body)));
        return { agent: { ...AGENT_SUMMARY, slug: "costs" }, version: AGENT_DETAIL.versions[1] };
      },
    });
    await user.click(await screen.findByTestId("new-agent-start-template-purchasing-clerk"));
    expect(await screen.findByTestId("new-agent-start-builder")).not.toBeChecked();
    expect(await screen.findByTestId("new-agent-template-version-select")).toHaveValue(
      AGENT_DETAIL.live.id,
    );
    expect(await screen.findByText("Find supporting document")).toBeInTheDocument();
    await user.clear(screen.getByTestId("new-agent-slug-input"));
    await user.type(screen.getByTestId("new-agent-slug-input"), "costs");
    await user.type(screen.getByTestId("new-agent-service-name-input"), "Material costs");
    await user.click(screen.getByTestId("new-agent-create"));
    expect(await screen.findByText("agent page")).toBeInTheDocument();
    expect(sent).toEqual([
      {
        clientId: CLIENT,
        versionId: AGENT_DETAIL.live.id,
        slug: "costs",
        serviceName: "Material costs",
      },
    ]);
  });

  it("refuses a slug the client already uses", async () => {
    const { user } = renderAt(`/ops/clients/${CLIENT}/agents/new`, {
      [`GET /api/ops/clients/${CLIENT}`]: () => SANDBOX_DETAIL,
      "GET /api/ops/templates": () => ({ templates: [] }),
    });
    await user.click(await screen.findByTestId("new-agent-start-blank"));
    await user.type(await screen.findByTestId("new-agent-name-input"), "Material costs");
    await user.click(screen.getByTestId("new-agent-create"));
    expect(screen.getByTestId("new-agent-slug-error")).toHaveTextContent(/already has an agent/);
  });
});
