// v0.17 O4 (ARCHITECTURE §10.15): the client's area owners on the Agents tab. Each shows its name,
// area and processes; saving sends the whole of its settings as the next version (a model of any
// priced provider, notes, the review default); renaming sends the name alone; a memory note can
// be forgotten.
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { AppProviders } from "../../App";
import { fakeApi, OPERATOR_SESSION } from "../../test/fixtures";
import { OwnersSection } from "./ClientOwners";

const CLIENT = "00000000-0000-4000-8000-00000000c001";
const OWNER = "00000000-0000-4000-8000-0000000000a1";
const NOTE = "00000000-0000-4000-8000-0000000000b1";

const PIA = {
  id: OWNER,
  tenantId: CLIENT,
  area: "purchasing",
  name: "Pia",
  avatar: null,
  version: 1,
  versionId: "00000000-0000-4000-8000-0000000000c1",
  model: null,
  notes: "",
  oversight: null,
  processes: [
    { agentId: "00000000-0000-4000-8000-0000000000d1", name: "Bills in", areaSet: false },
  ],
  memory: [
    {
      id: NOTE,
      note: "Acme puts the PO number in the footer",
      createdAt: "2026-11-12T10:00:00.000Z",
    },
  ],
};

function renderOwners(routes: Parameters<typeof fakeApi>[0]) {
  const api = fakeApi({
    "GET /api/session": () => OPERATOR_SESSION,
    [`GET /api/ops/clients/${CLIENT}/owners`]: () => ({ owners: [PIA] }),
    ...routes,
  });
  render(
    <MemoryRouter initialEntries={["/"]}>
      <AppProviders client={api.client}>
        <Routes>
          <Route path="*" element={<OwnersSection clientId={CLIENT} />} />
        </Routes>
      </AppProviders>
    </MemoryRouter>,
  );
  return api;
}

describe("the client's area owners", () => {
  it("shows each owner with its area, processes and what it remembers", async () => {
    renderOwners({});
    const card = await screen.findByTestId("ops-owner-purchasing");
    expect(card).toHaveTextContent("Pia");
    expect(card).toHaveTextContent("Purchasing");
    expect(within(card).getByTestId("ops-owner-purchasing-processes")).toHaveTextContent(
      "Bills in",
    );
    expect(within(card).getByTestId("ops-owner-purchasing-memory")).toHaveTextContent(
      "Acme puts the PO number in the footer",
    );
  });

  it("saves Grok, the notes and the review default as the next version", async () => {
    const bodies: unknown[] = [];
    renderOwners({
      [`POST /api/ops/owners/${OWNER}/versions`]: ({ init }) => {
        bodies.push(JSON.parse(String(init.body)));
        return { owner: { ...PIA, version: 2 } };
      },
    });
    const card = await screen.findByTestId("ops-owner-purchasing");
    const save = within(card).getByTestId("ops-owner-purchasing-save");
    expect(save).toBeDisabled();
    await userEvent.selectOptions(
      within(card).getByTestId("ops-owner-purchasing-model"),
      "xai:grok-4.7",
    );
    await userEvent.type(
      within(card).getByTestId("ops-owner-purchasing-notes"),
      "Freight under $20 needs no question.",
    );
    await userEvent.selectOptions(within(card).getByTestId("ops-owner-purchasing-review"), "all");
    await userEvent.click(save);
    await waitFor(() => expect(bodies).toHaveLength(1));
    expect(bodies[0]).toEqual({
      model: { id: "xai:grok-4.7" },
      notes: "Freight under $20 needs no question.",
      oversight: { review: "all", maxPerRun: 3, maxCostUsd: "0.25" },
    });
  });

  it("renames without a new version, and forgets a memory note", async () => {
    const calls: string[] = [];
    renderOwners({
      [`PATCH /api/ops/owners/${OWNER}`]: ({ init }) => {
        calls.push(`rename ${JSON.parse(String(init.body)).name}`);
        return { owner: { ...PIA, name: "Pip" } };
      },
      [`DELETE /api/ops/owners/${OWNER}/memory/${NOTE}`]: () => {
        calls.push("forget");
        return { ok: true };
      },
    });
    const card = await screen.findByTestId("ops-owner-purchasing");
    const name = within(card).getByTestId("ops-owner-purchasing-name");
    await userEvent.clear(name);
    await userEvent.type(name, "Pip");
    await userEvent.click(within(card).getByTestId("ops-owner-purchasing-rename"));
    await userEvent.click(within(card).getByRole("button", { name: "Forget" }));
    await waitFor(() => expect(calls).toEqual(["rename Pip", "forget"]));
  });
});
