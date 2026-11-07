// The Feedback button in the portal and the back office: off → no button; on → pin, picture,
// comment, Send (comment first, picture after); leave the picture off; Escape sends nothing.
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppProviders, AppRoutes } from "../App";
import { CLIENT_SESSION, fakeApi, OPERATOR_SESSION } from "../test/fixtures";

vi.mock("./capture", async (load) => ({
  ...(await load<typeof import("./capture")>()),
  captureViewport: vi.fn(
    async () => new Blob([new Uint8Array([0xff, 0xd8, 0xff])], { type: "image/jpeg" }),
  ),
}));

const ID = "00000000-0000-4000-8000-0000000fb001";
const overview = {
  client: { id: "00000000-0000-4000-8000-00000000a002", name: "Demo client" },
  services: [],
  needsYou: { inbox: 0 },
  recentRuns: [],
};

function portal(enabled: boolean) {
  const sent: unknown[] = [];
  const api = fakeApi({
    "GET /api/session": () => CLIENT_SESSION,
    "GET /api/overview": () => overview,
    "GET /api/feedback/status": () => ({ enabled }),
    "POST /api/feedback": ({ init }) => {
      sent.push(JSON.parse(String(init.body)));
      return { id: ID };
    },
  });
  return { api, sent };
}

function renderAt(path: string, api: ReturnType<typeof fakeApi>) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <AppProviders client={api.client}>
        <AppRoutes />
      </AppProviders>
    </MemoryRouter>,
  );
}

const puts: { url: string; type: string | null }[] = [];
let putOk = true;
beforeEach(() => {
  puts.length = 0;
  putOk = true;
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init: RequestInit = {}) => {
    puts.push({ url: String(input), type: new Headers(init.headers).get("content-type") });
    return new Response(JSON.stringify({ ok: true, bytes: 3 }), { status: putOk ? 200 : 500 });
  });
  URL.createObjectURL = vi.fn(() => "blob:picture");
  URL.revokeObjectURL = vi.fn();
  document.elementsFromPoint = vi.fn(() => [screen.getByTestId("portal-nav-runs")]);
});
afterEach(() => vi.unstubAllGlobals());

describe("Feedback button", () => {
  it("is not in the portal when the operator has it off", async () => {
    const { api } = portal(false);
    renderAt("/", api);
    await screen.findByTestId("shell-portal");
    await waitFor(() => expect(api.calls).toContain("GET /api/feedback/status"));
    expect(screen.queryByTestId("feedback-button")).toBeNull();
  });

  it("pins, shows the picture, sends the comment then the JPEG", async () => {
    const { api, sent } = portal(true);
    // The old address redirects to the Inbox, query kept.
    renderAt("/desk?status=open", api);
    await userEvent.click(await screen.findByTestId("feedback-button"));
    await userEvent.click(screen.getByTestId("feedback-pick-area"));
    expect(await screen.findByTestId("feedback-composer")).toBeInTheDocument();
    expect(screen.getByTestId("feedback-picture-pin")).toBeInTheDocument();
    expect(screen.getByTestId("feedback-target")).toHaveTextContent(
      'link "Runs" [portal-nav-runs]',
    );
    // Send needs a comment.
    await userEvent.click(screen.getByTestId("feedback-send"));
    expect(screen.getByTestId("feedback-error")).toBeInTheDocument();
    await userEvent.type(screen.getByTestId("feedback-comment"), "Runs is hard to find");
    await userEvent.click(screen.getByTestId("feedback-send"));
    expect(await screen.findByTestId("feedback-toast")).toHaveTextContent(
      "Thanks. We got your feedback.",
    );
    expect(sent).toMatchObject([
      { comment: "Runs is hard to find", path: "/inbox?status=open", target: expect.any(String) },
    ]);
    expect(puts).toEqual([{ url: `/api/feedback/${ID}/screenshot`, type: "image/jpeg" }]);
    expect(screen.queryByTestId("feedback-composer")).toBeNull();
  });

  it("says when only the picture failed", async () => {
    putOk = false;
    const { api } = portal(true);
    renderAt("/", api);
    await userEvent.click(await screen.findByTestId("feedback-button"));
    await userEvent.click(screen.getByTestId("feedback-no-spot"));
    await userEvent.type(await screen.findByTestId("feedback-comment"), "Slow");
    await userEvent.click(screen.getByTestId("feedback-send"));
    expect(await screen.findByTestId("feedback-toast")).toHaveTextContent(
      "We saved your comment, but the picture didn't upload.",
    );
  });

  it("leaves the picture off, and skips the pin", async () => {
    const { api, sent } = portal(true);
    renderAt("/", api);
    await userEvent.click(await screen.findByTestId("feedback-button"));
    await userEvent.click(screen.getByTestId("feedback-no-spot"));
    await userEvent.click(await screen.findByTestId("feedback-leave-picture-off"));
    expect(screen.getByTestId("feedback-no-picture")).toBeInTheDocument();
    await userEvent.type(screen.getByTestId("feedback-comment"), "General thought");
    await userEvent.click(screen.getByTestId("feedback-send"));
    await screen.findByTestId("feedback-toast");
    expect(sent).toMatchObject([{ pin: null, target: null }]);
    expect(puts).toEqual([]);
  });

  it("sends nothing on Escape or Cancel", async () => {
    const { api, sent } = portal(true);
    renderAt("/", api);
    await userEvent.click(await screen.findByTestId("feedback-button"));
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByTestId("feedback-pick-area")).toBeNull();
    await userEvent.click(screen.getByTestId("feedback-button"));
    await userEvent.click(screen.getByTestId("feedback-no-spot"));
    await userEvent.click(await screen.findByTestId("feedback-cancel"));
    expect(screen.queryByTestId("feedback-composer")).toBeNull();
    expect(sent).toEqual([]);
  });

  it("is always in the back office, and sends to the ops route", async () => {
    const sent: unknown[] = [];
    const api = fakeApi({
      "GET /api/session": () => OPERATOR_SESSION,
      "GET /api/ops/clients": () => ({ clients: [] }),
      "POST /api/ops/feedback": ({ init }) => {
        sent.push(JSON.parse(String(init.body)));
        return { id: ID };
      },
    });
    document.elementsFromPoint = vi.fn(() => []);
    renderAt("/ops", api);
    await userEvent.click(await screen.findByTestId("feedback-button"));
    await userEvent.click(screen.getByTestId("feedback-no-spot"));
    await userEvent.type(await screen.findByTestId("feedback-comment"), "Ops idea");
    await userEvent.click(screen.getByTestId("feedback-send"));
    await screen.findByTestId("feedback-toast");
    expect(sent).toMatchObject([{ comment: "Ops idea", path: "/ops" }]);
    expect(puts).toEqual([{ url: `/api/ops/feedback/${ID}/screenshot`, type: "image/jpeg" }]);
  });
});
