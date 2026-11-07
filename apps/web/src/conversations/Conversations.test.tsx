// v0.14 capture: the client admin's /conversations (docs/plan.md §1.55): each WhatsApp
// conversation with its two switches, a change sent with the time it was read, and "download now"
// on a message whose attachment wasn't downloaded. What the sender wrote shows as text.
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { AppProviders, AppRoutes } from "../App";
import { CLIENT_SESSION, fakeApi } from "../test/fixtures";

const DEMO = "00000000-0000-4000-8000-00000000a002";
const CONV = "00000000-0000-4000-8000-0000000d0001";
const RAW = "00000000-0000-4000-8000-0000000e0001";
const PAT = "00000000-0000-4000-8000-0000000c0001";

const conv = (attachments: "off" | "documents" | "all") => ({
  id: CONV,
  kind: "direct",
  channel: "whatsapp",
  title: "Pat Lee",
  contact: { id: PAT, name: "Pat Lee" },
  capture: { archive: true, attachments, maxBytes: 20971520 },
  lastMessageAt: "2026-11-06T10:00:00.000Z",
  createdAt: "2026-11-06T09:00:00.000Z",
  updatedAt: "2026-11-06T09:30:00.000Z",
});

describe("portal conversations", () => {
  it("turns attachments on and downloads one message's attachment now", async () => {
    let current = conv("off");
    const sent: { path: string; body: unknown }[] = [];
    const api = fakeApi({
      "GET /api/session": () => CLIENT_SESSION,
      "GET /api/feedback/status": () => ({ enabled: false }),
      "GET /api/overview": () => ({
        client: { id: DEMO, name: "Demo client" },
        services: [],
        needsYou: { inbox: 0 },
        recentRuns: [],
      }),
      "GET /api/conversations": () => ({ items: [current] }),
      [`PUT /api/conversations/${CONV}/capture`]: ({ init }) => {
        sent.push({ path: "capture", body: JSON.parse(String(init.body)) });
        current = { ...conv("documents"), updatedAt: "2026-11-06T09:31:00.000Z" };
        return { conversation: current };
      },
      [`GET /api/conversations/${CONV}/messages`]: () => ({
        items: [
          {
            rawRecordId: RAW,
            sid: `MM${"a".repeat(32)}`,
            text: "<b>Invoice attached</b>",
            at: "2026-11-06T10:00:00.000Z",
            attachments: [
              {
                index: 0,
                contentType: "image/png",
                sizeBytes: null,
                status: "not_downloaded",
                documentId: null,
              },
            ],
          },
        ],
      }),
      [`POST /api/conversations/${CONV}/messages/${RAW}/download`]: () => {
        sent.push({ path: "download", body: null });
        return { started: [0], done: [] };
      },
    });
    render(
      <MemoryRouter initialEntries={["/conversations"]}>
        <AppProviders client={api.client}>
          <AppRoutes />
        </AppProviders>
      </MemoryRouter>,
    );
    expect(await screen.findByText("Pat Lee")).toBeInTheDocument();
    // `/conversations` is a section of Settings now.
    expect(screen.getByTestId("portal-settings-nav-conversations")).toHaveAttribute(
      "aria-current",
      "page",
    );
    await userEvent.selectOptions(
      screen.getByTestId(`conversation-${CONV}-attachments`),
      "documents",
    );
    await waitFor(() =>
      expect(sent[0]).toEqual({
        path: "capture",
        body: { attachments: "documents", updatedAt: "2026-11-06T09:30:00.000Z" },
      }),
    );
    await userEvent.click(screen.getByText("Show messages"));
    // The sender's words are text, never markup.
    expect(await screen.findByText("<b>Invoice attached</b>")).toBeInTheDocument();
    expect(screen.getByText("Not downloaded")).toBeInTheDocument();
    await userEvent.click(screen.getByText("Download now"));
    await waitFor(() => expect(sent.map((s) => s.path)).toEqual(["capture", "download"]));
    expect(await screen.findByText("Downloading 1 attachment.")).toBeInTheDocument();
  });
});
