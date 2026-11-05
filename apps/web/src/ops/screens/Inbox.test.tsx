// The back-office inbox: the operator resolves what the server marks as theirs
// (`resolvableByOperator`), which in the Sandbox is every item; elsewhere a client's own items only
// say who they wait on.
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { AppProviders, AppRoutes } from "../../App";
import { fakeApi, OPERATOR_SESSION } from "../../test/fixtures";

const SANDBOX = "00000000-0000-4000-8000-00000000a001";
const DEMO = "00000000-0000-4000-8000-00000000a002";
const SANDBOX_ITEM = "00000000-0000-4000-8000-0000000f3101";
const DEMO_ITEM = "00000000-0000-4000-8000-0000000f3102";

const item = (id: string, tenantId: string, resolvableByOperator: boolean) => ({
  id,
  tenantId,
  kind: "approval",
  agentId: null,
  runId: null,
  subjectType: null,
  subjectId: null,
  assigneeRole: "client_admin",
  assigneeUserId: null,
  title: "Is the record right now?",
  payload: {},
  status: "open",
  resolution: null,
  resolvedBy: null,
  dueAt: null,
  createdAt: "2026-11-05T10:00:00.000Z",
  resolvedAt: null,
  resolvableByOperator,
});

describe("back-office inbox", () => {
  it("lets the operator answer the Sandbox's client-admin items, not a real client's", async () => {
    const resolved: unknown[] = [];
    const api = fakeApi({
      "GET /api/session": () => OPERATOR_SESSION,
      "GET /api/ops/inbox": () => ({
        items: [item(SANDBOX_ITEM, SANDBOX, true), item(DEMO_ITEM, DEMO, false)],
        agents: [],
      }),
      [`POST /api/ops/inbox/${SANDBOX_ITEM}/resolve`]: ({ init }) => {
        resolved.push(JSON.parse(String(init.body)));
        return { item: { ...item(SANDBOX_ITEM, SANDBOX, true), status: "resolved" } };
      },
    });
    render(
      <MemoryRouter initialEntries={["/ops/inbox"]}>
        <AppProviders client={api.client}>
          <AppRoutes />
        </AppProviders>
      </MemoryRouter>,
    );

    const sandbox = await screen.findByTestId(`inbox-item-${SANDBOX_ITEM}`);
    const demo = screen.getByTestId(`inbox-item-${DEMO_ITEM}`);
    expect(within(demo).queryByTestId("inbox-item-approve")).toBeNull();
    expect(demo).toHaveTextContent("Waiting on the client admin. Only they can answer it.");
    expect(sandbox).not.toHaveTextContent("Waiting on");
    await userEvent.click(within(sandbox).getByTestId("inbox-item-approve"));
    expect(resolved).toEqual([{ decision: "approve" }]);
  });
});
