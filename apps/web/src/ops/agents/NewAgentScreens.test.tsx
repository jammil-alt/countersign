// New template and new client agent: the page renders before anything is typed, required fields
// are checked before sending, and each start (blank, template fork) sends the right request.
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
              <Route path="/ops/templates/:slug" element={<p>template page</p>} />
              <Route path="/ops/clients/:clientId/agents/new" element={<NewClientAgentScreen />} />
              <Route path="/ops/clients/:clientId/agents/:slug" element={<p>agent page</p>} />
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

/** What POST /api/ops/agents/draft answers: a saved v1 draft with gaps and the guards' notes. */
function draftResponse(
  agent: Omit<typeof AGENT_SUMMARY, "tenantId" | "kind"> & {
    tenantId: string | null;
    kind: "template" | "client";
  },
) {
  return {
    agent,
    version: { ...AGENT_DETAIL.versions[1], version: 1, status: "draft", authorType: "builder" },
    bundle: AGENT_DETAIL.live.bundle,
    summary: "It lists card charges over $500 without a receipt and asks you about each.",
    gaps: ["There is no card feed connector, so it can't read card charges."],
    notes: ["Approval stays on for 1 step that changes a client's tool."],
    errors: [],
    costUsd: "0.012000",
    startFromTemplate: null,
  };
}

describe("new template from a description", () => {
  it("needs a description, drafts with the Builder, shows gaps and opens the builder", async () => {
    const sent: unknown[] = [];
    const { user } = renderAt("/ops/templates/new", {
      "POST /api/ops/agents/draft": ({ init }) => {
        sent.push(JSON.parse(String(init.body)));
        return draftResponse({ ...TEMPLATE, slug: "card-receipts", name: "Card receipts" });
      },
    });
    await user.click(await screen.findByTestId("new-agent-start-builder"));
    await user.click(screen.getByTestId("builder-draft"));
    expect(sent).toEqual([]);
    await user.type(
      screen.getByTestId("builder-description-input"),
      "Flag card charges over $500 missing receipts",
    );
    await user.click(screen.getByTestId("builder-draft"));
    expect(await screen.findByTestId("builder-result")).toBeInTheDocument();
    expect(sent).toEqual([{ description: "Flag card charges over $500 missing receipts" }]);
    expect(screen.getByTestId("builder-gaps")).toHaveTextContent(/no card feed connector/);
    expect(screen.getByTestId("builder-notes")).toHaveTextContent(/Approval stays on/);
    expect(screen.getByTestId("builder-open-builder")).toHaveAttribute(
      "href",
      expect.stringMatching(/^\/ops\/templates\/card-receipts\/workflows\//),
    );
  });

  it("drafts a client agent for that client", async () => {
    const sent: unknown[] = [];
    const { user } = renderAt(`/ops/clients/${CLIENT}/agents/new`, {
      [`GET /api/ops/clients/${CLIENT}`]: () => SANDBOX_DETAIL,
      "GET /api/ops/templates": () => ({ templates: [] }),
      "POST /api/ops/agents/draft": ({ init }) => {
        sent.push(JSON.parse(String(init.body)));
        return draftResponse({ ...AGENT_SUMMARY, tenantId: CLIENT, slug: "card-receipts" });
      },
    });
    await user.click(await screen.findByTestId("new-agent-start-builder"));
    await user.type(screen.getByTestId("builder-name-input"), "Card receipts");
    await user.type(screen.getByTestId("builder-description-input"), "Chase receipts");
    await user.click(screen.getByTestId("builder-draft"));
    expect(await screen.findByTestId("builder-result")).toBeInTheDocument();
    expect(sent).toEqual([
      { description: "Chase receipts", clientId: CLIENT, name: "Card receipts" },
    ]);
    expect(screen.getByTestId("builder-open-agent")).toHaveAttribute(
      "href",
      `/ops/clients/${CLIENT}/agents/card-receipts`,
    );
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
    await user.type(await screen.findByTestId("new-agent-name-input"), "Material costs");
    await user.click(screen.getByTestId("new-agent-create"));
    expect(screen.getByTestId("new-agent-slug-error")).toHaveTextContent(/already has an agent/);
  });
});
