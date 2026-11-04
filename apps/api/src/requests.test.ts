// Requests (ARCHITECTURE §1 item 7, §11): a client raises one from the portal, it lands in the
// operator's queue (never the client's inbox), and the operator resolves it as done, with the
// versions made for it, or declined, with a note. The client reads the outcome, the note and which
// of its own services changed, never a template.

import { agent, event, inboxItem } from "@countersign/db";
import { and, eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import {
  admin,
  createApiHarness,
  OPERATOR,
  OTHER_OPERATOR,
  testBundle,
  user,
} from "./api.test-helper";
import { requestTitle } from "./routes/requests";

const h = await createApiHarness();
afterAll(() => h?.close());

type Json = Record<string, unknown>;
type Req = Json & { id: string; status: string; changes?: Json[]; links?: Json[] };

describe("requestTitle", () => {
  it("uses the subject, else the first non-empty line, clipped", () => {
    expect(requestTitle("Add a vendor", "long text")).toBe("Add a vendor");
    expect(requestTitle(undefined, "\n  Skip approvals under $200 \nfor Acme")).toBe(
      "Skip approvals under $200",
    );
    const long = requestTitle(undefined, "x".repeat(200));
    expect(long).toHaveLength(80);
    expect(long.endsWith("…")).toBe(true);
  });
});

describe.skipIf(!h)("requests", () => {
  const H = h as NonNullable<typeof h>;
  const call = H.call.bind(H);
  let intake: { id: string; versionId: string };

  /** A client agent of client A that the portal lists as a service. */
  async function service(slug: string, serviceName: string) {
    const created = await call(OPERATOR, "POST", `/api/ops/clients/${H.A.tenantId}/agents`, {
      slug,
      bundle: testBundle(),
    });
    expect(created.status).toBe(200);
    const body = created.json as { agent: Json; version: Json };
    const id = body.agent.id as string;
    await H.t.db.update(agent).set({ runStatus: "active", serviceName }).where(eq(agent.id, id));
    return { id, versionId: body.version.id as string };
  }

  async function raise(email: string, body: Json) {
    return call(email, "POST", "/api/requests", body);
  }

  it("lets client admins and users raise a request about a service or anything", async () => {
    const svc = await service("intake-a", "Invoice intake");
    intake = svc;
    const one = await raise(admin("a"), {
      subject: "Add Acme as a vendor",
      text: "We started buying from Acme Lumber.\nPlease watch their prices too.",
      serviceId: svc.id,
    });
    expect(one.status).toBe(200);
    expect((one.json as { item: Req }).item).toMatchObject({
      subject: "Add Acme as a vendor",
      service: { id: svc.id, name: "Invoice intake" },
      status: "open",
      note: null,
      changes: [],
    });
    const two = await raise(user("a"), { text: "Can you also chase late payments?" });
    expect(two.status).toBe(200);
    expect((two.json as { item: Req }).item).toMatchObject({
      subject: "Can you also chase late payments?",
      service: null,
      raisedBy: { name: "Client A user" },
    });

    // Stored as the operator's inbox item, so the client's inbox never shows it.
    const stored = await H.t.db
      .select()
      .from(inboxItem)
      .where(and(eq(inboxItem.tenantId, H.A.tenantId), eq(inboxItem.kind, "change_request")));
    expect(stored).toHaveLength(2);
    expect(stored.every((r) => r.assigneeRole === "operator")).toBe(true);
    const inbox = await call(admin("a"), "GET", "/api/inbox");
    expect((inbox.json as { items: Json[] }).items.some((i) => i.kind === "change_request")).toBe(
      false,
    );
  });

  it("refuses an empty request, extra fields and a service that isn't the client's", async () => {
    expect((await raise(admin("a"), { text: "  " })).status).toBe(400);
    expect((await raise(admin("a"), { text: "x", bundle: {} })).status).toBe(400);
    // Client B's agent is not a service of client A.
    const created = await call(OPERATOR, "POST", `/api/ops/clients/${H.B.tenantId}/agents`, {
      slug: "intake-b",
      bundle: testBundle(),
    });
    const other = (created.json as { agent: Json }).agent.id as string;
    await H.t.db.update(agent).set({ runStatus: "active" }).where(eq(agent.id, other));
    expect((await raise(admin("a"), { text: "x", serviceId: other })).status).toBe(404);
    // A draft agent is not a service yet.
    const draft = await call(OPERATOR, "POST", `/api/ops/clients/${H.A.tenantId}/agents`, {
      slug: "draft-a",
      bundle: testBundle(),
    });
    const draftId = (draft.json as { agent: Json }).agent.id as string;
    expect((await raise(admin("a"), { text: "x", serviceId: draftId })).status).toBe(404);
    // Operators raise nothing through the portal.
    expect((await raise(OPERATOR, { text: "x" })).status).toBe(403);
  });

  it("shows client users their own requests and the client admin everyone's", async () => {
    const asAdmin = await call(admin("a"), "GET", "/api/requests");
    const asUser = await call(user("a"), "GET", "/api/requests");
    const adminItems = (asAdmin.json as { items: Req[] }).items;
    const userItems = (asUser.json as { items: Req[] }).items;
    expect(adminItems.map((i) => i.subject)).toEqual([
      "Can you also chase late payments?",
      "Add Acme as a vendor",
    ]);
    expect(userItems.map((i) => i.subject)).toEqual(["Can you also chase late payments?"]);
    // Another client sees none of them.
    expect((await call(admin("b"), "GET", "/api/requests")).json).toEqual({ items: [] });
  });

  it("lists the queue for the clients the operator serves", async () => {
    await raise(admin("c"), { text: "Client C wants a report" });
    const queue = await call(OPERATOR, "GET", "/api/ops/requests");
    const items = (queue.json as { items: Req[] }).items;
    expect(items.map((i) => (i.client as Json).name)).toEqual(["Client A", "Client A"]);
    expect(items[1]).toMatchObject({
      agent: { slug: "intake-a", serviceName: "Invoice intake" },
      raisedBy: { email: "admin@a.example.com" },
      status: "open",
      text: "We started buying from Acme Lumber.\nPlease watch their prices too.",
    });
    const other = await call(OTHER_OPERATOR, "GET", "/api/ops/requests");
    expect((other.json as { items: Req[] }).items.map((i) => i.subject)).toEqual([
      "Client C wants a report",
    ]);
    // A client the operator doesn't serve is not a filter they can use.
    const refused = await call(OPERATOR, "GET", `/api/ops/requests?client=${H.C.tenantId}`);
    expect(refused.status).toBe(403);
    const filtered = await call(OPERATOR, "GET", `/api/ops/requests?client=${H.B.tenantId}`);
    expect((filtered.json as { items: Req[] }).items).toEqual([]);
  });

  it("is resolved in the queue, not through the inbox", async () => {
    const queue = await call(OPERATOR, "GET", "/api/ops/requests");
    const id = (queue.json as { items: Req[] }).items[0]?.id as string;
    const res = await call(OPERATOR, "POST", `/api/ops/inbox/${id}/resolve`, {
      decision: "approve",
    });
    expect(res.status).toBe(409);
    expect((res.json as { error: { code: string } }).error.code).toBe("use_requests");
  });

  it("resolves as done with the versions made for it; the client sees its services only", async () => {
    const queue = await call(OPERATOR, "GET", "/api/ops/requests");
    const acme = (queue.json as { items: Req[] }).items.find(
      (i) => i.subject === "Add Acme as a vendor",
    ) as Req;
    const svc = (acme.agent as Json).id as string;
    expect(svc).toBe(intake.id);
    const clientVersion = intake.versionId;
    const template = await call(OPERATOR, "POST", "/api/ops/templates", {
      slug: "vendor-watch",
      bundle: testBundle("Vendor watch"),
    });
    const templateVersion = (template.json as { version: Json }).version.id as string;

    // Neither a note nor a link: nothing says what was done.
    const bare = await call(OPERATOR, "POST", `/api/ops/requests/${acme.id}/resolve`, {});
    expect(bare.status).toBe(400);
    // Another client's version is refused.
    const bOther = await call(OPERATOR, "POST", `/api/ops/clients/${H.B.tenantId}/agents`, {
      slug: "intake-b2",
      bundle: testBundle(),
    });
    const bVersion = (bOther.json as { version: Json }).version.id as string;
    const wrong = await call(OPERATOR, "POST", `/api/ops/requests/${acme.id}/resolve`, {
      links: [bVersion],
    });
    expect(wrong.status).toBe(422);
    expect((wrong.json as { error: { code: string } }).error.code).toBe("invalid_link");
    // Another operator can't resolve it.
    const notTheirs = await call(OTHER_OPERATOR, "POST", `/api/ops/requests/${acme.id}/resolve`, {
      note: "x",
    });
    expect(notTheirs.status).toBe(404);

    const done = await call(OPERATOR, "POST", `/api/ops/requests/${acme.id}/resolve`, {
      note: "Acme is on the vendor list now.",
      links: [clientVersion, templateVersion],
    });
    expect(done.status).toBe(200);
    const item = (done.json as { item: Req }).item;
    expect(item).toMatchObject({
      status: "done",
      note: "Acme is on the vendor list now.",
      resolvedBy: { email: OPERATOR },
    });
    expect(item.links?.map((l) => [l.kind, l.slug])).toEqual([
      ["client", "intake-a"],
      ["template", "vendor-watch"],
    ]);

    // Once only.
    const again = await call(OPERATOR, "POST", `/api/ops/requests/${acme.id}/resolve`, {
      note: "again",
    });
    expect(again.status).toBe(409);

    // inbox.resolved, as for any item.
    const events = await H.t.db.select().from(event).where(eq(event.subjectId, acme.id));
    expect(events.map((e) => [e.type, (e.payload as Json).approved])).toEqual([
      ["inbox.resolved", true],
    ]);

    // The client sees the note and its own service's version; the template stays in the back office.
    const portal = await call(admin("a"), "GET", "/api/requests?status=resolved");
    const seen = (portal.json as { items: Req[] }).items;
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      status: "done",
      note: "Acme is on the vendor list now.",
      changes: [{ service: { id: svc, name: "Invoice intake" }, version: 1 }],
    });
    expect(JSON.stringify(seen)).not.toContain("vendor-watch");
    expect(JSON.stringify(seen)).not.toContain("intake-a");
  });

  it("declines with a note, and needs one", async () => {
    const queue = await call(OPERATOR, "GET", "/api/ops/requests");
    const chase = (queue.json as { items: Req[] }).items[0] as Req;
    const path = `/api/ops/requests/${chase.id}/resolve`;
    expect((await call(OPERATOR, "POST", path, { outcome: "declined" })).status).toBe(400);
    const declined = await call(OPERATOR, "POST", path, {
      outcome: "declined",
      note: "Collections aren't part of your plan yet.",
    });
    expect(declined.status).toBe(200);
    expect((declined.json as { item: Req }).item.status).toBe("declined");
    const mine = await call(user("a"), "GET", "/api/requests");
    expect((mine.json as { items: Req[] }).items[0]).toMatchObject({
      status: "declined",
      note: "Collections aren't part of your plan yet.",
    });
    // The queue's default view is what is still open.
    const open = await call(OPERATOR, "GET", "/api/ops/requests");
    expect((open.json as { items: Req[] }).items).toEqual([]);
    const all = await call(OPERATOR, "GET", "/api/ops/requests?status=all");
    expect((all.json as { items: Req[] }).items.map((i) => i.status)).toEqual(["declined", "done"]);
  });
});
