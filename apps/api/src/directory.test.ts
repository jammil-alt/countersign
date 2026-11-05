// The directory's routes (docs/plan.md §1.27) over a throwaway database: the operator and the client
// admin edit people and organizations, client users only read, another client sees nothing; the
// vendor link makes one entry per vendor; a CSV is previewed, then applied with a result per row;
// an agent's suggestion changes nothing until the client admin accepts it, and a suggested email
// applies only then; every change is logged.

import { dbDirectoryPort } from "@countersign/agents";
import {
  agent,
  contact,
  contactChange,
  inboxItem,
  organization,
  organizationChange,
  vendor,
} from "@countersign/db";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { admin, createApiHarness, OPERATOR, OTHER_OPERATOR, user } from "./api.test-helper";

const h = await createApiHarness();
afterAll(() => h?.close());

type Json = Record<string, unknown>;
type Org = Json & { id: string; name: string; kinds: string[]; vendor: Json | null };
type Person = Json & { id: string; name: string; organization: Json | null };

describe.skipIf(!h)("directory routes", () => {
  const H = h as NonNullable<typeof h>;
  const call = H.call.bind(H);
  const A = () => H.A.tenantId;
  const B = () => H.B.tenantId;
  let birch: Org;
  let pat: Person;
  let agentId = "";

  beforeAll(async () => {
    const [a] = await H.t.db
      .insert(agent)
      .values({ tenantId: A(), kind: "client", slug: "clerk", name: "Records clerk" })
      .returning();
    agentId = a?.id ?? "";
  });

  it("the client admin adds an organization and a person in it", async () => {
    const res = await call(admin("a"), "POST", "/api/directory/organizations", {
      name: "Birch & Co",
      kinds: ["vendor"],
      website: "birch.example.com",
    });
    expect(res.status).toBe(200);
    birch = (res.json as { organization: Org }).organization;
    expect(birch).toMatchObject({
      name: "Birch & Co",
      kinds: ["vendor"],
      website: "https://birch.example.com",
      source: "manual",
      vendor: null,
      people: 0,
    });
    const dup = await call(admin("a"), "POST", "/api/directory/organizations", {
      name: "birch & co",
    });
    expect(dup.status).toBe(409);

    const person = await call(admin("a"), "POST", "/api/contacts", {
      name: "Pat Lee",
      email: "pat@birch.example.com",
      organizationId: birch.id,
      title: "Sales rep",
      relationship: "vendor",
    });
    expect(person.status).toBe(200);
    pat = (person.json as { contact: Person }).contact;
    expect(pat).toMatchObject({
      organization: { id: birch.id, name: "Birch & Co" },
      title: "Sales rep",
      relationship: "vendor",
      source: "manual",
    });
  });

  it("client users read the directory, searched and filtered, but can't edit it", async () => {
    const list = await call(user("a"), "GET", "/api/directory?q=birch");
    expect(list.status).toBe(200);
    const body = list.json as { people: Person[]; organizations: Org[] };
    expect(body.people.map((p) => p.name)).toEqual(["Pat Lee"]);
    expect(body.organizations.map((o) => o.name)).toEqual(["Birch & Co"]);
    expect(body.organizations[0]?.people).toBe(1);
    const filtered = await call(user("a"), "GET", "/api/directory?relationship=employee");
    expect((filtered.json as { people: Person[] }).people).toEqual([]);

    expect(
      (await call(user("a"), "POST", "/api/directory/organizations", { name: "Oak" })).status,
    ).toBe(403);
    expect(
      (await call(user("a"), "PATCH", `/api/directory/organizations/${birch.id}`, { notes: "x" }))
        .status,
    ).toBe(403);
    expect((await call(user("a"), "PATCH", `/api/contacts/${pat.id}`, { title: "x" })).status).toBe(
      403,
    );
    expect((await call(user("a"), "GET", "/api/directory/suggestions")).status).toBe(403);
    expect(
      (await call(user("a"), "POST", "/api/directory/import/csv", { kind: "people", csv: "a" }))
        .status,
    ).toBe(403);
  });

  it("another client sees nothing of it and can't change it; nor can an operator who doesn't serve it", async () => {
    const theirs = await call(admin("b"), "GET", "/api/directory");
    expect(theirs.json).toMatchObject({ people: [], organizations: [] });
    expect(
      (await call(admin("b"), "PATCH", `/api/directory/organizations/${birch.id}`, { notes: "x" }))
        .status,
    ).toBe(404);
    expect(
      (await call(admin("b"), "POST", `/api/directory/organizations/${birch.id}/vendor`)).status,
    ).toBe(404);
    // B can't put its person in A's organization.
    const cross = await call(admin("b"), "POST", "/api/contacts", {
      name: "Sneaky",
      email: "sneaky@example.com",
      organizationId: birch.id,
    });
    expect(cross.status).toBe(422);
    expect((await call(OTHER_OPERATOR, "GET", `/api/ops/clients/${A()}/directory`)).status).toBe(
      404,
    );
    // The operator can't edit A's organization through B's path.
    expect(
      (
        await call(
          OPERATOR,
          "PATCH",
          `/api/ops/clients/${B()}/directory/organizations/${birch.id}`,
          {
            notes: "x",
          },
        )
      ).status,
    ).toBe(404);
  });

  it("the operator edits it too, and every change is logged with who made it", async () => {
    const res = await call(
      OPERATOR,
      "PATCH",
      `/api/ops/clients/${A()}/directory/organizations/${birch.id}`,
      { notes: "Delivers on Tuesdays", kinds: ["vendor", "customer"] },
    );
    expect(res.status).toBe(200);
    expect((res.json as { organization: Org }).organization.kinds).toEqual(["vendor", "customer"]);
    const log = await H.t.db
      .select()
      .from(organizationChange)
      .where(eq(organizationChange.organizationId, birch.id));
    expect(log.map((l) => (l.change as Json).kind)).toEqual(["created", "edited"]);
    expect((log[1]?.change as { changed: Json } | undefined)?.changed).toMatchObject({
      notes: { before: null, after: "Delivers on Tuesdays" },
    });
    expect(log[1]?.actorId).not.toBe(log[0]?.actorId);
  });

  it("links a vendor organization to one vendor record, made from its name", async () => {
    const res = await call(admin("a"), "POST", `/api/directory/organizations/${birch.id}/vendor`);
    expect(res.status).toBe(200);
    birch = (res.json as { organization: Org }).organization;
    expect(birch.vendor).toMatchObject({ name: "Birch & Co" });
    const vendors = await H.t.db.select().from(vendor).where(eq(vendor.tenantId, A()));
    expect(vendors.map((v) => v.normalizedName)).toEqual(["birch and"]);
    // Again: the same link, no second vendor.
    expect(
      (await call(admin("a"), "POST", `/api/directory/organizations/${birch.id}/vendor`)).status,
    ).toBe(200);
    // A second organization of the same vendor (by its normalized name) is refused.
    const other = await call(admin("a"), "POST", "/api/directory/organizations", {
      name: "Birch and Co.",
    });
    const otherId = (other.json as { organization: Org }).organization.id;
    const refused = await call(
      admin("a"),
      "POST",
      `/api/directory/organizations/${otherId}/vendor`,
    );
    expect(refused.status).toBe(409);
    expect((refused.json as { error: Json }).error.code).toBe("vendor_linked");
    expect((await H.t.db.select().from(vendor).where(eq(vendor.tenantId, A()))).length).toBe(1);
  });

  it("previews a CSV of people, then applies the chosen rows with a result per row", async () => {
    const csv = [
      "Name,Email,Phone,Company,Relationship,Title",
      "Pat Lee,pat@birch.example.com,+15550001111,Birch & Co,vendor,Account manager",
      "Dana Cruz,dana@oak.example.com,,Oak Mill,supplier,",
      "No Address,,,,,",
      "Bad Phone,bad@example.com,555-0100,,,",
      "Sam Ruiz,sam@pine.example.com,,,friend,",
    ].join("\n");
    const res = await call(admin("a"), "POST", "/api/directory/import/csv", {
      kind: "people",
      csv,
    });
    expect(res.status).toBe(200);
    const prev = res.json as { rows: (Json & { row: number; changes: Json[] })[]; counts: Json };
    expect(prev.rows.map((r) => r.action)).toEqual(["update", "add", "error", "error", "error"]);
    expect(prev.counts).toEqual({ add: 1, update: 1, same: 0, error: 3 });
    expect(prev.rows[0]).toMatchObject({
      match: { id: pat.id, by: "email" },
      changesAddress: true,
    });
    expect(prev.rows[0]?.changes.map((c) => c.field).sort()).toEqual(["phone", "title"]);
    // Nothing changed yet.
    const [before] = await H.t.db.select().from(contact).where(eq(contact.id, pat.id));
    expect(before?.phone).toBeNull();

    // Apply rows 2 to 5: row 1 is skipped.
    const applied = await call(admin("a"), "POST", "/api/directory/import/apply", {
      source: "csv",
      kind: "people",
      csv,
      rows: [2, 3, 4, 5],
    });
    expect(applied.status).toBe(200);
    const result = applied.json as { results: (Json & { status: string })[]; counts: Json };
    expect(result.results.map((r) => r.status)).toEqual([
      "skipped",
      "added",
      "failed",
      "failed",
      "failed",
    ]);
    expect(result.counts).toEqual({ added: 1, updated: 0, unchanged: 0, skipped: 1, failed: 3 });
    const [dana] = await H.t.db
      .select()
      .from(contact)
      .where(and(eq(contact.tenantId, A()), eq(contact.email, "dana@oak.example.com")));
    expect(dana).toMatchObject({ source: "csv", relationship: "vendor" });
    const [oak] = await H.t.db
      .select()
      .from(organization)
      .where(and(eq(organization.tenantId, A()), eq(organization.name, "Oak Mill")));
    expect(oak).toMatchObject({ kinds: ["vendor"], source: "csv" });
    expect(dana?.organizationId).toBe(oak?.id);
    const logs = await H.t.db
      .select()
      .from(contactChange)
      .where(eq(contactChange.contactId, dana?.id ?? ""));
    expect(logs[0]?.change).toMatchObject({ kind: "created", from: "csv", import: "csv", row: 2 });
  });

  it("refuses a CSV without a name column", async () => {
    const res = await call(admin("a"), "POST", "/api/directory/import/csv", {
      kind: "people",
      csv: "Email\na@b.com",
    });
    expect(res.status).toBe(422);
    expect((res.json as { error: Json }).error.code).toBe("invalid_csv");
  });

  it("an agent's suggestion changes nothing until the client admin accepts it", async () => {
    const port = dbDirectoryPort(H.db);
    const made = await port.suggest(A(), {
      agentId,
      agentVersionId: "v",
      runId: "r",
      test: false,
      suggestion: {
        suggestion: {
          action: "update_person",
          contactId: pat.id,
          changes: { email: "pat.lee@birch.example.com", title: "Account manager" },
        },
        reason: "Her last two invoices came from this address.",
        sources: ["doc-1"],
      },
    });
    expect(made.status).toBe("suggested");
    // The same change again: no second item.
    const again = await port.suggest(A(), {
      agentId,
      agentVersionId: "v",
      runId: "r2",
      test: false,
      suggestion: {
        suggestion: {
          action: "update_person",
          contactId: pat.id,
          changes: { email: "pat.lee@birch.example.com", title: "Account manager" },
        },
        reason: "Again.",
        sources: [],
      },
    });
    expect(again).toEqual({ status: "duplicate", inboxItemId: made.inboxItemId });
    const [item] = await H.t.db
      .select()
      .from(inboxItem)
      .where(eq(inboxItem.id, made.inboxItemId ?? ""));
    expect(item).toMatchObject({ assigneeRole: "client_admin", kind: "review", runId: null });

    // Nothing applied yet.
    const [still] = await H.t.db.select().from(contact).where(eq(contact.id, pat.id));
    expect(still?.email).toBe("pat@birch.example.com");

    const list = await call(admin("a"), "GET", "/api/directory/suggestions");
    const items = (list.json as { items: (Json & { id: string })[] }).items;
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      status: "open",
      changesAddress: true,
      target: { id: pat.id, name: "Pat Lee" },
      agent: { id: agentId, name: "Records clerk" },
      reason: "Her last two invoices came from this address.",
    });
    expect((items[0]?.diff as Json[] | undefined)?.find((d) => d.field === "email")).toEqual({
      field: "email",
      before: "pat@birch.example.com",
      after: "pat.lee@birch.example.com",
    });
    expect(
      ((await call(admin("a"), "GET", "/api/directory")).json as Json).pendingSuggestions,
    ).toBe(1);

    // A client user can't decide it; another client can't see it.
    expect(
      (
        await call(user("a"), "POST", `/api/directory/suggestions/${made.inboxItemId}`, {
          decision: "approve",
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await call(admin("b"), "POST", `/api/directory/suggestions/${made.inboxItemId}`, {
          decision: "approve",
        })
      ).status,
    ).toBe(404);

    const ok = await call(admin("a"), "POST", `/api/directory/suggestions/${made.inboxItemId}`, {
      decision: "approve",
    });
    expect(ok.status).toBe(200);
    expect((ok.json as { suggestion: Json }).suggestion.status).toBe("accepted");
    const [after] = await H.t.db.select().from(contact).where(eq(contact.id, pat.id));
    expect(after).toMatchObject({ email: "pat.lee@birch.example.com", title: "Account manager" });
    const logs = await H.t.db
      .select()
      .from(contactChange)
      .where(eq(contactChange.contactId, pat.id));
    expect(logs.at(-1)?.change).toMatchObject({
      kind: "edited",
      suggestion: made.inboxItemId,
      agentId,
      changed: { email: { before: "pat@birch.example.com", after: "pat.lee@birch.example.com" } },
    });
  });

  it("a declined suggestion changes nothing; an accepted addition adds the person without consent", async () => {
    const port = dbDirectoryPort(H.db);
    const declined = await port.suggest(A(), {
      agentId,
      agentVersionId: "v",
      runId: "r3",
      test: false,
      suggestion: {
        suggestion: {
          action: "update_person",
          contactId: pat.id,
          changes: { phone: "+15550002222" },
        },
        reason: "Seen on a quote.",
        sources: [],
      },
    });
    const no = await call(
      OPERATOR,
      "POST",
      `/api/ops/clients/${A()}/directory/suggestions/${declined.inboxItemId}`,
      {
        decision: "reject",
      },
    );
    expect(no.status).toBe(200);
    expect((no.json as { suggestion: Json }).suggestion.status).toBe("declined");
    const [same] = await H.t.db.select().from(contact).where(eq(contact.id, pat.id));
    expect(same?.phone).toBeNull();

    const add = await port.suggest(A(), {
      agentId,
      agentVersionId: "v",
      runId: "r4",
      test: false,
      suggestion: {
        suggestion: {
          action: "add_person",
          person: { name: "Lou Park", email: "lou@birch.example.com", organizationId: birch.id },
        },
        reason: "Signed the delivery note.",
        sources: [],
      },
    });
    // Through the inbox's own resolve, as the inbox card does.
    const res = await call(admin("a"), "POST", `/api/inbox/${add.inboxItemId}/resolve`, {
      decision: "approve",
    });
    expect(res.status).toBe(200);
    const [lou] = await H.t.db
      .select()
      .from(contact)
      .where(and(eq(contact.tenantId, A()), eq(contact.email, "lou@birch.example.com")));
    expect(lou).toMatchObject({ source: "agent", organizationId: birch.id, consent: {} });
  });

  it("a suggested language, the person's or their organization's, applies only on acceptance", async () => {
    const port = dbDirectoryPort(H.db);
    // Lou (added above, no language) gets Birch's language once Birch has one, by acceptance.
    const org = await port.suggest(A(), {
      agentId,
      agentVersionId: "v",
      runId: "r7",
      test: false,
      suggestion: {
        suggestion: {
          action: "update_organization",
          organizationId: birch.id,
          changes: { language: "es" },
        },
        reason: "Their invoices are in Spanish.",
        sources: [],
      },
    });
    const [lou] = await H.t.db
      .select()
      .from(contact)
      .where(and(eq(contact.tenantId, A()), eq(contact.email, "lou@birch.example.com")));
    const view = async () =>
      (
        (await call(admin("a"), "GET", "/api/directory?q=lou")).json as {
          people: (Person & { languageUsed: Json })[];
        }
      ).people[0]?.languageUsed;
    expect(await view()).toEqual({ language: "en", from: "default" });
    const items = (
      (await call(admin("a"), "GET", "/api/directory/suggestions")).json as { items: Json[] }
    ).items;
    expect(items.find((i) => i.id === org.inboxItemId)).toMatchObject({ changesAddress: true });
    expect(
      (
        await call(admin("a"), "POST", `/api/directory/suggestions/${org.inboxItemId}`, {
          decision: "approve",
        })
      ).status,
    ).toBe(200);
    expect(await view()).toEqual({
      language: "es",
      from: "organization",
      organization: "Birch & Co",
    });

    // The person's own language wins, again only once accepted.
    const own = await port.suggest(A(), {
      agentId,
      agentVersionId: "v",
      runId: "r8",
      test: false,
      suggestion: {
        suggestion: {
          action: "update_person",
          contactId: lou?.id ?? "",
          changes: { language: "fr" },
        },
        reason: "Lou wrote back in French.",
        sources: [],
      },
    });
    expect(await view()).toMatchObject({ language: "es" });
    await call(admin("a"), "POST", `/api/directory/suggestions/${own.inboxItemId}`, {
      decision: "approve",
    });
    expect(await view()).toEqual({ language: "fr", from: "person" });
    const logs = await H.t.db
      .select()
      .from(contactChange)
      .where(eq(contactChange.contactId, lou?.id ?? ""));
    expect(logs.at(-1)?.change).toMatchObject({
      suggestion: own.inboxItemId,
      changed: { language: { before: null, after: "fr" } },
    });
  });

  it("a test run's suggestion is checked but makes nothing; a suggestion about another client's person is refused", async () => {
    const port = dbDirectoryPort(H.db);
    const test = await port.suggest(A(), {
      agentId,
      agentVersionId: "v",
      runId: "r5",
      test: true,
      suggestion: {
        suggestion: { action: "add_organization", organization: { name: "Elm Yard" } },
        reason: "x",
        sources: [],
      },
    });
    expect(test).toEqual({ status: "test_run", inboxItemId: null });
    await expect(
      port.suggest(B(), {
        agentId,
        agentVersionId: "v",
        runId: "r6",
        test: false,
        suggestion: {
          suggestion: { action: "update_person", contactId: pat.id, changes: { title: "x" } },
          reason: "x",
          sources: [],
        },
      }),
    ).rejects.toThrow(/no such person/);
  });
});
