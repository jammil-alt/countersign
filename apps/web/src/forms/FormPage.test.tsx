// `/f/:token` (docs/plan.md §1.121): a "Request info" form, with no sign-in. The person answers in
// their own language, is told what is needed before sending, sees the server's problems by
// question, saves to finish later, reviews and sends once; a closed or unknown link says so.
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { AppProviders, AppRoutes } from "../App";
import { fakeApi, Reply } from "../test/fixtures";

const TOKEN = "eyJ0IjoiYSJ9.c2lnbmF0dXJl";

const page = (over: Record<string, unknown> = {}) => ({
  client: "Rivera Supply",
  name: "Ray Vendor",
  title: "Invoice 1042: two details",
  intro: "We have your invoice 1042 for $3,180.00.",
  purpose: "Invoice 1042 has no PO number and its freight looks high",
  questions: [
    { id: "po_number", label: "Which PO is invoice 1042 for?", type: "text", required: true },
    {
      id: "reason",
      label: "Why is the freight higher?",
      type: "choice",
      required: false,
      other: true,
      options: [
        { id: "rush", label: "Rush delivery" },
        { id: "fuel", label: "Fuel surcharge" },
      ],
    },
    { id: "repeat", label: "Will it happen again?", type: "yes_no", required: false },
  ],
  answers: {},
  state: "open",
  dueAt: "2026-11-21T17:00:00.000Z",
  submittedAt: null,
  language: "en",
  ...over,
});

const signedOut = () => new Reply(401, { error: { code: "unauthenticated" } });

function renderAt(path: string, api: ReturnType<typeof fakeApi>) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <AppProviders client={api.client}>
        <AppRoutes />
      </AppProviders>
    </MemoryRouter>,
  );
}

describe("the form page", () => {
  it("shows the form with no sign-in, asks for what's needed, then reviews and sends", async () => {
    const sent: unknown[] = [];
    const api = fakeApi({
      "GET /api/session": signedOut,
      [`GET /api/forms/${TOKEN}`]: () => page(),
      [`POST /api/forms/${TOKEN}`]: ({ init }) => {
        sent.push(JSON.parse(String(init.body)));
        return { state: "submitted", submittedAt: "2026-11-17T10:00:00.000Z" };
      },
    });
    renderAt(`/f/${TOKEN}`, api);
    expect(await screen.findByTestId("form-title")).toHaveTextContent("Invoice 1042: two details");
    expect(screen.queryByTestId("signin-frame")).toBeNull();
    expect(screen.getByText("Asked by Rivera Supply")).toBeTruthy();
    expect(screen.getByText("Please answer by November 21, 2026")).toBeTruthy();

    // Reviewing without the PO number says it's needed, next to the question.
    await userEvent.click(screen.getByTestId("form-review-button"));
    expect(await screen.findByTestId("form-q-po_number-error")).toHaveTextContent(
      "This one is needed",
    );
    await userEvent.type(screen.getByTestId("form-q-po_number"), "PO-7781");
    await userEvent.click(screen.getByText("Other"));
    await userEvent.type(screen.getByPlaceholderText("In your words"), "Weekend delivery");
    await userEvent.click(screen.getByText("No"));
    await userEvent.click(screen.getByTestId("form-review-button"));
    const review = await screen.findByTestId("form-review");
    expect(review).toHaveTextContent("PO-7781");
    expect(review).toHaveTextContent("Other: Weekend delivery");
    await userEvent.click(screen.getByTestId("form-send"));
    expect(await screen.findByTestId("form-thanks")).toHaveTextContent(
      "Your answers went to Rivera Supply.",
    );
    expect(sent).toEqual([
      { answers: { po_number: "PO-7781", reason: { other: "Weekend delivery" }, repeat: false } },
    ]);
  });

  it("saves a draft, and shows the server's problems by question", async () => {
    const api = fakeApi({
      "GET /api/session": signedOut,
      [`GET /api/forms/${TOKEN}`]: () => page({ answers: { po_number: "PO-1" } }),
      [`PUT /api/forms/${TOKEN}/draft`]: () => ({ savedAt: "2026-11-17T10:00:00.000Z" }),
      [`POST /api/forms/${TOKEN}`]: () =>
        new Reply(422, {
          error: {
            code: "invalid_answers",
            message: "Some answers need a look.",
            details: { problems: [{ question: "po_number", message: "a number, like 1250.50" }] },
          },
        }),
    });
    renderAt(`/f/${TOKEN}`, api);
    expect(await screen.findByTestId("form-q-po_number")).toHaveValue("PO-1");
    await userEvent.click(screen.getByTestId("form-save"));
    expect(await screen.findByTestId("form-saved")).toHaveTextContent("Saved.");
    await userEvent.click(screen.getByTestId("form-review-button"));
    await userEvent.click(await screen.findByTestId("form-send"));
    expect(await screen.findByTestId("form-q-po_number-error")).toHaveTextContent(
      "a number, like 1250.50",
    );
  });

  it("reads in the person's language", async () => {
    const api = fakeApi({
      "GET /api/session": signedOut,
      [`GET /api/forms/${TOKEN}`]: () => page({ language: "es" }),
    });
    renderAt(`/f/${TOKEN}`, api);
    expect(await screen.findByText("Lo pide Rivera Supply")).toBeTruthy();
    expect(screen.getByTestId("form-review-button")).toHaveTextContent("Revisar respuestas");
  });

  it("says when a form is closed, sent already, or the link is no good", async () => {
    const closed = fakeApi({
      "GET /api/session": signedOut,
      [`GET /api/forms/${TOKEN}`]: () => page({ state: "closed", questions: [] }),
    });
    const a = renderAt(`/f/${TOKEN}`, closed);
    expect(await screen.findByTestId("form-closed")).toHaveTextContent(
      "This form no longer takes answers.",
    );
    a.unmount();
    const done = fakeApi({
      "GET /api/session": signedOut,
      [`GET /api/forms/${TOKEN}`]: () => page({ state: "submitted" }),
    });
    const b = renderAt(`/f/${TOKEN}`, done);
    expect(await screen.findByTestId("form-thanks")).toBeTruthy();
    b.unmount();
    const gone = fakeApi({
      "GET /api/session": signedOut,
      [`GET /api/forms/${TOKEN}`]: () =>
        new Reply(404, { error: { code: "not_found", message: "gone" } }),
    });
    renderAt(`/f/${TOKEN}`, gone);
    await waitFor(() =>
      expect(screen.getByTestId("form-gone")).toHaveTextContent(
        "This link has expired or doesn't exist.",
      ),
    );
  });
});
