// `/texts/:token` (docs/plan.md §1.98): the page where a person chooses to get texts, with no
// sign-in; the box starts unticked, the exact words come from the API, and an invitation can be
// turned down for good.
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { AppProviders, AppRoutes } from "../App";
import { fakeApi, Reply } from "../test/fixtures";

const TOKEN = "eyJrIjoibCJ9.c2lnbmF0dXJl";
const TERMS =
  "I agree to get text messages from Rivera Supply, sent through Mezonas, about my work with Rivera Supply: questions, updates, codes and alerts. No marketing. Msg frequency varies. Msg & data rates may apply. Reply STOP to opt out, HELP for help. Terms: https://mezonas.com/sms-terms. Privacy: https://mezonas.com/privacy.";

const page = (over: Record<string, unknown> = {}) => ({
  client: "Rivera Supply",
  kind: "link",
  name: null,
  phone: null,
  terms: TERMS,
  wordingVersion: 1,
  state: "open",
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

describe("the texting sign-up page", () => {
  it("asks for a name and number, and signs up only once the box is ticked", async () => {
    const posts: unknown[] = [];
    const api = fakeApi({
      "GET /api/session": signedOut,
      [`GET /api/text-signup/${TOKEN}`]: () => page(),
      [`POST /api/text-signup/${TOKEN}`]: ({ init }) => {
        posts.push(JSON.parse(String(init.body)));
        return { confirmation: "sent" };
      },
    });
    renderAt(`/texts/${TOKEN}`, api);
    expect(await screen.findByTestId("text-signup-title")).toHaveTextContent(
      "Get texts from Rivera Supply",
    );
    // No sign-in asked for.
    expect(screen.queryByTestId("signin-frame")).toBeNull();
    expect(screen.getByTestId("text-signup-terms")).toHaveTextContent(TERMS);
    expect(screen.getByText("Texting is your choice. Nothing else depends on it.")).toBeTruthy();
    const agree = screen.getByTestId("text-signup-agree");
    expect(agree).not.toBeChecked();
    const submit = screen.getByTestId("text-signup-submit");
    expect(submit).toHaveTextContent("Text me");

    await userEvent.type(screen.getByTestId("text-signup-name"), "Dana Kim");
    await userEvent.type(screen.getByTestId("text-signup-phone"), "(512) 555-0177");
    expect(submit).toBeDisabled();
    await userEvent.click(agree);
    expect(submit).toBeEnabled();
    await userEvent.click(submit);
    expect(await screen.findByTestId("text-signup-done")).toHaveTextContent(
      "We sent a text from Rivera Supply to confirm.",
    );
    expect(posts).toEqual([
      { name: "Dana Kim", phone: "(512) 555-0177", agree: true, wordingVersion: 1 },
    ]);
    // An invitation link has no "don't ask me again" on the client's link.
    expect(screen.queryByTestId("text-signup-no")).toBeNull();
  });

  it("greets an invited person by name, with their number to confirm or change", async () => {
    const posts: unknown[] = [];
    const api = fakeApi({
      "GET /api/session": signedOut,
      [`GET /api/text-signup/${TOKEN}`]: () =>
        page({ kind: "invitation", name: "Pat Rivera", phone: "+15125550180" }),
      [`POST /api/text-signup/${TOKEN}`]: ({ init }) => {
        posts.push(JSON.parse(String(init.body)));
        return { confirmation: "pending" };
      },
    });
    renderAt(`/texts/${TOKEN}`, api);
    expect(
      await screen.findByText(
        "Hi Pat, Rivera Supply would like to text you about your work together: quick questions, updates and alerts.",
      ),
    ).toBeTruthy();
    expect(screen.queryByTestId("text-signup-name")).toBeNull();
    expect(screen.getByTestId("text-signup-phone")).toHaveValue("(512) 555-0180");
    await userEvent.click(screen.getByTestId("text-signup-agree"));
    await userEvent.click(screen.getByTestId("text-signup-submit"));
    expect(await screen.findByTestId("text-signup-done")).toHaveTextContent(
      "Texts from Rivera Supply start once its number is ready.",
    );
    expect(posts).toEqual([{ phone: "(512) 555-0180", agree: true, wordingVersion: 1 }]);
  });

  it("turns an invitation down for good, from the email's link", async () => {
    const api = fakeApi({
      "GET /api/session": signedOut,
      [`GET /api/text-signup/${TOKEN}`]: () => page({ kind: "invitation", name: "Kim Ortiz" }),
      [`POST /api/text-signup/${TOKEN}/decline`]: () => ({ ok: true }),
    });
    renderAt(`/texts/${TOKEN}?decline=1`, api);
    await userEvent.click(await screen.findByTestId("text-signup-decline"));
    expect(await screen.findByTestId("text-signup-declined")).toHaveTextContent(
      "Rivera Supply won't ask you about texts again. Email keeps working.",
    );
    expect(api.calls).toContain(`POST /api/text-signup/${TOKEN}/decline`);
  });

  it("says when someone is already signed up, and when a link is no good", async () => {
    const api = fakeApi({
      "GET /api/session": signedOut,
      [`GET /api/text-signup/${TOKEN}`]: () => page({ kind: "invitation", state: "signed_up" }),
      "GET /api/text-signup/gone-and-forgotten": () =>
        new Reply(404, { error: { code: "not_found" } }),
    });
    renderAt(`/texts/${TOKEN}`, api);
    expect(await screen.findByTestId("text-signup-already")).toHaveTextContent(
      "You're already signed up for texts from Rivera Supply.",
    );
    for (const bad of ["gone-and-forgotten", "short"]) {
      const { unmount } = renderAt(`/texts/${bad}`, api);
      await waitFor(() =>
        expect(screen.getByTestId("text-signup-gone")).toHaveTextContent(
          "It has expired or doesn't exist.",
        ),
      );
      unmount();
    }
  });
});
