// Agent assurance on screen (docs/agent-assurance-plan.md §5): the SOP's section 14 for the client,
// with a check in review shown only as "In review since", and the back office's Security tab with
// each check's evidence, its issue and "Run the checks now".

import type { AssuranceView } from "@countersign/core";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { AppProviders } from "../App";
import { SecurityTab } from "../ops/agents/SecurityTab";
import { fakeApi } from "../test/fixtures";
import { layoutArchitecture, wrap } from "./ArchitectureDiagram";
import { AssuranceBody } from "./AssuranceView";

const AGENT = "00000000-0000-4000-8000-00000000c501";

const check = (
  over: Partial<AssuranceView["checks"][number]> & { id: string; number: string; name: string },
): AssuranceView["checks"][number] => ({
  kind: "setup",
  controls: ["AGT-1"],
  soc2: ["CC8.1", "PI1.3"],
  hipaa: [],
  result: "verified",
  found: "",
  since: null,
  checkedAt: "2026-11-21T08:23:00.000Z",
  ...over,
});

function view(audience: "client" | "ops"): AssuranceView {
  const ops = audience === "ops";
  return {
    agent: { id: AGENT, name: "Bills in" },
    client: "Harbor Millwork",
    asOf: "2026-11-21T09:00:00.000Z",
    period: { start: "2026-10-22T00:00:00.000Z", end: "2026-11-21T00:00:00.000Z" },
    hipaa: false,
    version: 7,
    architecture: {
      zones: [
        { key: "business", title: "Your business" },
        { key: "mezonas", title: "Mezonas" },
        { key: "ai", title: "AI providers" },
      ],
      boxes: [
        {
          key: "system:qbo",
          zone: "business",
          title: "QuickBooks Online",
          lines: ["Read on its own · Delete off"],
          person: false,
        },
        {
          key: "business:people",
          zone: "business",
          title: "Your people",
          lines: ["Ben Ortiz approves"],
          person: true,
        },
        {
          key: "mezonas:run",
          zone: "mezonas",
          title: "The run",
          lines: ["The permission gate decides every call to your tools"],
          person: false,
        },
        {
          key: "ai:anthropic",
          zone: "ai",
          title: "Anthropic",
          lines: ["Claude Sonnet 5.5 (step 1)"],
          person: false,
        },
      ],
      flows: [
        {
          from: "mezonas:run",
          to: "system:qbo",
          label: "read, create",
          refs: ["C1", "AGT-1"],
          ai: false,
        },
        {
          from: "mezonas:run",
          to: "ai:anthropic",
          label: "your documents' text, as data",
          refs: ["VEN-1"],
          ai: true,
        },
      ],
    },
    counts: { checks: 3, verified: 1, inReview: 1, notChecked: 1, notApplicable: 0 },
    lastChecked: "2026-11-21T08:23:00.000Z",
    checks: [
      check({
        id: "delete_off",
        number: "K1",
        name: "Delete is off",
        found: "Off on QuickBooks Online",
        ...(ops ? { evidence: { open: [] }, issueId: null } : {}),
      }),
      check({
        id: "providers_listed",
        number: "K2",
        name: "AI providers listed and allowed for you",
        kind: "runs",
        result: "in_review",
        found: ops ? "No BAA yet with OpenAI" : "",
        since: "2026-11-20T08:23:00.000Z",
        ...(ops
          ? { evidence: { uncovered: ["openai"] }, issueId: "00000000-0000-4000-8000-0000000000e1" }
          : {}),
      }),
      check({
        id: "untrusted_text",
        number: "K3",
        name: "Text from documents and emails stays data",
        kind: "attack",
        result: "not_checked",
        found: "Comes with the attack runs",
        checkedAt: null,
      }),
    ],
    coverage: [
      {
        id: "AGT-1",
        title: "Approval before an agent changes a client's tools",
        state: "checked",
        status: "in_place",
        why: null,
        soc2: ["CC8.1"],
        hipaa: [],
      },
      {
        id: "LOG-3",
        title: "Clients see their own audit log",
        state: "inherited",
        status: "planned",
        why: null,
        soc2: ["CC2.3"],
        hipaa: [],
      },
      {
        id: "DAT-5",
        title: "Card numbers are never stored",
        state: "not_applicable",
        status: "in_place",
        why: "It takes no card payments",
        soc2: [],
        hipaa: [],
      },
    ],
    data: [
      {
        data: "Bills",
        fields: null,
        from: "QuickBooks Online",
        keptWhere: "Your records",
        keptFor: "While you're a client",
        whoSees: "Your team",
        gap: false,
      },
    ],
    ai: [
      {
        use: "Step 1, Read the bill",
        provider: "Anthropic",
        model: "Claude Sonnet 5.5",
        sent: "The step's input, as data",
        protection: "TLS 1.2 or later; no training",
        providerKeeps: "Not recorded yet",
      },
    ],
    access: [
      {
        tool: "QuickBooks Online",
        detail: "Connected by Ada Ruiz",
        signsIn: "OAuth: you signed in to it for us",
        credential: "In the vault, encrypted with your key",
        agentMay: "Read on its own",
        whoChanges: "Your admins",
        person: false,
      },
    ],
  };
}

function mount(node: React.ReactNode, routes: Parameters<typeof fakeApi>[0] = {}) {
  const api = fakeApi(routes);
  render(
    <MemoryRouter>
      <AppProviders client={api.client}>{node}</AppProviders>
    </MemoryRouter>,
  );
  return api;
}

describe("section 14, architecture and security", () => {
  it("shows the client each result, a check in review only since when, and the standards it answers", async () => {
    mount(<AssuranceBody view={view("client")} audience="client" />);
    const checks = await screen.findByTestId("assurance-checks");
    const review = within(checks)
      .getByText("AI providers listed and allowed for you")
      .closest("tr");
    expect(review).toHaveTextContent("In review");
    expect(review).toHaveTextContent(/In review since/);
    expect(review).not.toHaveTextContent("No BAA yet");
    expect(checks).toHaveTextContent("SOC 2 CC8.1, PI1.3");
    expect(checks).toHaveTextContent("Not yet checked");
    expect(screen.getByTestId("assurance")).not.toHaveTextContent(/failed/i);
    expect(screen.queryByText("Open the issue")).toBeNull();
    expect(screen.getByTestId("assurance-coverage")).toHaveTextContent("LOG-3");
    expect(screen.getByTestId("assurance-coverage")).toHaveTextContent("Planned");
    expect(screen.getByTestId("arch-diagram")).toHaveTextContent("QuickBooks Online");
  });

  it("lays boxes out in their zones, and wraps long lines", () => {
    const { placed } = layoutArchitecture(view("client").architecture);
    const run = placed.find((p) => p.key === "mezonas:run");
    const qbo = placed.find((p) => p.key === "system:qbo");
    expect(run && qbo && run.x > qbo.x).toBe(true);
    expect(placed.find((p) => p.key === "business:people")?.y).toBeGreaterThan(qbo?.y ?? 0);
    expect(wrap("The permission gate decides every call to your tools", 20)).toEqual([
      "The permission gate",
      "decides every call",
      "to your tools",
    ]);
  });
});

describe("the back office's Security tab", () => {
  it("shows each check's evidence and issue, and runs the checks on asking", async () => {
    let ran = 0;
    const api = mount(<SecurityTab agentId={AGENT} />, {
      [`GET /api/ops/agents/${AGENT}/assurance`]: () => view("ops"),
      [`POST /api/ops/agents/${AGENT}/assurance/run`]: () => {
        ran += 1;
        return view("ops");
      },
    });
    const checks = await screen.findByTestId("assurance-checks");
    const review = within(checks)
      .getByText("AI providers listed and allowed for you")
      .closest("tr");
    expect(review).toHaveTextContent("No BAA yet with OpenAI");
    expect(review).toHaveTextContent("uncovered: openai");
    expect(
      within(review as HTMLElement).getByRole("link", { name: "Open the issue" }),
    ).toHaveAttribute("href", "/ops/issues/00000000-0000-4000-8000-0000000000e1");
    await userEvent.click(screen.getByTestId("assurance-run"));
    await screen.findByTestId("assurance-checks");
    expect(ran).toBe(1);
    expect(
      api.calls.filter((c) => c === `GET /api/ops/agents/${AGENT}/assurance`).length,
    ).toBeGreaterThan(1);
  });
});
