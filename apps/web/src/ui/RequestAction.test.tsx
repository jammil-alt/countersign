// Request an action (docs/step-model-plan.md §10c): in the back office the answer names the request;
// for a client it says only that we have it, and never the words connector or queue.
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { AppProviders } from "../App";
import { fakeApi } from "../test/fixtures";
import { RequestAction } from "./RequestAction";

function show(api: ReturnType<typeof fakeApi>, as: "operator" | "client") {
  return render(
    <MemoryRouter>
      <AppProviders client={api.client}>
        <RequestAction as={as} agentId="00000000-0000-4000-8000-0000000000a1" />
      </AppProviders>
    </MemoryRouter>,
  );
}

describe("RequestAction", () => {
  it("from the back office sends the words with the agent, then names the request already open", async () => {
    const asks: unknown[] = [];
    const api = fakeApi({
      "POST /api/ops/action-requests": ({ init }) => {
        asks.push(JSON.parse(String(init.body)));
        return { ref: null, duplicate: { ref: "DQ-009", title: "Action asked for: X" } };
      },
    });
    show(api, "operator");
    await userEvent.click(screen.getByTestId("request-action-open"));
    await userEvent.type(screen.getByTestId("request-action-text"), "Attach a PDF to a bill.");
    await userEvent.click(screen.getByTestId("request-action-send"));
    expect(await screen.findByTestId("request-action-done")).toHaveTextContent(
      "Someone already asked for this: DQ-009.",
    );
    expect(asks).toEqual([
      { what: "Attach a PDF to a bill.", agentId: "00000000-0000-4000-8000-0000000000a1" },
    ]);
  });

  it("from a client says only that we have it", async () => {
    const asks: unknown[] = [];
    const api = fakeApi({
      "POST /api/action-requests": ({ init }) => {
        asks.push(JSON.parse(String(init.body)));
        return { received: true };
      },
    });
    show(api, "client");
    await userEvent.click(screen.getByTestId("request-action-open"));
    const send = screen.getByTestId("request-action-send");
    expect(send).toBeDisabled();
    await userEvent.type(
      screen.getByTestId("request-action-text"),
      "Send me a text when a bill is late.",
    );
    await userEvent.click(send);
    const done = await screen.findByTestId("request-action-done");
    expect(done).toHaveTextContent("We have it");
    expect(done.textContent).not.toMatch(/DQ-|connector|queue/i);
    await waitFor(() => expect(asks).toEqual([{ what: "Send me a text when a bill is late." }]));
  });

  it("closes without sending on Cancel", async () => {
    const api = fakeApi({});
    show(api, "client");
    await userEvent.click(screen.getByTestId("request-action-open"));
    await userEvent.type(screen.getByTestId("request-action-text"), "Something we need done.");
    await userEvent.click(screen.getByTestId("request-action-cancel"));
    expect(screen.queryByTestId("request-action-text")).toBeNull();
    expect(screen.getByTestId("request-action-open")).toBeInTheDocument();
  });
});
