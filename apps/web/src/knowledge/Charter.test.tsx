// B6 (docs/builder-plan.md §8): the client's charter and policy tags on both surfaces. The back
// office drafts the charter from onboarding; the portal shows it waiting on the client admin
// (gold, with a word), who confirms it from the version shown; "How Mezonas agents work" is read
// only, in the reader's language, and its English is core's own text.
import { HOW_AGENTS_WORK } from "@countersign/core";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { AppProviders, AppRoutes } from "../App";
import { en } from "../i18n/messages/en";
import { CLIENT_SESSION, fakeApi, OPERATOR_SESSION, SANDBOX_DETAIL } from "../test/fixtures";

const DEMO = "00000000-0000-4000-8000-00000000a002";
const CHARTER = "00000000-0000-4000-8000-0000000ac001";
const POLICY = "00000000-0000-4000-8000-0000000ac002";

function renderAt(path: string, api: ReturnType<typeof fakeApi>) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <AppProviders client={api.client}>
        <AppRoutes />
      </AppProviders>
    </MemoryRouter>,
  );
}

const charter = (over: Record<string, unknown> = {}) => ({
  id: CHARTER,
  kind: "policy",
  status: "active",
  version: 1,
  title: "Our charter",
  body: "Who we are\nA family lumber yard.",
  createdAt: "2026-11-18T10:00:00.000Z",
  updatedAt: "2026-11-18T10:00:00.000Z",
  updatedBy: { role: "operator", name: null },
  tier: "charter",
  tags: [],
  confirmed: null,
  inUseVersion: null,
  ...over,
});

const portalBase = {
  "GET /api/session": () => CLIENT_SESSION,
  "GET /api/feedback/status": () => ({ enabled: false }),
  "GET /api/overview": () => ({
    client: { id: DEMO, name: "Demo client" },
    services: [],
    needsYou: { inbox: 0 },
    recentRuns: [],
  }),
};

describe("the charter in the portal", () => {
  it("waits on the client admin, who confirms it from the version shown", async () => {
    let current = charter();
    const confirms: unknown[] = [];
    const api = fakeApi({
      ...portalBase,
      "GET /api/knowledge": () => ({ entries: [current] }),
      [`POST /api/knowledge/entries/${CHARTER}/confirm`]: ({ init }) => {
        confirms.push(JSON.parse(String(init.body)));
        current = charter({
          version: 2,
          confirmed: { by: "Demo admin", at: "2026-11-19T10:00:00.000Z" },
          inUseVersion: 2,
        });
        return { entry: current };
      },
    });
    renderAt("/knowledge", api);
    const card = await screen.findByTestId("portal-knowledge-charter");
    expect(card).toHaveTextContent("A family lumber yard.");
    // Gold means waiting on you, with a word.
    const status = within(card).getByTestId("portal-knowledge-charter-status");
    expect(status).toHaveTextContent("Waiting on you");
    expect(status).toHaveClass("ds-pill--warning");
    // The charter is not in the FAQs and policies list too.
    expect(screen.queryByTestId(`portal-knowledge-entry-${CHARTER}`)).toBeNull();

    await userEvent.click(within(card).getByTestId("portal-knowledge-charter-confirm"));
    expect(confirms).toEqual([{ baseVersion: 1 }]);
    await waitFor(() =>
      expect(screen.getByTestId("portal-knowledge-charter-status")).toHaveTextContent("Confirmed"),
    );
    expect(screen.getByTestId("portal-knowledge-charter-line")).toHaveTextContent(
      "Confirmed by Demo admin",
    );
    expect(screen.queryByTestId("portal-knowledge-charter-confirm")).toBeNull();
  });

  it("says which version agents follow while a newer draft waits", async () => {
    const api = fakeApi({
      ...portalBase,
      "GET /api/knowledge": () => ({ entries: [charter({ version: 3, inUseVersion: 2 })] }),
    });
    renderAt("/knowledge", api);
    expect(await screen.findByTestId("portal-knowledge-charter-line")).toHaveTextContent(
      "Our agents follow version 2 until you confirm this one.",
    );
  });

  it("edits the charter from the version shown", async () => {
    const edits: unknown[] = [];
    const api = fakeApi({
      ...portalBase,
      "GET /api/knowledge": () => ({ entries: [charter({ version: 2 })] }),
      [`PUT /api/knowledge/entries/${CHARTER}`]: ({ init }) => {
        edits.push(JSON.parse(String(init.body)));
        return { entry: charter({ version: 3 }) };
      },
    });
    renderAt("/knowledge", api);
    await userEvent.click(await screen.findByTestId("portal-knowledge-charter-edit-open"));
    // The charter is read by every step: it has no tags to pick.
    expect(screen.queryByTestId("portal-knowledge-charter-edit-tags")).toBeNull();
    const body = screen.getByTestId("portal-knowledge-charter-edit-body");
    await userEvent.clear(body);
    await userEvent.type(body, "We sell lumber.");
    await userEvent.click(screen.getByTestId("portal-knowledge-charter-edit-save"));
    expect(edits).toEqual([{ title: "Our charter", body: "We sell lumber.", baseVersion: 2 }]);
  });

  it("shows how Mezonas agents work, read only, and no charter yet", async () => {
    const api = fakeApi({ ...portalBase, "GET /api/knowledge": () => ({ entries: [] }) });
    renderAt("/knowledge", api);
    const how = await screen.findByTestId("portal-knowledge-how");
    expect(how).toHaveTextContent("How Mezonas agents work");
    expect(how).toHaveTextContent("You approve changes");
    expect(within(how).queryByRole("button")).toBeNull();
    // The rail shows at once; the charter waits for the knowledge list.
    expect(await screen.findByTestId("portal-knowledge-charter-none")).toHaveTextContent(
      "We'll draft your charter from what you told us during onboarding",
    );
  });

  it("adds a policy with what it covers", async () => {
    const sent: unknown[] = [];
    const api = fakeApi({
      ...portalBase,
      "GET /api/knowledge": () => ({ entries: [] }),
      "POST /api/knowledge/entries": ({ init }) => {
        const body = JSON.parse(String(init.body));
        sent.push(body);
        return {
          entry: charter({ id: POLICY, tier: "policy", tags: body.tags, title: body.title }),
        };
      },
    });
    renderAt("/knowledge", api);
    await screen.findByTestId("portal-knowledge-new");
    // Tags are for policies, not FAQs.
    expect(screen.queryByTestId("portal-knowledge-new-tags")).toBeNull();
    await userEvent.selectOptions(screen.getByTestId("portal-knowledge-new-kind"), "policy");
    await userEvent.type(screen.getByTestId("portal-knowledge-new-title"), "Big returns");
    await userEvent.type(screen.getByTestId("portal-knowledge-new-body"), "Over $500: ask Dana.");
    await userEvent.click(screen.getByTestId("portal-knowledge-new-tags-money"));
    await userEvent.click(screen.getByTestId("portal-knowledge-new-tags-purchasing"));
    await userEvent.click(screen.getByTestId("portal-knowledge-new-save"));
    expect(sent).toEqual([
      {
        kind: "policy",
        title: "Big returns",
        body: "Over $500: ask Dana.",
        tier: "policy",
        tags: ["money", "purchasing"],
      },
    ]);
  });
});

describe("the charter in the back office", () => {
  const CLIENT = SANDBOX_DETAIL.client.id;

  it("drafts the charter from onboarding and shows it waiting for the client", async () => {
    let entries: unknown[] = [];
    const drafts: unknown[] = [];
    const api = fakeApi({
      "GET /api/session": () => OPERATOR_SESSION,
      [`GET /api/ops/clients/${CLIENT}`]: () => SANDBOX_DETAIL,
      [`GET /api/ops/clients/${CLIENT}/knowledge`]: () => ({
        entries,
        documents: [],
        memoryNotes: { count: 0, recent: [] },
      }),
      [`POST /api/ops/clients/${CLIENT}/knowledge/charter/draft`]: ({ init }) => {
        drafts.push(JSON.parse(String(init.body)));
        const drafted = charter();
        entries = [drafted];
        return { entry: drafted, from: { facts: 3, about: 1 } };
      },
    });
    renderAt(`/ops/clients/${CLIENT}/knowledge`, api);
    await userEvent.click(await screen.findByTestId("ops-knowledge-charter-draft"));
    expect(drafts).toEqual([{}]);
    const card = await screen.findByTestId("ops-knowledge-charter");
    expect(card).toHaveTextContent("A family lumber yard.");
    // Not waiting on us: neutral, with words.
    const status = within(card).getByTestId("ops-knowledge-charter-status");
    expect(status).toHaveTextContent("Waiting for the client to confirm");
    expect(status).toHaveClass("ds-pill--neutral");
    expect(within(card).getByTestId("ops-knowledge-charter-draft")).toHaveTextContent(
      "Draft it again from onboarding",
    );
  });

  it("shows a policy's tags", async () => {
    const api = fakeApi({
      "GET /api/session": () => OPERATOR_SESSION,
      [`GET /api/ops/clients/${CLIENT}`]: () => SANDBOX_DETAIL,
      [`GET /api/ops/clients/${CLIENT}/knowledge`]: () => ({
        entries: [charter({ id: POLICY, tier: "policy", tags: ["money", "purchasing"] })],
        documents: [],
        memoryNotes: { count: 0, recent: [] },
      }),
    });
    renderAt(`/ops/clients/${CLIENT}/knowledge`, api);
    const card = await screen.findByTestId(`ops-knowledge-entry-${POLICY}`);
    expect(within(card).getByTestId("ops-knowledge-entry-tags")).toHaveTextContent(
      "MoneyPurchasing",
    );
  });
});

describe("how Mezonas agents work", () => {
  it("is core's text in English", () => {
    const messages = en as Record<string, unknown>;
    expect(messages["howAgentsWork.title"]).toBe(HOW_AGENTS_WORK.title);
    for (const p of HOW_AGENTS_WORK.points) {
      expect(messages[`howAgentsWork.${p.id}.title`]).toBe(p.title);
      expect(messages[`howAgentsWork.${p.id}.body`]).toBe(p.body);
    }
  });
});
