// The skills library: grouped by category with in → out and used-by; a new skill is sent as an
// agent-mode `custom:` definition, shared or for one client; a draft version publishes.
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { ApiProvider } from "../../api/useApi";
import { SessionProvider, useSessionState } from "../../session/session";
import { fakeApi, OPERATOR_SESSION } from "../../test/fixtures";
import { NewSkillScreen, SkillPage, SkillsScreen } from "./SkillScreens";

const SKILL_ID = "00000000-0000-4000-8000-00000000a001";
const DEFINITION = {
  schemaVersion: 1,
  id: "custom:summarize",
  name: "Summarize records",
  description: "Writes a short summary",
  category: "writing",
  mode: "agent",
  instructions: "Summarize.",
  tools: ["testkit.record.query"],
  input: { type: "object", properties: { about: { type: "string" } } },
  output: { type: "object", properties: { summary: { type: "string" } }, required: ["summary"] },
  settings: [],
  requiresConnectors: ["testkit"],
  requiresPacks: [],
  producesAlerts: false,
};
const ITEM = {
  id: SKILL_ID,
  ref: "custom:summarize",
  name: "Summarize records",
  description: "Writes a short summary",
  category: "writing",
  source: "shared",
  clientId: null,
  clientName: null,
  status: "active",
  liveVersion: null,
  latestVersion: 1,
  latestStatus: "draft",
  inputs: ["about"],
  outputs: ["summary"],
  tools: ["testkit.record.query"],
  connectors: ["testkit"],
  usedBy: 2,
};
const LIBRARY = {
  skills: [ITEM],
  tools: [
    {
      id: "testkit.record.query",
      description: "Find records",
      input: {},
      output: {},
      sideEffect: "none",
      verb: "read",
      source: "testkit",
      connector: "testkit",
    },
  ],
  connectors: [{ id: "testkit", name: "Testkit" }],
};
const VERSION = {
  id: "00000000-0000-4000-8000-00000000b001",
  version: 1,
  status: "draft",
  definition: DEFINITION,
  changeNote: "Created",
  authorId: null,
  parentVersionId: null,
  createdAt: "2026-11-04T00:00:00.000Z",
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
              <Route path="/ops/skills" element={<SkillsScreen />} />
              <Route path="/ops/skills/new" element={<NewSkillScreen />} />
              <Route path="/ops/skills/:id" element={<SkillPage />} />
            </Routes>
          </SignedIn>
        </SessionProvider>
      </ApiProvider>
    </MemoryRouter>,
  );
  return { api, user: userEvent.setup() };
}

describe("skills library", () => {
  it("lists skills by category with in → out, tools and used by", async () => {
    renderAt("/ops/skills", { "GET /api/ops/skills": () => LIBRARY });
    const row = await screen.findByTestId("skills-row-custom:summarize");
    expect(within(row).getByText("about → summary")).toBeInTheDocument();
    expect(within(row).getByText("Testkit")).toBeInTheDocument();
    expect(within(row).getByText("Draft · v1")).toBeInTheDocument();
    expect(within(row).getByText("2")).toBeInTheDocument();
    expect(screen.getByTestId("skills-tab-writing")).toHaveTextContent("Writing1");
  });

  it("creates a shared skill as an agent-mode custom definition", async () => {
    const sent: { definition: Record<string, unknown>; clientId?: string }[] = [];
    const { user } = renderAt("/ops/skills/new", {
      "GET /api/ops/skills": () => LIBRARY,
      "POST /api/ops/skills": ({ init }) => {
        sent.push(JSON.parse(String(init.body)));
        return { skill: ITEM, version: VERSION };
      },
      [`GET /api/ops/skills/${SKILL_ID}`]: () => ({ skill: ITEM, versions: [VERSION], usedBy: [] }),
      "GET /api/ops/templates": () => ({ templates: [] }),
    });
    await user.click(await screen.findByTestId("skill-create"));
    expect(sent).toEqual([]);
    await user.type(screen.getByTestId("skill-name-input"), "Summarize records");
    expect(screen.getByTestId("skill-slug-input")).toHaveValue("summarize-records");
    await user.type(screen.getByTestId("skill-description-input"), "Writes a short summary");
    await user.type(screen.getByTestId("skill-instructions-input"), "Summarize.");
    await user.click(screen.getByTestId("skill-tool-testkit.record.query"));
    await user.click(screen.getByTestId("skill-create"));
    expect(await screen.findByTestId("skill-versions")).toBeInTheDocument();
    expect(sent[0]?.clientId).toBeUndefined();
    expect(sent[0]?.definition).toMatchObject({
      id: "custom:summarize-records",
      mode: "agent",
      tools: ["testkit.record.query"],
      requiresConnectors: ["testkit"],
      output: { type: "object", properties: { summary: { type: "string" } } },
    });
  });

  it("publishes a draft version", async () => {
    const published: string[] = [];
    const { user } = renderAt(`/ops/skills/${SKILL_ID}`, {
      "GET /api/ops/skills": () => LIBRARY,
      [`GET /api/ops/skills/${SKILL_ID}`]: () => ({ skill: ITEM, versions: [VERSION], usedBy: [] }),
      [`POST /api/ops/skills/${SKILL_ID}/versions/${VERSION.id}/publish`]: ({ url }) => {
        published.push(url.pathname);
        return { version: { ...VERSION, status: "live" } };
      },
      "GET /api/ops/templates": () => ({ templates: [] }),
    });
    await user.click(await screen.findByTestId("skill-publish-1"));
    expect(await screen.findByTestId("skill-message")).toHaveTextContent("v1 is live.");
    expect(published).toHaveLength(1);
  });
});
