// The merge view: a template update with a conflict (marked on the step list and in the fields
// table, Save held until it is resolved, the resolution sent), and a promotion with one change
// left unpicked (only the picked change is sent; client-specific values are listed as staying).
import {
  AgentBundle,
  type AgentBundleInput,
  type BuilderCatalog,
  cloneJson,
  toProcessBundle,
} from "@countersign/core";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { describe, expect, it } from "vitest";
import type { VersionDetail } from "../../api/routes";
import { ApiProvider } from "../../api/useApi";
import { AGENT_SUMMARY, fakeApi, Reply } from "../../test/fixtures";
import { MergeScreen } from "./MergeScreen";

const ID = AGENT_SUMMARY.id;
const TEMPLATE_ID = "00000000-0000-4000-8000-00000000f001";
const AGENT = { ...AGENT_SUMMARY, templateId: TEMPLATE_ID, bindings: {} };
const TEMPLATE = {
  ...AGENT_SUMMARY,
  id: TEMPLATE_ID,
  tenantId: null,
  kind: "template" as const,
  slug: "clerk",
  name: "Clerk",
  templateId: null,
  bindings: {},
  serviceName: null,
};
const CATALOG: BuilderCatalog = { skills: [], tools: [], connectors: [], automations: [] };

const BASE_INPUT: AgentBundleInput = {
  schemaVersion: 1,
  definition: {
    schemaVersion: 2,
    identity: { name: "Clerk", role: "Clerk", mission: "Keep records" },
    kind: "functional",
    model: { id: "claude-opus-5-5" },
    instructions: "The original way.",
    skills: [],
  },
  workflows: [
    {
      slug: "main",
      name: "Main",
      workflow: {
        schemaVersion: 3,
        trigger: { id: "t1", on: { type: "manual", input: { type: "object" } } },
        steps: [
          {
            id: "ask",
            kind: "person",
            name: "Ask the client",
            mode: "approve",
            assignee: "client_admin",
            title: "Is it right?",
            timeout: "1 day",
            onTimeout: "stop",
          },
          { id: "tell", kind: "notify", name: "Tell the team", channel: "thread", message: "Done" },
        ],
      },
    },
  ],
};
const BASE = AgentBundle.parse(BASE_INPUT);

function edit(fn: (b: AgentBundle) => void): AgentBundle {
  const b = cloneJson(BASE);
  fn(b);
  return b;
}

function detail(id: string, agentId: string, n: number, bundle: AgentBundle): VersionDetail {
  return {
    id,
    agentId,
    version: n,
    status: "live",
    bundleHash: `h${n}`,
    changeNote: null,
    releaseNote: null,
    authorType: "operator",
    authorId: null,
    parentVersionId: null,
    basedOnTemplateVersionId: null,
    mergedFromVersionIds: null,
    createdAt: "2026-11-04T00:00:00.000Z",
    bundle,
  };
}

const vid = (n: number) => `00000000-0000-4000-8000-0000000f${String(n).padStart(4, "0")}`;

const CLIENT = edit((b) => {
  b.definition.instructions = "The client's way.";
  const ask = b.workflows[0]?.workflow.steps[0];
  if (ask) ask.name = "Ask Jammil";
});
const TEMPLATE_V2 = edit((b) => {
  b.definition.instructions = "The template's new way.";
  b.workflows[0]?.workflow.steps.push({ id: "pause", kind: "wait", name: "Pause", for: "1 hour" });
});

function setup(mode: "update" | "promote", routes: Parameters<typeof fakeApi>[0]) {
  const api = fakeApi({
    [`GET /api/ops/agents/${ID}`]: () => ({
      agent: AGENT,
      versions: [],
      live: null,
      latest: null,
      update: null,
    }),
    [`GET /api/ops/agents/${ID}/builder-catalog`]: () => CATALOG,
    [`GET /api/ops/agents/${TEMPLATE_ID}/builder-catalog`]: () => CATALOG,
    "GET /api/ops/catalog/events": () => ({ events: [] }),
    ...routes,
  });
  render(
    <MemoryRouter initialEntries={[`/ops/agents/${ID}/merge?mode=${mode}`]}>
      <ApiProvider client={api.client}>
        <Routes>
          <Route path="/ops/agents/:id/merge" element={<MergeScreen />} />
        </Routes>
      </ApiProvider>
    </MemoryRouter>,
  );
  return api;
}

describe("merge view: template update", () => {
  const preview = {
    template: TEMPLATE,
    base: detail(vid(1), TEMPLATE_ID, 1, BASE),
    ours: detail(vid(11), ID, 2, CLIENT),
    theirs: { ...detail(vid(2), TEMPLATE_ID, 2, TEMPLATE_V2), releaseNote: "A pause" },
    conflicts: [
      {
        path: "bundle#/definition/instructions",
        kind: "field",
        entity: "bundle",
        base: "The original way.",
        ours: "The client's way.",
        theirs: "The template's new way.",
      },
    ],
    labels: { "step:ask": "Ask Jammil", "step:pause": "Pause", "step:tell": "Tell the team" },
  };

  it("marks each side's steps, holds Save until the conflict is resolved, then sends it", async () => {
    const sent: unknown[] = [];
    setup("update", {
      [`GET /api/ops/agents/${ID}/update-preview`]: () => preview,
      [`POST /api/ops/agents/${ID}/update`]: ({ init }) => {
        sent.push(JSON.parse(String(init.body)));
        return { version: { ...preview.ours, id: vid(12), version: 3, status: "draft" } };
      },
    });
    await screen.findByTestId("merge-view");
    expect(screen.getByText("Release note: A pause")).toBeTruthy();
    expect(screen.getByTestId("merge-open-conflicts").textContent).toBe("1 conflict to resolve");
    expect(screen.getByTestId("step-ask-marks").textContent).toContain("This client: changed");
    expect(screen.getByTestId("step-pause-marks").textContent).toContain("Template update: added");
    const row = screen.getByTestId("merge-field-bundle#/definition/instructions");
    expect(row.textContent).toContain("Conflict");
    expect(row.textContent).toContain("Waiting on you");
    const save = screen.getByTestId("merge-save-button") as HTMLButtonElement;
    expect(save.disabled).toBe(true);

    // Edit a value of its own, then settle on the client's.
    await userEvent.click(screen.getByTestId("merge-conflict-0-edit"));
    const box = screen.getByTestId("merge-conflict-0-value");
    await userEvent.clear(box);
    await userEvent.type(box, "Both ways.");
    expect(row.textContent).toContain("Both ways.");
    await userEvent.click(screen.getByTestId("merge-conflict-0-ours"));
    expect(row.textContent).toContain("The client's way.");
    expect(screen.getByTestId("merge-valid")).toBeTruthy();
    expect(save.disabled).toBe(false);
    await userEvent.click(save);

    await screen.findByTestId("merge-saved");
    expect(sent).toEqual([
      { resolutions: [{ path: "bundle#/definition/instructions", choice: "ours" }] },
    ]);
    expect(
      (screen.getByTestId("merge-open-versions") as HTMLAnchorElement).getAttribute("href"),
    ).toBe(`/ops/clients/${AGENT.tenantId}/agents/${AGENT.slug}/versions`);
  });

  it("shows the server's refusal when there is nothing to update", async () => {
    setup("update", {
      [`GET /api/ops/agents/${ID}/update-preview`]: () =>
        new Reply(409, { error: { code: "no_update", message: "material-costs is up to date" } }),
    });
    expect(await screen.findByText(/up to date/)).toBeTruthy();
  });
});

// R8 (ARCHITECTURE §10.14 "v3 compatibility"): the client's version saved as v4, the template's
// update still v3. Every side reads as v4 in the browser; checks, deadlines and triggers read in
// words, and the conflict sits on the v4 deadline's path.
describe("merge view: v4 process and a v3 template update", () => {
  const lookup = { wrappedTool: () => null, sideEffect: () => null };
  const CLIENT_V4 = (() => {
    const b = toProcessBundle(CLIENT, lookup);
    const p = b.workflows[0]?.workflow;
    if (p?.schemaVersion !== 4) throw new Error("fixture");
    p.triggers.push({ id: "t2", on: { type: "manual", input: { type: "object" } } });
    const ask = p.steps[0];
    if (ask?.kind !== "person") throw new Error("fixture");
    ask.deadline = { ...ask.deadline, after: "2 days", hours: "business" };
    const tell = p.steps[1];
    if (tell) {
      tell.checks = {
        approval: {
          required: "required",
          mode: "any",
          approvers: [{ who: "client_admin" }, { who: "lead" }],
          ifNoAnswer: "stop",
          onReject: "stop",
        },
      };
    }
    return b;
  })();
  const TEMPLATE_V3 = edit((b) => {
    const ask = b.workflows[0]?.workflow.steps[0];
    if (ask?.kind === "person") ask.timeout = "3 days";
  });

  it("merges into one v4 process, words the conflict and sends its resolution", async () => {
    const sent: unknown[] = [];
    setup("update", {
      [`GET /api/ops/agents/${ID}/update-preview`]: () => ({
        template: TEMPLATE,
        base: detail(vid(1), TEMPLATE_ID, 1, BASE),
        ours: detail(vid(11), ID, 2, CLIENT_V4 as unknown as AgentBundle),
        theirs: detail(vid(2), TEMPLATE_ID, 2, TEMPLATE_V3),
        conflicts: [],
        labels: { "step:ask": "Ask Jammil", "step:tell": "Tell the team" },
      }),
      [`POST /api/ops/agents/${ID}/update`]: ({ init }) => {
        sent.push(JSON.parse(String(init.body)));
        return { version: { ...detail(vid(12), ID, 3, BASE), status: "draft", bundle: undefined } };
      },
    });
    await screen.findByTestId("merge-view");
    // The process's second trigger reads as "or", with the client's mark.
    expect(screen.getByTestId("step-t2").textContent).toContain("Started by hand");
    expect(screen.getByTestId("step-t2-marks").textContent).toContain("This client: changed");
    // The step's approval reads in words.
    expect(screen.getByTestId("step-tell-checks").textContent).toBe(
      "Approval: client admin, the client's lead, any one of them · if nobody answers, it stops",
    );
    // The deadline both sides changed is the conflict, in words.
    const row = screen.getByTestId("merge-conflict-0");
    expect(row.textContent).toContain("Step “Ask Jammil”: deadline: time to answer");
    expect(row.textContent).toContain("2 days");
    expect(row.textContent).toContain("3 days");
    await userEvent.click(screen.getByTestId("merge-conflict-0-theirs"));
    expect(screen.getByTestId("step-ask").textContent).toContain("3 days in business hours");
    const save = screen.getByTestId("merge-save-button") as HTMLButtonElement;
    await waitFor(() => expect(save.disabled).toBe(false));
    await userEvent.click(save);
    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]).toEqual({
      resolutions: [{ path: "step:ask#/deadline/after", choice: "theirs" }],
    });
  });
});

describe("merge view: promotion", () => {
  const STRIPPED = edit((b) => {
    b.definition.instructions = "The client's way.";
    b.workflows[0]?.workflow.steps.push({
      id: "pause",
      kind: "wait",
      name: "Pause",
      for: "1 hour",
    });
  });

  it("sends only the picked changes and lists what stays with the client", async () => {
    const sent: unknown[] = [];
    setup("promote", {
      [`GET /api/ops/agents/${ID}/promote-preview`]: () => ({
        template: TEMPLATE,
        client: detail(vid(11), ID, 2, CLIENT),
        base: detail(vid(1), TEMPLATE_ID, 1, BASE),
        ours: detail(vid(1), TEMPLATE_ID, 1, BASE),
        theirs: detail(vid(11), ID, 2, STRIPPED),
        conflicts: [],
        leftOut: [
          {
            kind: "changed",
            entity: "step:ask",
            path: "step:ask#/input/id",
            after: "a client's record",
          },
        ],
        labels: { "step:ask": "Ask the client", "step:pause": "Pause" },
      }),
      [`POST /api/ops/agents/${ID}/promote`]: ({ init }) => {
        sent.push(JSON.parse(String(init.body)));
        return {
          template: TEMPLATE,
          version: { ...detail(vid(3), TEMPLATE_ID, 2, BASE), status: "draft", bundle: undefined },
        };
      },
    });
    const picks = await screen.findByTestId("merge-promote-changes");
    expect(within(picks).getByText("Instructions changed")).toBeTruthy();
    expect(within(picks).getByText(/Added wait “Pause”/)).toBeTruthy();
    expect(screen.getByTestId("merge-left-out").textContent).toContain("a client's record");

    // Leave the instructions behind: the merged fields table follows.
    await userEvent.click(screen.getByTestId("merge-promote-0"));
    expect(screen.queryByTestId("merge-field-bundle#/definition/instructions")).toBeNull();
    expect(screen.getByTestId("step-pause-marks").textContent).toContain("Client's changes: added");

    await userEvent.type(screen.getByTestId("merge-release-note"), "A pause");
    await userEvent.click(screen.getByTestId("merge-save-button"));
    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]).toEqual({
      versionId: vid(11),
      changes: ["step:pause"],
      resolutions: [],
      releaseNote: "A pause",
    });
    expect((await screen.findByTestId("merge-saved")).textContent).toContain("template “Clerk”");
  });
});
