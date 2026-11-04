// The portal screens other streams built, in Spanish and German (docs/plan.md §1.18): Settings
// (people, invites, emails, approvals), Reports and the Service page, record pages and a document,
// and "Who approves" for the client admin. Words come from the message files; numbers, money and
// dates from Intl in the reader's locale; names and what a tool sent stay as written.
import type { Locale } from "@countersign/core";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { AppProviders, AppRoutes } from "../App";
import { ApiProvider } from "../api/useApi";
import { PortalApproverRules } from "../portal/screens/ApproverRules";
import { CLIENT_SESSION, fakeApi, Reply } from "../test/fixtures";
import { I18nProvider } from "./i18n";

const DEMO = "00000000-0000-4000-8000-00000000a002";
const SVC = "00000000-0000-4000-8000-00000000b001";
const RUN = "00000000-0000-4000-8000-0000000f1001";
const TXN = "00000000-0000-4000-8000-0000000a7001";
const VENDOR = "00000000-0000-4000-8000-0000000a7003";
const DOC = "00000000-0000-4000-8000-0000000a7004";
const ANA = "00000000-0000-4000-8000-00000000b011";

function sessionIn(locale: Locale) {
  return { ...CLIENT_SESSION, language: { effective: locale, user: locale, client: null } };
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

function portalApi(locale: Locale, routes: Parameters<typeof fakeApi>[0]) {
  return fakeApi({
    "GET /api/session": () => sessionIn(locale),
    "GET /api/overview": () => new Reply(404, {}),
    "GET /api/feedback/status": () => ({ enabled: false }),
    ...routes,
  });
}

const runs = (o: Partial<Record<string, number>> = {}) => ({
  total: 0,
  succeeded: 0,
  failed: 0,
  cancelled: 0,
  waiting: 0,
  going: 0,
  ...o,
});

const REPORT = {
  from: "2026-11-01",
  to: "2026-11-03",
  timezone: "Europe/Berlin",
  runs: runs({ total: 1204, succeeded: 1200, failed: 1, waiting: 3 }),
  documents: { received: 4, read: 3 },
  actions: { total: 2, byConnector: [{ connector: "qbo", name: "QuickBooks Online", count: 2 }] },
  services: [
    {
      id: SVC,
      name: "Record keeping",
      runs: runs({ total: 2, succeeded: 1, waiting: 1 }),
      documentsRead: 3,
      actions: 2,
    },
  ],
  packs: [],
};

describe("portal settings in Spanish", () => {
  it("lists people, invites, emails and approvals in Spanish", async () => {
    const users = [
      {
        userId: "u-1",
        email: "admin@demo.example.com",
        name: null,
        role: "client_admin",
        signedIn: null,
      },
    ];
    const api = portalApi("es", {
      "GET /api/users": () => ({ users }),
      "POST /api/users": ({ init }) => {
        const body = JSON.parse(String(init.body));
        const added = {
          userId: "u-2",
          email: body.email,
          name: null,
          role: body.role,
          signedIn: false,
        };
        users.push(added as unknown as (typeof users)[number]);
        return { member: added, email: { status: "sent", reason: null } };
      },
      "GET /api/settings": () => ({
        client: { id: DEMO, name: "Demo client", timezone: "UTC" },
        approvals: "client_admin",
        notifications: { itemsWaiting: true, weeklyDigest: false },
        emailsOn: false,
      }),
    });
    renderAt("/settings", api);
    expect(await screen.findByRole("heading", { name: "Ajustes" })).toBeInTheDocument();
    expect(await screen.findByText("1 persona usa su portal.")).toBeInTheDocument();
    expect(screen.getByTestId("portal-users-admin@demo.example.com")).toHaveTextContent(
      "Administrador",
    );
    const form = screen.getByTestId("portal-invite");
    expect(within(form).getByText("Correo electrónico")).toBeInTheDocument();
    await userEvent.click(within(form).getByTestId("portal-invite-send"));
    expect(within(form).getByTestId("portal-invite-email-error")).toHaveTextContent(
      "Escriba una dirección de correo.",
    );
    await userEvent.type(within(form).getByTestId("portal-invite-email"), "ana@demo.example.com");
    await userEvent.click(within(form).getByTestId("portal-invite-send"));
    expect(await within(form).findByTestId("portal-invite-done")).toHaveTextContent(
      "Enviamos una invitación a ana@demo.example.com.",
    );
    expect(await screen.findByText("2 personas usan su portal.")).toBeInTheDocument();
    const emails = screen.getByTestId("portal-settings-notifications");
    expect(emails).toHaveTextContent("Resumen semanal");
    expect(within(emails).getByTestId("portal-notifications-off")).toHaveTextContent(
      "Los correos llegarán pronto",
    );
    expect(within(emails).getByTestId("portal-notifications-save")).toHaveTextContent("Guardar");
    expect(screen.getByTestId("portal-settings-approvals")).toHaveTextContent(
      "Usted aprueba los cambios en sus herramientas antes de que ocurran.",
    );
  });
});

describe("reports and the service page in German", () => {
  it("shows the activity report with German words, counts and dates", async () => {
    const api = portalApi("de", { "GET /api/reports/activity": () => REPORT });
    renderAt("/reports", api);
    expect(await screen.findByRole("heading", { name: "Berichte" })).toBeInTheDocument();
    expect(
      await screen.findByText("Was Ihre Services erledigt haben, 1. Nov. – 3. Nov. 2026."),
    ).toBeInTheDocument();
    const stat = screen.getByTestId("portal-report-runs");
    expect(stat).toHaveTextContent("1.204");
    expect(stat).toHaveTextContent("1.200 erledigt, 1 fehlgeschlagen, 3 warten auf eine Person");
    expect(screen.getByTestId("portal-report-documents")).toHaveTextContent(
      "4 Dokumente eingegangen",
    );
    expect(screen.getByTestId("portal-report-period-filter-last")).toHaveTextContent(
      "Letzter Monat",
    );
    const row = screen.getByTestId(`portal-report-service-${SVC}`);
    expect(row).toHaveTextContent("1 wartet");
    expect(screen.getByTestId("portal-report-services")).toHaveTextContent("Gelesene Dokumente");
  });

  it("shows a service's month, runs and reports in German", async () => {
    const api = portalApi("de", {
      [`GET /api/services/${SVC}`]: () => ({
        service: { id: SVC, name: "Record keeping", description: null, status: "paused" },
        thisMonth: {
          from: "2026-11-01",
          to: "2026-11-04",
          runs: runs({ total: 2, succeeded: 1, waiting: 1 }),
          documentsRead: 3,
          actions: 1,
        },
        recentRuns: [
          {
            id: RUN,
            service: { id: SVC, name: "Record keeping" },
            status: "succeeded",
            startedAt: "2026-11-03T10:00:00.000Z",
            finishedAt: "2026-11-03T10:01:00.000Z",
          },
        ],
        packs: [],
      }),
    });
    renderAt(`/services/${SVC}`, api);
    expect(await screen.findByRole("heading", { name: "Record keeping" })).toBeInTheDocument();
    expect(screen.getByText("Pausiert")).toBeInTheDocument();
    expect(screen.getByText("Hier beschreiben wir, was dieser Service tut.")).toBeInTheDocument();
    expect(screen.getByText("1. Nov. – 4. Nov. 2026")).toBeInTheDocument();
    expect(screen.getByTestId("portal-service-runs")).toHaveTextContent("1 erledigt, 1 wartet");
    expect(screen.getByTestId(`portal-service-run-${RUN}`)).toHaveTextContent("Erledigt");
    expect(screen.getByTestId("portal-service-reports")).toHaveTextContent(
      "2 Abläufe diesen Monat",
    );
  });
});

describe("records and documents", () => {
  it("shows a transaction in German, with what the tool sent as it was", async () => {
    const api = portalApi("de", {
      [`GET /api/records/${TXN}`]: () => ({
        record: {
          kind: "transaction",
          id: TXN,
          txnKind: "purchase",
          connector: "upload",
          externalId: "abc:1",
          vendor: { id: VENDOR, name: "Northline Panel Supply" },
          txnDate: "2026-10-29",
          total: "9742.3500",
          currency: "EUR",
          purchaserRef: null,
          paymentType: "card",
          memo: "Sheet goods",
          status: "needs_doc",
          createdAt: "2026-10-29T10:00:00.000Z",
          lines: [],
          documents: [],
          rawRecordId: null,
        },
      }),
    });
    renderAt(`/records/${TXN}`, api);
    const page = await screen.findByTestId("record-transaction");
    expect(page).toHaveTextContent("Einkauf · 9.742,35 €");
    expect(screen.getByTestId("record-status")).toHaveTextContent("Dokument fehlt");
    expect(page).toHaveTextContent("29. Okt. 2026");
    expect(page).toHaveTextContent("Keine Positionen: Wir haben nur die Summe.");
    expect(page).toHaveTextContent("Noch kein Dokument verknüpft.");
    // The memo is the tool's own words.
    expect(page).toHaveTextContent("Sheet goods");
    // The way back (the sidebar has the same link).
    expect(screen.getAllByRole("link", { name: "Abläufe" })).toHaveLength(2);
  });

  it("says in Spanish when an id is no record", async () => {
    const api = portalApi("es", {
      [`GET /api/records/${TXN}`]: () =>
        new Reply(404, { error: { code: "not_found", message: "no record" } }),
    });
    renderAt(`/records/${TXN}`, api);
    expect(await screen.findByTestId("record-not-found")).toHaveTextContent(
      "No hay página de registro para este id.",
    );
  });

  it("shows a document in Spanish, matched to its purchase", async () => {
    const api = portalApi("es", {
      [`GET /api/documents/${DOC}`]: () => ({
        document: {
          id: DOC,
          source: "email",
          filename: "northline-20418.pdf",
          mimeType: "application/pdf",
          sizeBytes: 48_000,
          status: "extracted",
          pageCount: 1,
          transactionId: TXN,
          receivedAt: "2026-10-29T10:00:00.000Z",
          vendorName: "Northline Panel Supply",
          invoiceNumber: "20418",
          total: "9742.3500",
          meta: {},
        },
        url: "https://files.example.com/northline?sig=1",
        urlExpiresAt: "2026-10-29T10:05:00.000Z",
        extraction: {
          id: "00000000-0000-4000-8000-0000000a8003",
          createdAt: "2026-10-29T10:01:00.000Z",
          vendorName: "Northline Panel Supply",
          invoiceNumber: "20418",
          invoiceDate: "2026-10-28",
          dueDate: null,
          poNumber: null,
          currency: "EUR",
          subtotal: "9742.3500",
          freight: "0.0000",
          surcharges: [],
          tax: "0.0000",
          total: "9742.3500",
          linesSum: "9742.3500",
          totalsMatch: true,
          problems: [],
          lines: [],
        },
      }),
    });
    renderAt(`/documents/${DOC}`, api);
    expect(
      await screen.findByRole("heading", { name: "Northline Panel Supply · factura 20418" }),
    ).toBeInTheDocument();
    expect(screen.getByTestId("portal-document-totals")).toHaveTextContent("9742,35");
    expect(screen.getByTestId("portal-document-transaction")).toHaveAttribute(
      "href",
      `/records/${TXN}`,
    );
    expect(screen.getByTestId("portal-document-original")).toHaveTextContent("Abrir el original");
    expect(screen.getAllByRole("link", { name: "Conexiones" })).toHaveLength(2);
  });
});

describe("who approves, for the client admin in German", () => {
  it("labels rules, approvers and the form in German", async () => {
    const api = fakeApi({
      "GET /api/approver-rules": () => ({
        revision: 1,
        rules: [
          {
            id: "00000000-0000-4000-8000-0000000000e1",
            match: { verb: "create", amountOver: { value: "1000", currency: "EUR" } },
            approver: { kind: "operator" },
            setBy: "operator",
          },
        ],
        people: [
          { id: ANA, name: "Ana Diaz", email: "ana@demo.example.com", role: "client_admin" },
        ],
        connectors: [],
        agents: [],
        changes: [
          {
            id: "c1",
            side: "operator",
            by: "Operator",
            reason: "Big changes come to us",
            revision: 1,
            createdAt: "2026-11-04T10:00:00.000Z",
          },
        ],
        canTighten: true,
      }),
    });
    // The Connections screen's section, on its own (the screen's other sections have their tests).
    render(
      <ApiProvider client={api.client}>
        <I18nProvider locale="de" browser={[]}>
          <PortalApproverRules />
        </I18nProvider>
      </ApiProvider>,
    );
    const section = await screen.findByTestId("portal-approvers");
    expect(within(section).getAllByText("Wer freigibt").length).toBeGreaterThan(0);
    expect(await within(section).findByTestId("approver-rule-match")).toHaveTextContent(
      "Erstellt · Über 1000 EUR",
    );
    expect(section).toHaveTextContent("Von uns festgelegt");
    expect(within(section).getByTestId("approver-rules-history")).toHaveTextContent(
      "Wir haben sie am 4. Nov. 2026 geändert: Big changes come to us",
    );
    const select = within(section).getByTestId("approver-rule-approver-select");
    expect(
      within(select)
        .getAllByRole("option")
        .map((o) => o.textContent),
    ).toEqual(["Ihr Admin", "Jemand aus Ihrem Team", "Ana Diaz", "Wir geben für Sie frei"]);
    await userEvent.click(within(section).getByTestId("approver-rules-add"));
    const form = within(section).getByTestId("approver-rule-form");
    expect(form).toHaveTextContent("Betrag über");
    await userEvent.type(within(form).getByTestId("approver-rule-form-amount"), "zwölf");
    await userEvent.click(within(form).getByTestId("approver-rule-form-done"));
    expect(within(form).getByTestId("approver-rule-form-problem")).toHaveTextContent(
      "Geben Sie den Betrag als Zahl ein",
    );
    await waitFor(() => expect(document.documentElement.lang).toBe("de"));
  });
});
