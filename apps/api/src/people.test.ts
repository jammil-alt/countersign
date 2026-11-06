// People (ARCHITECTURE v0.12 §1, §6.1, §6.4; docs/plan.md §1.42) through the API, over a throwaway
// database: a person's autonomy per channel (the client admin sets off or approval and only
// tightens, a client admin's `auto` is a 403, the operator sets anything, every change logged);
// voice samples pasted in the portal and the back office, kept apart from FAQs and never edited as
// one; a `+voice` email routed by the Worker's email() before forwarding; QuickBooks vendors
// imported into the directory as a preview, then applied with their QuickBooks id.

import { connection, contactChange, organization, rawRecord } from "@countersign/db";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { admin, createApiHarness, OPERATOR, user } from "./api.test-helper";
import { handleEmail } from "./email";
import { defaultDeps } from "./http";

const FORWARDING = "in.mezonas.test";
const h = await createApiHarness({ env: { EMAIL_FORWARDING_DOMAIN: FORWARDING } });
afterAll(() => h?.close());

// biome-ignore lint/suspicious/noExplicitAny: response bodies are read loosely in tests.
type J = any;

describe.skipIf(!h)("people", () => {
  const H = h as NonNullable<typeof h>;
  const call = H.call.bind(H);
  const A = () => H.A.tenantId;
  let patId = "";

  beforeAll(async () => {
    const res = await call(admin("a"), "POST", "/api/contacts", {
      name: "Pat Lee",
      email: "pat@birch.example.com",
      phone: "+15555550100",
    });
    patId = (res.json as J).contact.id;
    expect((res.json as J).contact.autonomy).toEqual({});
  });

  describe("autonomy", () => {
    it("the client admin turns a channel off or to approval, and it's logged", async () => {
      const res = await call(admin("a"), "PUT", `/api/contacts/${patId}/autonomy`, {
        autonomy: { email: "off", sms: "approval" },
      });
      expect(res.status).toBe(200);
      expect((res.json as J).contact.autonomy).toEqual({ email: "off", sms: "approval" });
      const log = await H.t.db
        .select()
        .from(contactChange)
        .where(eq(contactChange.contactId, patId));
      expect(log.at(-1)?.change).toEqual({
        kind: "autonomy",
        before: {},
        after: { email: "off", sms: "approval" },
        by: "client",
      });
    });

    it("refuses a client admin's loosening and any `auto` with 403 loosening", async () => {
      const loosen = await call(admin("a"), "PUT", `/api/contacts/${patId}/autonomy`, {
        autonomy: { email: "approval", sms: "approval" },
      });
      expect(loosen.status).toBe(403);
      expect((loosen.json as J).error.code).toBe("loosening");
      const auto = await call(admin("a"), "PUT", `/api/contacts/${patId}/autonomy`, {
        autonomy: { email: "off", sms: "approval", voice: "auto" },
      });
      expect(auto.status).toBe(403);
      expect((auto.json as J).error.code).toBe("loosening");
      const bad = await call(admin("a"), "PUT", `/api/contacts/${patId}/autonomy`, {
        autonomy: { fax: "off" },
      });
      expect(bad.status).toBe(400);
      // Client users don't set it at all.
      const asUser = await call(user("a"), "PUT", `/api/contacts/${patId}/autonomy`, {
        autonomy: { email: "off" },
      });
      expect(asUser.status).toBe(403);
    });

    it("the operator sets `auto` and loosens; another client can't reach the contact", async () => {
      const res = await call(
        OPERATOR,
        "PUT",
        `/api/ops/clients/${A()}/contacts/${patId}/autonomy`,
        {
          autonomy: { email: "auto", sms: "approval" },
        },
      );
      expect(res.status).toBe(200);
      expect((res.json as J).contact.autonomy).toEqual({ email: "auto", sms: "approval" });
      const log = await H.t.db
        .select()
        .from(contactChange)
        .where(eq(contactChange.contactId, patId));
      expect(log.at(-1)?.change).toMatchObject({ kind: "autonomy", by: "operator" });
      const other = await call(admin("b"), "PUT", `/api/contacts/${patId}/autonomy`, {
        autonomy: { email: "off" },
      });
      expect(other.status).toBe(404);
    });
  });

  describe("voice samples", () => {
    let sampleId = "";

    it("the client admin pastes one; it is cleaned and is the client admin's voice by default", async () => {
      const res = await call(admin("a"), "POST", "/api/knowledge/voice-samples", {
        title: "Thank-you note",
        text: "Thanks so much, we'll see you Friday.\n\nOn Mon, Nov 3, 2026 Lee wrote:\n> hi",
        channel: "email",
      });
      expect(res.status).toBe(200);
      const sample = (res.json as J).sample;
      sampleId = sample.id;
      expect(sample).toMatchObject({
        text: "Thanks so much, we'll see you Friday.",
        channel: "email",
        person: { id: H.A.admin },
      });
      const list = await call(admin("a"), "GET", "/api/knowledge/voice-samples");
      expect((list.json as J).samples.map((s: J) => s.id)).toEqual([sampleId]);
      // Not an FAQ: not in the FAQ list, and not editable as one.
      const faqs = await call(admin("a"), "GET", "/api/knowledge");
      expect((faqs.json as J).entries).toEqual([]);
      const asFaq = await call(admin("a"), "PUT", `/api/knowledge/entries/${sampleId}`, {
        title: "x",
        body: "y",
        baseVersion: 1,
      });
      expect(asFaq.status).toBe(404);
    });

    it("refuses a person who isn't the client's, and keeps clients apart", async () => {
      const res = await call(admin("a"), "POST", "/api/knowledge/voice-samples", {
        title: "x",
        text: "y",
        channel: "sms",
        personUserId: H.B.admin,
      });
      expect(res.status).toBe(422);
      const b = await call(admin("b"), "GET", "/api/knowledge/voice-samples");
      expect((b.json as J).samples).toEqual([]);
      const ops = await call(OPERATOR, "GET", `/api/ops/clients/${A()}/knowledge/voice-samples`);
      expect((ops.json as J).samples.map((s: J) => s.id)).toEqual([sampleId]);
    });

    it("the operator edits and archives one; the versions are kept", async () => {
      const edit = await call(
        OPERATOR,
        "PUT",
        `/api/ops/clients/${A()}/knowledge/voice-samples/${sampleId}`,
        {
          title: "Thank-you note",
          text: "Thanks, see you Friday.",
          channel: "sms",
          baseVersion: 1,
        },
      );
      expect(edit.status).toBe(200);
      expect((edit.json as J).sample).toMatchObject({ version: 2, channel: "sms" });
      const archive = await call(
        admin("a"),
        "POST",
        `/api/knowledge/voice-samples/${sampleId}/archive`,
        {
          baseVersion: 2,
        },
      );
      expect((archive.json as J).sample.status).toBe("archived");
      const versions = await call(
        OPERATOR,
        "GET",
        `/api/ops/clients/${A()}/knowledge/entries/${sampleId}/versions`,
      );
      expect((versions.json as J).versions).toHaveLength(3);
    });

    it("email(): the +voice address keeps an allowed sender's text as a sample, nothing else", async () => {
      const got = await call(admin("a"), "GET", "/api/connections/upload/forwarding");
      const address: string = (got.json as J).forwarding.address;
      await call(admin("a"), "PUT", "/api/connections/upload/senders", {
        allowed: ["a.example.com"],
      });
      const to = address.replace("@", "+voice@");
      const raw = new TextEncoder().encode(
        [
          "From: Client admin <admin@a.example.com>",
          `To: ${to}`,
          "Subject: How I write texts",
          "Content-Type: text/plain; charset=utf-8",
          "",
          "Hey, running 10 minutes late. Save me a coffee.",
          "",
        ].join("\r\n"),
      );
      const deps = {
        ...defaultDeps,
        openDb: () => ({ db: H.db, close: async () => {} }),
        instances: () => H.instances,
        objects: () => H.objects,
        extractionTransport: () => null,
      };
      const out = await handleEmail(
        {
          from: "admin@a.example.com",
          to,
          raw: new Response(raw).body as ReadableStream<Uint8Array>,
          rawSize: raw.length,
        },
        H.env,
        () => {},
        deps,
      );
      expect(out).toMatchObject({ status: "accepted", documents: [] });
      const list = await call(admin("a"), "GET", "/api/knowledge/voice-samples");
      expect((list.json as J).samples[0]).toMatchObject({
        title: "How I write texts",
        text: "Hey, running 10 minutes late. Save me a coffee.",
        channel: "email",
        person: { id: H.A.admin },
      });
    });
  });

  describe("QuickBooks import", () => {
    let qboId = "";

    beforeAll(async () => {
      const [conn] = await H.t.db
        .insert(connection)
        .values({
          tenantId: A(),
          connector: "qbo",
          status: "connected",
          config: { companyName: "Hollis Millwork" },
        })
        .returning();
      qboId = conn?.id ?? "";
      const vendor = (id: string, name: string, extra: Record<string, unknown> = {}) => ({
        Id: id,
        DisplayName: name,
        PrimaryEmailAddr: { Address: `ar@${id}.example.com` },
        ...extra,
      });
      await H.t.db.insert(rawRecord).values([
        {
          tenantId: A(),
          connectionId: qboId,
          connector: "qbo",
          entityType: "Vendor",
          externalId: "56",
          externalVersion: "0",
          payload: vendor("56", "Northwest Plywood (old name)"),
          syncedAt: new Date("2026-10-01T00:00:00Z"),
        },
        {
          tenantId: A(),
          connectionId: qboId,
          connector: "qbo",
          entityType: "Vendor",
          externalId: "56",
          externalVersion: "1",
          payload: vendor("56", "Northwest Plywood Supply"),
          syncedAt: new Date("2026-11-01T00:00:00Z"),
        },
        {
          tenantId: A(),
          connectionId: qboId,
          connector: "qbo",
          entityType: "Vendor",
          externalId: "57",
          externalVersion: "0",
          payload: vendor("57", "Closed Vendor", { Active: false }),
        },
        {
          tenantId: A(),
          connectionId: qboId,
          connector: "qbo",
          entityType: "Customer",
          externalId: "9",
          externalVersion: "0",
          payload: { Id: "9", DisplayName: "Cedar Homes" },
        },
      ]);
    });

    it("lists QuickBooks as a source and previews its vendors and customers as organizations", async () => {
      const sources = await call(admin("a"), "GET", "/api/directory/import/sources");
      expect((sources.json as J).sources).toContainEqual(
        expect.objectContaining({
          connectionId: qboId,
          connector: "qbo",
          label: "QuickBooks: Hollis Millwork",
        }),
      );
      const res = await call(admin("a"), "POST", "/api/directory/import/connector", {
        connectionId: qboId,
        kind: "organizations",
      });
      expect(res.status).toBe(200);
      const preview = res.json as J;
      expect(preview.source).toBe("qbo");
      expect(preview.rows.map((r: J) => [r.action, r.data.name, r.data.kinds])).toEqual([
        ["add", "Cedar Homes", ["customer"]],
        ["add", "Northwest Plywood Supply", ["vendor"]],
      ]);
      const people = await call(admin("a"), "POST", "/api/directory/import/connector", {
        connectionId: qboId,
        kind: "people",
      });
      expect(people.status).toBe(422);
    });

    it("applies the chosen rows, keeping the QuickBooks id; another client can't use the connection", async () => {
      const preview = (
        await call(admin("a"), "POST", "/api/directory/import/connector", {
          connectionId: qboId,
          kind: "organizations",
          query: "plywood",
        })
      ).json as J;
      expect(preview.rows).toHaveLength(1);
      const res = await call(admin("a"), "POST", "/api/directory/import/apply", {
        source: "connector",
        kind: "organizations",
        connectionId: qboId,
        organizations: preview.rows.map((r: J) => r.data),
      });
      expect(res.status).toBe(200);
      const [org] = await H.t.db
        .select()
        .from(organization)
        .where(eq(organization.name, "Northwest Plywood Supply"));
      expect(org?.externalRefs).toEqual({ qbo: "56" });
      expect(org?.kinds).toEqual(["vendor"]);
      const other = await call(admin("b"), "POST", "/api/directory/import/connector", {
        connectionId: qboId,
        kind: "organizations",
      });
      expect(other.status).toBe(404);
    });
  });
});
