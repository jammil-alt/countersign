// `/ops/users` (docs/plan.md §1.122): the operators who serve your clients, inviting one (they
// serve every client you serve), giving one the clients they don't have, and removing one after a
// confirmation (never yourself).
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { AppProviders, AppRoutes } from "../../App";
import { fakeApi, OPERATOR_SESSION } from "../../test/fixtures";

const ME = OPERATOR_SESSION.user.id;
const ANA = "00000000-0000-4000-8000-0000000000c1";

const op = (userId: string, email: string, clients: number, you = false) => ({
  userId,
  email,
  name: null,
  signedIn: true,
  clients,
  you,
});

function renderAt(path: string, api: ReturnType<typeof fakeApi>) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <AppProviders client={api.client}>
        <AppRoutes />
      </AppProviders>
    </MemoryRouter>,
  );
}

describe("ops users", () => {
  it("lists, invites, gives clients and removes operators", async () => {
    let operators = [op(ME, OPERATOR_SESSION.user.email, 3, true), op(ANA, "ana@mezonas.com", 1)];
    const invites: unknown[] = [];
    const removed: string[] = [];
    const api = fakeApi({
      "GET /api/session": () => OPERATOR_SESSION,
      "GET /api/ops/clients": () => ({ clients: [] }),
      "GET /api/ops/operators": () => ({ operators, clients: 3 }),
      "POST /api/ops/operators": ({ init }) => {
        const body = JSON.parse(String(init.body));
        invites.push(body);
        const known = operators.find((o) => o.email === body.email);
        const added = known ? 3 - known.clients : 3;
        const row = op(known?.userId ?? "00000000-0000-4000-8000-0000000000c2", body.email, 3);
        operators = [...operators.filter((o) => o.email !== body.email), row];
        return { operator: row, added, email: { status: "sent", reason: null } };
      },
      [`DELETE /api/ops/operators/${ANA}`]: () => {
        removed.push(ANA);
        operators = operators.filter((o) => o.userId !== ANA);
        return { removed: { userId: ANA, email: "ana@mezonas.com" }, clients: 3, reassigned: 0 };
      },
    });
    renderAt("/ops/users", api);
    const ana = await screen.findByTestId("ops-users-ana@mezonas.com");
    expect(within(ana).getByTestId("ops-users-ana@mezonas.com-clients")).toHaveTextContent(
      "Serves 1 of your 3 clients.",
    );
    const me = screen.getByTestId(`ops-users-${OPERATOR_SESSION.user.email}`);
    expect(me).toHaveTextContent("You");
    // Never yourself.
    expect(within(me).queryByTestId(`ops-users-${OPERATOR_SESSION.user.email}-remove`)).toBeNull();

    await userEvent.click(within(ana).getByTestId("ops-users-ana@mezonas.com-add-all"));
    await waitFor(() =>
      expect(screen.getByTestId("ops-users-ana@mezonas.com-clients")).toHaveTextContent(
        "Serves all 3 of your clients.",
      ),
    );

    const form = screen.getByTestId("ops-users-invite");
    await userEvent.type(within(form).getByTestId("ops-users-invite-email"), "new@mezonas.com");
    await userEvent.click(within(form).getByTestId("ops-users-invite-send"));
    expect(await within(form).findByTestId("ops-users-invite-done")).toHaveTextContent(
      "Added new@mezonas.com to 3 clients. We emailed them an invitation.",
    );
    expect(invites).toEqual([{ email: "ana@mezonas.com" }, { email: "new@mezonas.com" }]);
    expect(await screen.findByTestId("ops-users-new@mezonas.com")).toBeInTheDocument();

    await userEvent.click(screen.getByTestId("ops-users-ana@mezonas.com-remove"));
    await userEvent.click(screen.getByTestId("ops-users-ana@mezonas.com-remove-yes"));
    await waitFor(() => expect(screen.queryByTestId("ops-users-ana@mezonas.com")).toBeNull());
    expect(removed).toEqual([ANA]);
  });
});
