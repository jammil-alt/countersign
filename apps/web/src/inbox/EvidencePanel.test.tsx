// QA WR3: a change card's Evidence links the document it rests on to that document's page, where
// its PDF opens, in the portal and in the back office.
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { AppProviders } from "../App";
import { CLIENT_SESSION, fakeApi, OPERATOR_SESSION } from "../test/fixtures";
import { ChangeEvidence } from "./InboxCard";

const ITEM = "00000000-0000-4000-8000-0000000a7201";
const DOC = "00000000-0000-4000-8000-0000000a7202";

const evidence = {
  itemId: ITEM,
  actionId: "00000000-0000-4000-8000-0000000a7203",
  sources: [
    {
      kind: "document",
      label: "Ferguson",
      number: "INV-2231",
      amount: "512.40",
      currency: "USD",
      recordId: DOC,
    },
  ],
  producedBy: { step: null, from: [], rule: null },
  confidence: { value: null, basis: null },
  values: [],
  verification: null,
  threshold: null,
};

function renderCard(surface: "portal" | "ops", documentHref?: (id: string) => string) {
  const api = fakeApi({
    "GET /api/session": () => (surface === "ops" ? OPERATOR_SESSION : CLIENT_SESSION),
    [`GET /api/inbox/${ITEM}/evidence`]: () => ({ evidence }),
    [`GET /api/ops/inbox/${ITEM}/evidence`]: () => ({
      evidence: { ...evidence, agentVersionId: null },
    }),
  });
  render(
    <MemoryRouter>
      <AppProviders client={api.client}>
        <ChangeEvidence
          item={{ id: ITEM, kind: "external_action", payload: { tool: "qbo.bill.create" } }}
          surface={surface}
          {...(documentHref ? { documentHref } : {})}
        />
      </AppProviders>
    </MemoryRouter>,
  );
}

describe("a change card's Evidence", () => {
  it("links the document it rests on to its page, where the PDF opens (the portal's by default)", async () => {
    renderCard("portal");
    await userEvent.click(await screen.findByText("Evidence"));
    const link = await screen.findByTestId(`inbox-evidence-document-${DOC}`);
    expect(link).toHaveAttribute("href", `/documents/${DOC}`);
    expect(within(link).getByText(/Ferguson · INV-2231/)).toBeInTheDocument();
  });

  it("links to the client's document page in the back office", async () => {
    renderCard("ops", (id) => `/ops/clients/c1/documents/${id}`);
    await userEvent.click(await screen.findByText("Evidence"));
    expect(await screen.findByTestId(`inbox-evidence-document-${DOC}`)).toHaveAttribute(
      "href",
      `/ops/clients/c1/documents/${DOC}`,
    );
  });
});
