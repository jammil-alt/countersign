// A page that failed to load (ErrorNotice with a retry): a calm dead end for what isn't there, the
// way home for what isn't the person's, the red box and "Try again" for our failures, never the
// API's own words; "Report an issue" files feedback with what failed. An action's notice (no retry)
// reads as before.
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppProviders, AppRoutes } from "../App";
import { ApiError } from "../api/client";
import { CLIENT_SESSION, fakeApi } from "../test/fixtures";
import { pageResource } from "./error-pages";
import { ErrorNotice } from "./primitives";

vi.mock("../feedback/capture", async (load) => ({
  ...(await load<typeof import("../feedback/capture")>()),
  captureViewport: vi.fn(async () => null),
}));

const fail = (
  status: number,
  code: string,
  message: string,
  extra: Partial<{ badParam: boolean; request: string }> = {},
) => new ApiError({ status, code, message, route: "GET /api/x/:id", ...extra });

function show(path: string, error: unknown, onRetry: (() => void) | undefined = vi.fn()) {
  render(
    <MemoryRouter initialEntries={[path]}>
      <ErrorNotice error={error} onRetry={onRetry} />
    </MemoryRouter>,
  );
  return onRetry;
}

describe("ErrorNotice on a page's load", () => {
  it("404: a calm dead end with the way back to the list, and no Try again", () => {
    show("/runs/018f0000-0000-4000-8000-000000000001", fail(404, "not_found", "run not found"));
    const end = screen.getByTestId("error-not-found");
    expect(end).toHaveTextContent("We couldn't find this run.");
    expect(end).toHaveTextContent(
      "It may have been removed, or the link is for a different account.",
    );
    expect(within(end).getByTestId("error-back")).toHaveAttribute("href", "/runs");
    expect(end).not.toHaveTextContent("run not found");
    expect(screen.queryByText("Try again")).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("400 for the route's id: not found, never the schema's words", () => {
    show(
      "/records/123",
      fail(0, "invalid_request", "id: not an id", {
        badParam: true,
        request: "GET /api/records/123",
      }),
    );
    const end = screen.getByTestId("error-not-found");
    expect(end).toHaveTextContent("We couldn't find this record.");
    expect(end).not.toHaveTextContent("not an id");
    expect(within(end).getByTestId("error-back")).toHaveAttribute("href", "/records");
  });

  it("another client's item (tenant_forbidden): not found too", () => {
    show(
      "/ops/clients/018f0000-0000-4000-8000-0000000000aa",
      fail(403, "tenant_forbidden", "the operator does not serve that client"),
    );
    const end = screen.getByTestId("error-not-found");
    expect(end).toHaveTextContent("We couldn't find this client.");
    expect(within(end).getByTestId("error-back")).toHaveAttribute("href", "/ops/clients");
  });

  it("403 for the role: no access, the way home, no retry", () => {
    show("/ops/runs", fail(403, "forbidden", "this needs one of: operator"));
    const end = screen.getByTestId("error-forbidden");
    expect(end).toHaveTextContent("You don't have access to this page.");
    expect(end).not.toHaveTextContent("needs one of");
    expect(within(end).getByTestId("error-back")).toHaveAttribute("href", "/ops");
    expect(screen.queryByText("Try again")).toBeNull();
  });

  it.each([
    ["429", fail(429, "rate_limited", "slow down, 12 requests in 10 s")],
    ["500", fail(500, "internal", "TypeError: x is undefined at handler (app.ts:12)")],
    ["a network failure", fail(0, "network", "The API could not be reached.")],
    [
      "an answer we didn't expect",
      fail(200, "invalid_response", "✖ expected string at items.0.id"),
    ],
  ])("%s: the red box in plain words, and Try again retries", async (_, error) => {
    const retry = show("/runs", error);
    const box = screen.getByTestId("error-failure");
    expect(box).toHaveAttribute("role", "alert");
    expect(box).toHaveTextContent("Something went wrong loading this page. Try again in a moment.");
    expect(box).not.toHaveTextContent(error.message);
    await userEvent.click(within(box).getByRole("button", { name: "Try again" }));
    expect(retry).toHaveBeenCalledOnce();
  });

  it("a connection page with no connection says what is missing and links to Connectors", () => {
    show("/connections/gsheets/pick", fail(404, "not_found", "Not found."));
    const end = screen.getByTestId("error-not-found");
    expect(end).toHaveTextContent("This needs a connection you haven't made yet.");
    expect(end).toHaveTextContent("Connect it in Connectors");
    expect(within(end).getByTestId("error-back")).toHaveAttribute("href", "/connectors");
  });

  it("an action's notice (no retry) reads as before, with the API's words", () => {
    show("/runs", fail(409, "already_resolved", "Someone has already answered this."), undefined);
    expect(screen.getByRole("alert")).toHaveTextContent("Someone has already answered this.");
    expect(screen.queryByTestId("error-not-found")).toBeNull();
    expect(screen.queryByTestId("error-report")).toBeNull();
  });

  it("offers no Report an issue where feedback is off", () => {
    show("/runs/x", fail(404, "not_found", "Not found."));
    expect(screen.queryByTestId("error-report")).toBeNull();
  });
});

describe("pageResource", () => {
  it("reads the resource and its list from the address", () => {
    expect(pageResource("/documents/abc")).toMatchObject({
      kind: "document",
      back: { to: "/records" },
    });
    expect(pageResource("/sloan/123")).toMatchObject({
      kind: "conversation",
      back: { to: "/sloan" },
    });
    expect(pageResource("/agents/123/settings")).toMatchObject({
      kind: "agent",
      back: { to: "/" },
    });
    expect(pageResource("/ops/runs/x")).toMatchObject({ kind: "run", back: { to: "/ops/runs" } });
    expect(pageResource("/ops/clients/c1/records/r1")).toMatchObject({
      kind: "record",
      back: { to: "/ops/clients/c1/records" },
    });
    expect(pageResource("/ops/skills/x")).toMatchObject({ kind: "skill" });
    expect(pageResource("/nowhere")).toMatchObject({ kind: "page", back: { to: "/" } });
  });
});

describe("Report an issue, end to end in the portal", () => {
  beforeEach(() => {
    URL.createObjectURL = vi.fn(() => "blob:picture");
    URL.revokeObjectURL = vi.fn();
  });
  afterEach(() => vi.unstubAllGlobals());

  it("opens /runs/not-a-uuid as a dead end and files feedback that names what failed", async () => {
    const sent: Record<string, unknown>[] = [];
    const api = fakeApi({
      "GET /api/session": () => CLIENT_SESSION,
      "GET /api/feedback/status": () => ({ enabled: true }),
      "POST /api/feedback": ({ init }) => {
        sent.push(JSON.parse(String(init.body)));
        return { id: "00000000-0000-4000-8000-0000000fb001" };
      },
    });
    render(
      <MemoryRouter initialEntries={["/runs/not-a-uuid"]}>
        <AppProviders client={api.client}>
          <AppRoutes />
        </AppProviders>
      </MemoryRouter>,
    );
    const end = await screen.findByTestId("error-not-found", {}, { timeout: 10_000 });
    expect(end).toHaveTextContent("We couldn't find this run.");
    expect(screen.queryByText("Try again")).toBeNull();
    // No display id made up from an id that never loaded.
    expect(screen.queryByText(/R-[a-z0-9]{6}/i)).toBeNull();
    expect(screen.getByTestId("portal-run-page")).not.toHaveTextContent(/R-tauuid/i);

    await userEvent.click(await within(end).findByTestId("error-report"));
    const composer = await screen.findByTestId("feedback-composer");
    const comment = within(composer).getByTestId("feedback-comment");
    expect(comment).toHaveValue("This page didn't load.");
    await userEvent.type(comment, " From the link in my email.");
    await userEvent.click(within(composer).getByTestId("feedback-send"));

    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]).toMatchObject({
      comment: "This page didn't load. From the link in my email.",
      path: "/runs/not-a-uuid",
      source: "error_page",
      context: {
        route: "/runs/not-a-uuid",
        status: 0,
        code: "invalid_request",
        request: expect.stringContaining("not-a-uuid"),
        sentryEventId: null,
      },
    });
    expect(await screen.findByTestId("error-reported")).toHaveTextContent(
      "Thanks, we've let the team know.",
    );
    expect(screen.getByTestId("error-back")).toBeInTheDocument();
  });
});
