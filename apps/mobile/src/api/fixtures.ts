// Fixture answers for the fixture build (EXPO_PUBLIC_FIXTURES=1): the web preview and screenshots
// run every screen with these, never against a real API. Shapes follow the route contract; the
// client parses them like any response. The business, people and figures are made up.
const T0 = Date.now();
const iso = (minsAgo: number) => new Date(T0 - minsAgo * 60_000).toISOString();

const TENANT = "0190a1b2-0000-7000-8000-00000000c001";
const USER = "0190a1b2-0000-7000-8000-00000000a001";

const poDisplay = {
  connectorName: "QuickBooks",
  tool: {
    name: "QuickBooks purchase order",
    description: "Sign and we email the order to the vendor and add it to QuickBooks.",
    number: "input.docNumber",
    subject: "input.vendor",
    fields: [
      { label: "Vendor", kind: "ref", after: "input.vendor" },
      {
        label: "Lines",
        kind: "lines",
        after: "input.lines",
        columns: {
          description: "description",
          qty: "qty",
          unitPrice: "unitPrice",
          amount: "amount",
        },
      },
      { label: "Total", kind: "money", after: "input.total", currency: "USD" },
    ],
  },
};

const items = [
  {
    id: "0190a1b2-0000-7000-8000-00000000b001",
    kind: "external_action",
    title: "Send PO 1042 to Hardwood Supply for $4,820.00",
    payload: {
      before: null,
      input: {
        docNumber: "1042",
        vendor: { id: "56", name: "Hardwood Supply" },
        lines: [
          {
            description: "Baltic birch 18 mm, 4×8",
            qty: "40",
            unitPrice: "78.50",
            amount: "3140.00",
          },
          {
            description: "Hardwood plywood 3/4 in.",
            qty: "12",
            unitPrice: "92.00",
            amount: "1104.00",
          },
          {
            description: "Maple edge banding, 250 ft",
            qty: "6",
            unitPrice: "96.00",
            amount: "576.00",
          },
        ],
        total: "4820.00",
      },
      whyApproval: { reasons: ["step", "matrix"] },
    },
    display: poDisplay,
    status: "open",
    runId: "0190a1b2-0000-7000-8000-00000000e001",
    dueAt: null,
    createdAt: iso(12),
    resolvedAt: null,
    resolvedBy: null,
    deliverAfter: null,
    snoozedUntil: null,
    batchKey: null,
    service: { id: "0190a1b2-0000-7000-8000-00000000f001", name: "Pia, Purchasing" },
  },
  {
    id: "0190a1b2-0000-7000-8000-00000000b002",
    kind: "request",
    title: "Two quotes for 1/2 in. birch plywood. Which vendor?",
    payload: {
      question: "60 sheets for request R-311. Both deliver Tuesday.",
      choices: [
        { value: "coastal", label: "Coastal Lumber, $39.80 a sheet" },
        { value: "hardwood", label: "Hardwood Supply, $41.20 a sheet" },
      ],
    },
    display: null,
    status: "open",
    runId: "0190a1b2-0000-7000-8000-00000000e002",
    dueAt: null,
    createdAt: iso(40),
    resolvedAt: null,
    resolvedBy: null,
    deliverAfter: null,
    snoozedUntil: null,
    batchKey: null,
    service: { id: "0190a1b2-0000-7000-8000-00000000f001", name: "Pia, Purchasing" },
  },
  {
    id: "0190a1b2-0000-7000-8000-00000000b003",
    kind: "external_action",
    title: "Ask Coastal Lumber to quote on request R-312",
    payload: {
      before: null,
      input: { to: "Coastal Lumber", lines: 4 },
      whyApproval: { reasons: ["stage"], stage: "trial" },
    },
    display: null,
    status: "open",
    runId: "0190a1b2-0000-7000-8000-00000000e003",
    dueAt: null,
    createdAt: iso(65),
    resolvedAt: null,
    resolvedBy: null,
    deliverAfter: null,
    snoozedUntil: null,
    batchKey: null,
    service: { id: "0190a1b2-0000-7000-8000-00000000f001", name: "Pia, Purchasing" },
  },
];

const snoozed = [
  { ...items[2], id: "0190a1b2-0000-7000-8000-00000000b004", snoozedUntil: iso(-60 * 24) },
];

let push = { on: true, every: "now", showClient: false };
let mine = { email: true, sms: false };

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function state(id: string, over: Record<string, unknown>) {
  return {
    item: {
      id,
      status: "open",
      deliverAfter: null,
      snoozedUntil: null,
      batchKey: null,
      resolvedAt: null,
      ...over,
    },
  };
}

export async function fixtureFetch(input: string, init: RequestInit): Promise<Response> {
  const url = new URL(input);
  const path = url.pathname;
  const method = (init.method ?? "GET").toUpperCase();
  const body =
    typeof init.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : {};

  if (path === "/api/session") {
    return json({
      user: { id: USER, email: "maria@northside.example", name: "Maria Chen" },
      operator: false,
      tenants: [{ id: TENANT, name: "Northside Millwork", role: "client_admin" }],
      activeTenantId: TENANT,
      language: { effective: "en", user: null, client: null },
      lead: { name: "Ana Navarro" },
    });
  }
  if (path === "/api/inbox" && method === "GET") {
    return json({ items: url.searchParams.get("view") === "snoozed" ? snoozed : items });
  }
  const resolve = /^\/api\/inbox\/([^/]+)\/resolve$/.exec(path);
  if (resolve) {
    const item = items.find((i) => i.id === resolve[1]) ?? items[0];
    const signed = body.decision === "approve" && item?.kind === "external_action";
    return json({
      item: {
        ...item,
        status: "resolved",
        resolvedAt: new Date().toISOString(),
        deliverAfter: signed ? new Date(Date.now() + 60_000).toISOString() : null,
        resolvedBy: { id: USER, name: "Maria Chen" },
      },
    });
  }
  const undo = /^\/api\/inbox\/([^/]+)\/undo$/.exec(path);
  if (undo?.[1]) return json(state(undo[1], {}));
  const snooze = /^\/api\/inbox\/([^/]+)\/snooze$/.exec(path);
  if (snooze?.[1]) return json(state(snooze[1], { snoozedUntil: body.until }));
  if (path === "/api/me/devices" && method === "GET") {
    return json({
      devices: [
        {
          id: "0190a1b2-0000-7000-8000-00000000d001",
          name: "Maria's iPhone",
          platform: "ios",
          push: true,
          signing: true,
          createdAt: iso(60 * 24 * 3),
          lastSeenAt: iso(0),
        },
        {
          id: "0190a1b2-0000-7000-8000-00000000d002",
          name: "iPad",
          platform: "ios",
          push: true,
          signing: false,
          createdAt: iso(60 * 24 * 40),
          lastSeenAt: iso(60 * 24 * 14),
        },
      ],
    });
  }
  if (path === "/api/me/devices" && method === "POST") {
    return json({
      device: {
        id: "0190a1b2-0000-7000-8000-00000000d001",
        name: String(body.name ?? "Phone"),
        platform: body.platform === "android" ? "android" : "ios",
        push: body.pushToken !== null,
        signing: body.publicKey !== null,
        createdAt: new Date().toISOString(),
        lastSeenAt: new Date().toISOString(),
      },
    });
  }
  if (path.startsWith("/api/me/devices/") && method === "DELETE") return json({ ok: true });
  if (path === "/api/settings/my-push") {
    if (method === "PUT") push = { ...push, ...(body as typeof push) };
    return json({ ...push, devices: 2 });
  }
  if (path === "/api/settings/my-notifications") {
    if (method === "PUT") mine = { ...mine, ...(body as typeof mine) };
    return json({ ...mine, canText: true, emailsOn: true });
  }
  if (path === "/api/threads" && method === "GET") {
    return json({
      lead: { name: "Ana Navarro" },
      threads: [
        {
          id: "0190a1b2-0000-7000-8000-0000000071a1",
          subject: "lead",
          service: null,
          startedBy: null,
          lastMessageAt: iso(90),
          unread: 1,
          createdAt: iso(60 * 24 * 30),
        },
      ],
    });
  }
  if (/^\/api\/threads\/[^/]+\/messages$/.test(path)) {
    const thread = {
      id: "0190a1b2-0000-7000-8000-0000000071a1",
      subject: "lead",
      service: null,
      startedBy: null,
      lastMessageAt: iso(90),
      unread: 0,
      createdAt: iso(60 * 24 * 30),
    };
    const message = (id: string, text: string, you: boolean, mins: number) => ({
      id,
      kind: "text",
      sender: {
        type: "user",
        name: you ? "Maria Chen" : "Ana Navarro",
        you,
        lead: !you,
      },
      text,
      command: null,
      sources: [],
      createdAt: iso(mins),
    });
    if (method === "POST") {
      return json({
        messages: [
          message("0190a1b2-0000-7000-8000-0000000072a9", String(body.text ?? ""), true, 0),
        ],
      });
    }
    return json({
      thread,
      messages: [
        message(
          "0190a1b2-0000-7000-8000-0000000072a1",
          "Can Pia order from Coastal when they are cheaper by more than 3%?",
          true,
          180,
        ),
        message(
          "0190a1b2-0000-7000-8000-0000000072a2",
          "Yes. From Monday she picks the cheaper of the two and asks you only above $2,500.",
          false,
          90,
        ),
      ],
    });
  }
  if (/^\/api\/threads\/[^/]+\/read$/.test(path)) return json({ ok: true });
  if (path === "/api/auth/sign-out") return json({ ok: true, redirectTo: null });
  return json({ error: { code: "not_found", message: `no fixture for ${method} ${path}` } }, 404);
}
