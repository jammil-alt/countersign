// P-8: `/settings/texting` (docs/plan.md §1.70): the client admin gives the business details and
// the EIN (sent once, then shown only as a hint); what Twilio asked for is shown in plain words; a
// client user is told only the admin gives them; nothing in the screen names a SID or an amount.
// The back office's review: the fees, a required reason and the confirmation before submitting.
import { a2pRelationshipOptIn } from "@countersign/core";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { AppProviders, AppRoutes } from "../../App";
import { CLIENT_SESSION, fakeApi, OPERATOR_SESSION } from "../../test/fixtures";

const DEMO = "00000000-0000-4000-8000-00000000a002";

const DETAILS = {
  legalName: "Demo Millwork LLC",
  businessType: "Limited Liability Corporation",
  industry: "MANUFACTURING",
  companyType: "private",
  website: "https://demo.example.com",
  regions: ["USA_AND_CANADA"],
  address: {
    street: "100 Main St",
    city: "Austin",
    region: "TX",
    postalCode: "78701",
    country: "US",
  },
  representative: {
    firstName: "Dana",
    lastName: "Kim",
    title: "Owner",
    position: "CEO",
    phone: "+15125550199",
    email: "dana@demo.example.com",
  },
  volume: "low",
  uses: ["team", "vendors"],
  optIn: "Our team and vendors give us their number on our form and agree to texts from us.",
  privacyPolicyUrl: "https://demo.example.com/privacy",
  termsUrl: "https://demo.example.com/terms",
  hasLinks: false,
  hasPhoneNumbers: false,
};

const view = (over: Record<string, unknown> = {}) => ({
  registration: {
    available: true,
    stage: "draft",
    details: null,
    einSet: false,
    einHint: null,
    editable: true,
    needs: [],
    updatedAt: null,
    ...over,
  },
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

describe("portal US texting registration", () => {
  it("saves the details with the EIN once, then shows only its hint", async () => {
    let current = view({ details: DETAILS });
    const puts: Record<string, unknown>[] = [];
    const api = fakeApi({
      "GET /api/session": () => CLIENT_SESSION,
      "GET /api/texting-registration": () => current,
      "PUT /api/texting-registration": ({ init }) => {
        const body = JSON.parse(String(init.body));
        puts.push(body);
        current = view({ details: body.details, einSet: true, einHint: "••-•••••89" });
        return current;
      },
    });
    renderAt("/settings/texting", api);
    expect(await screen.findByTestId("portal-texting-stage")).toHaveTextContent(
      "Waiting on your details",
    );
    await waitFor(() =>
      expect(screen.getByTestId("portal-texting-legal-name")).toHaveValue("Demo Millwork LLC"),
    );
    await userEvent.type(screen.getByTestId("portal-texting-ein"), "12-3456789");
    await userEvent.click(screen.getByTestId("portal-texting-use-customer_care"));
    await userEvent.click(screen.getByTestId("portal-texting-save"));
    await screen.findByTestId("portal-texting-saved");
    expect(puts[0]).toMatchObject({
      ein: "12-3456789",
      details: { legalName: "Demo Millwork LLC", uses: ["team", "vendors", "customer_care"] },
    });
    // The field is cleared and the hint is all that is shown.
    await waitFor(() => expect(screen.getByTestId("portal-texting-ein")).toHaveValue(""));
    expect(
      screen.getByText("Saved (••-•••••89). Enter it again only to replace it."),
    ).toBeInTheDocument();
    expect(document.body.textContent).not.toContain("3456789");
  });

  // §1.97: "how people agree" starts from the relationship wording until the admin writes their own.
  it("prefills the relationship wording with the business name, and puts it back after an edit", async () => {
    const api = fakeApi({
      "GET /api/session": () => CLIENT_SESSION,
      "GET /api/texting-registration": () => view(),
    });
    renderAt("/settings/texting", api);
    const optIn = await screen.findByTestId("portal-texting-opt-in");
    expect(optIn).toHaveValue(a2pRelationshipOptIn(""));

    await userEvent.type(screen.getByTestId("portal-texting-legal-name"), "Rivera Supply");
    expect(optIn).toHaveValue(a2pRelationshipOptIn("Rivera Supply"));
    expect((optIn as HTMLTextAreaElement).value).toContain("https://mezonas.com/sms-terms#opt-in");

    await userEvent.clear(optIn);
    await userEvent.type(optIn, "People sign up on our website form and agree to texts from us.");
    expect(optIn).toHaveValue("People sign up on our website form and agree to texts from us.");
    // Typing the name again no longer rewrites the admin's own words.
    await userEvent.type(screen.getByTestId("portal-texting-legal-name"), " LLC");
    expect(optIn).toHaveValue("People sign up on our website form and agree to texts from us.");

    await userEvent.click(screen.getByTestId("portal-texting-opt-in-relationship"));
    expect(optIn).toHaveValue(a2pRelationshipOptIn("Rivera Supply LLC"));
  });

  it("shows what Twilio asked for, and locks the form while Twilio has it", async () => {
    const api = fakeApi({
      "GET /api/session": () => CLIENT_SESSION,
      "GET /api/texting-registration": () =>
        view({
          stage: "needs_changes",
          details: DETAILS,
          einSet: true,
          einHint: "••-•••••89",
          needs: ["Tax ID does not match the legal name. Check the legal name."],
        }),
    });
    renderAt("/settings/texting", api);
    expect(await screen.findByTestId("portal-texting-needs")).toHaveTextContent(
      "Check the legal name.",
    );
    expect(screen.getByTestId("portal-texting-form")).toBeInTheDocument();

    const locked = fakeApi({
      "GET /api/session": () => CLIENT_SESSION,
      "GET /api/texting-registration": () =>
        view({ stage: "submitted", details: DETAILS, einSet: true, editable: false }),
    });
    renderAt("/settings/texting", locked);
    expect(await screen.findByTestId("portal-texting-locked")).toHaveTextContent(
      "Your details are with Twilio now.",
    );
  });

  it("says texting isn't set up, and tells a client user only the admin gives the details", async () => {
    const api = fakeApi({
      "GET /api/session": () => CLIENT_SESSION,
      "GET /api/texting-registration": () => view({ available: false }),
    });
    renderAt("/settings/texting", api);
    expect(await screen.findByText(/Texting isn't set up for you yet/)).toBeInTheDocument();

    const member = fakeApi({
      "GET /api/session": () => ({
        ...CLIENT_SESSION,
        tenants: [{ id: DEMO, name: "Demo client", role: "client_user" }],
      }),
    });
    renderAt("/settings/texting", member);
    expect(
      await screen.findByText("Your admin gives the business details for US texting."),
    ).toBeInTheDocument();
    expect(member.calls).not.toContain("GET /api/texting-registration");
  });
});

describe("back office review of US texting registration", () => {
  it("shows the fees and submits only with a reason and the fees confirmed", async () => {
    const registration = {
      stage: "draft",
      details: DETAILS,
      detailsUpdatedAt: "2026-11-08T12:00:00.000Z",
      einSet: true,
      einHint: "••-•••••89",
      missing: [],
      brandType: "low_volume",
      useCase: "LOW_VOLUME",
      campaign: {
        description:
          "Demo Millwork LLC sends its own operational texts. No marketing or promotional messages are sent.",
        samples: [
          "Demo Millwork LLC: Mezonas code: [code]. Reply STOP to opt out.",
          "Hi [vendor], this is [agent] for Demo Millwork LLC. Reply STOP to opt out.",
        ],
        messageFlow: "Our team and vendors give us their number on our form and agree to texts.",
      },
      campaignEdited: false,
      statuses: { customerProfile: null, trustProduct: null, brand: null, campaign: null },
      sids: { customerProfile: null, trustProduct: null, brand: null, messagingService: null },
      issues: [],
      fees: {
        lines: [
          {
            kind: "brand",
            label: "Brand registration (Low-Volume Standard), one time",
            amountUsd: "4.0000",
            monthly: false,
          },
          {
            kind: "vetting",
            label: "Campaign vetting, one time",
            amountUsd: "15.0000",
            monthly: false,
          },
          {
            kind: "monthly",
            label: "Campaign fee (LOW_VOLUME), every month once approved",
            amountUsd: "1.5000",
            monthly: true,
          },
        ],
        nowUsd: "19.0000",
      },
      recorded: [],
      submissions: [],
      brandUpdates: 0,
      campaignAttempts: 0,
      serviceNumbers: [],
      updatedAt: null,
    };
    const setup = {
      available: true,
      timezone: "America/Chicago",
      quietHours: { start: "21:00", end: "08:00" },
      twilio: {
        connectionId: "00000000-0000-4000-8000-0000000e0001",
        status: "connected",
        subaccountSid: `AC${"1".repeat(32)}`,
        numbers: [],
        a2p: {
          brandSid: null,
          messagingServiceSid: null,
          brandStatus: null,
          campaignStatus: null,
          status: "not_started",
          checkedAt: null,
        },
        registration,
      },
      webhooks: {
        messages: `https://app.mezonas.test/api/twilio/${DEMO}/messages`,
        status: `https://app.mezonas.test/api/twilio/${DEMO}/status`,
      },
    };
    const submits: unknown[] = [];
    const api = fakeApi({
      "GET /api/session": () => OPERATOR_SESSION,
      [`GET /api/ops/clients/${DEMO}`]: () => ({
        client: { id: DEMO, name: "Demo client", timezone: "America/Chicago" },
        agents: [],
      }),
      [`GET /api/ops/clients/${DEMO}/messaging`]: () => ({ setup }),
      [`GET /api/ops/clients/${DEMO}/contacts`]: () => ({ items: [] }),
      [`POST /api/ops/clients/${DEMO}/messaging/a2p/submit`]: ({ init }) => {
        submits.push(JSON.parse(String(init.body)));
        return {
          setup: {
            ...setup,
            twilio: { ...setup.twilio, registration: { ...registration, stage: "submitted" } },
          },
        };
      },
    });
    renderAt(`/ops/clients/${DEMO}/messaging`, api);
    expect(await screen.findByTestId("ops-a2p-fees-now")).toHaveTextContent("$19.00");
    expect(screen.getByTestId("ops-a2p-ein")).toHaveTextContent("••-•••••89");
    const submit = screen.getByTestId("ops-a2p-submit");
    expect(submit).toBeDisabled();
    await userEvent.type(screen.getByTestId("ops-a2p-reason"), "Details checked with the client");
    expect(submit).toBeDisabled();
    await userEvent.click(screen.getByTestId("ops-a2p-confirm"));
    expect(submit).toBeEnabled();
    await userEvent.click(submit);
    await waitFor(() => expect(submits).toHaveLength(1));
    expect(submits[0]).toEqual({ reason: "Details checked with the client", confirmFees: true });
    expect(await screen.findByTestId("ops-a2p-stage")).toHaveTextContent("With Twilio");
  });
});
