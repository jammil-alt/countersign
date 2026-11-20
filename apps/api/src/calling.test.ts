// §1.160: calls that carry the client's name. On the business profile the texting registration
// made, the operator registers the client's numbers for SHAKEN/STIR and its caller name (CNAM);
// the hourly pass reads Twilio's review and adds numbers bought since; a number comes off both
// before it is released.

import { generateEncryptionKey } from "@countersign/connectors";
import {
  FAKE_PRIMARY_PROFILE,
  FAKE_TWILIO_MAIN,
  fakeTwilio,
} from "@countersign/connectors/testing";
import { CNAM_NAME_RE, cnamNameFrom } from "@countersign/core";
import { connection, withTenant } from "@countersign/db";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApiHarness, OPERATOR } from "./api.test-helper";
import { A2P_CRON_MINUTE, a2pCronTick } from "./messaging/a2p";

// biome-ignore lint/suspicious/noExplicitAny: response bodies are read loosely in tests.
type J = any;

describe("a caller name", () => {
  it("takes what Twilio takes", () => {
    expect(CNAM_NAME_RE.test("Acme Supply Co.")).toBe(true);
    expect(CNAM_NAME_RE.test("Acme Supply Company")).toBe(false); // 19 characters
    expect(CNAM_NAME_RE.test("1st Choice")).toBe(false);
    expect(CNAM_NAME_RE.test("Acme & Sons")).toBe(false);
  });
  it("is made to fit from the business's name", () => {
    expect(cnamNameFrom("Acme & Sons, LLC")).toBe("Acme Sons, LLC");
    expect(cnamNameFrom("1st Choice Lumber Yard")).toBe("st Choice Lumbe");
    expect(cnamNameFrom("123")).toBeNull();
  });
});

const twilio = fakeTwilio();
const h = await createApiHarness({
  env: {
    ENCRYPTION_KEY: generateEncryptionKey(),
    APP_ORIGIN: "https://app.mezonas.test",
    TWILIO_ACCOUNT_SID: FAKE_TWILIO_MAIN.accountSid,
    TWILIO_AUTH_TOKEN: FAKE_TWILIO_MAIN.authToken,
    TWILIO_PRIMARY_PROFILE_SID: FAKE_PRIMARY_PROFILE,
    TWILIO_A2P_EMAIL: "a2p@mezonas.test",
  },
  fetch: twilio.fetch,
});
afterAll(() => h?.close());

describe.skipIf(!h)("registering calls through the API", () => {
  const H = h as NonNullable<typeof h>;
  const A = () => H.A.tenantId;
  const ops = (path = "") => `/api/ops/clients/${A()}/messaging${path}`;
  let sub = "";
  let profile = "";
  const numberSids: string[] = [];

  async function row(): Promise<J> {
    return withTenant(H.t.db, A(), async (tx) => {
      const [r] = await tx
        .select()
        .from(connection)
        .where(and(eq(connection.tenantId, A()), eq(connection.connector, "twilio")));
      return r;
    });
  }

  async function buy(phoneNumber: string) {
    const b = await H.call(OPERATOR, "POST", ops("/numbers"), { phoneNumber });
    expect(b.status, JSON.stringify(b.json)).toBe(200);
    const n = (b.json as J).setup.twilio.numbers.find((x: J) => x.phoneNumber === phoneNumber);
    numberSids.push(n.sid);
    return n.sid as string;
  }

  const register = (displayName: string) =>
    H.call(OPERATOR, "POST", ops("/calling"), { displayName });

  beforeAll(async () => {
    const p = await H.call(OPERATOR, "POST", ops("/twilio"));
    expect(p.status, JSON.stringify(p.json)).toBe(200);
    sub = (p.json as J).setup.twilio.subaccountSid;
    await buy("+15125550101");
    // The business profile the texting registration makes, in the client's subaccount.
    const token = twilio.accounts.get(sub)?.token ?? "";
    const made = await twilio.fetch("https://trusthub.twilio.com/v1/CustomerProfiles", {
      method: "POST",
      headers: {
        authorization: `Basic ${btoa(`${sub}:${token}`)}`,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: "FriendlyName=Client%20A&Email=a2p%40mezonas.test&PolicySid=RNdfbf3fae0e1107f8aded0e7cead80bf5",
    });
    profile = JSON.parse(await made.text()).sid;
    const r = await row();
    await withTenant(H.t.db, A(), (tx) =>
      tx
        .update(connection)
        .set({
          config: {
            ...r.config,
            a2p: {
              ...r.config.a2p,
              registration: {
                stage: "submitted",
                customerProfileSid: profile,
                customerProfileStatus: "pending-review",
              },
            },
          },
        })
        .where(eq(connection.id, r.id)),
    );
  });

  it("waits for the business profile's approval", async () => {
    const setup = (await H.call(OPERATOR, "GET", ops())).json as J;
    expect(setup.setup.twilio.calling).toMatchObject({
      profileReady: false,
      suggestedName: "Client A",
      shakenStir: { status: "not_started" },
      cnam: { status: "not_started" },
    });
    const res = await register("Client A");
    expect(res.status).toBe(409);
    // Approved by Twilio: the next pass of the texting registration records it.
    twilio.a2p.setBundle(profile, "twilio-approved");
    const r = await row();
    await withTenant(H.t.db, A(), (tx) =>
      tx
        .update(connection)
        .set({
          config: {
            ...r.config,
            a2p: {
              ...r.config.a2p,
              registration: {
                ...r.config.a2p.registration,
                customerProfileStatus: "twilio-approved",
              },
            },
          },
        })
        .where(eq(connection.id, r.id)),
    );
  });

  it("refuses a name Twilio wouldn't take", async () => {
    expect((await register("Client A & Sons Supply")).status).toBe(400);
  });

  it("makes both products on the profile, puts the number on, and sends them for review", async () => {
    const res = await register("Client A");
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    const calling = (res.json as J).setup.twilio.calling;
    expect(calling).toMatchObject({
      profileReady: true,
      displayName: "Client A",
      shakenStir: { status: "pending" },
      cnam: { status: "pending" },
      numbersCovered: [numberSids[0]],
      error: null,
    });
    const stored = (await row()).config.calling;
    const shaken = twilio.a2p.bundles.get(stored.shakenStir.sid);
    const cnam = twilio.a2p.bundles.get(stored.cnam.sid);
    expect(shaken?.policy).toBe("RN7a97559effdf62d00f4298208492a5ea");
    expect(cnam?.policy).toBe("RNf3db3cd1fe25fcfd3c3ded065c8fea53");
    expect(shaken?.status).toBe("pending-review");
    expect(shaken?.assignments).toEqual([profile]);
    expect(cnam?.assignments).toContain(profile);
    const endUser = twilio.a2p.endUsers.get(stored.cnamEndUserSid);
    expect(endUser).toMatchObject({
      type: "cnam_information",
      attributes: { cnam_display_name: "Client A" },
    });
    for (const b of [twilio.a2p.bundles.get(profile), shaken, cnam]) {
      expect([...(b?.channels?.values() ?? [])]).toEqual([numberSids[0]]);
    }
    // Sent once: asking again while Twilio reviews it changes nothing.
    expect((await register("Client A")).status).toBe(200);
    expect([...(shaken?.channels?.values() ?? [])]).toHaveLength(1);
  });

  it("follows the review hourly and puts numbers bought since on both", async () => {
    const stored = (await row()).config.calling;
    twilio.a2p.setBundle(stored.shakenStir.sid, "twilio-approved");
    twilio.a2p.setBundle(stored.cnam.sid, "twilio-rejected", [
      { code: 22216, message: "The caller name doesn't match the business" },
    ]);
    const second = await buy("+15125550102");
    const at = new Date(Date.UTC(2026, 10, 20, 14, A2P_CRON_MINUTE));
    await a2pCronTick(H.t.db, { env: H.env, fetch: twilio.fetch }, at);
    const setup = ((await H.call(OPERATOR, "GET", ops())).json as J).setup.twilio.calling;
    expect(setup.shakenStir.status).toBe("approved");
    expect(setup.cnam.status).toBe("rejected");
    expect(setup.cnam.issues[0]).toContain("caller name");
    expect(setup.numbersCovered).toEqual(numberSids);
    const shaken = twilio.a2p.bundles.get(stored.shakenStir.sid);
    expect([...(shaken?.channels?.values() ?? [])]).toContain(second);
  });

  it("sends a new name again after a rejection", async () => {
    const res = await register("Client A Supply");
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    const calling = (res.json as J).setup.twilio.calling;
    expect(calling.cnam.status).toBe("pending");
    expect(calling.shakenStir.status).toBe("approved");
    const stored = (await row()).config.calling;
    expect(twilio.a2p.endUsers.get(stored.cnamEndUserSid)?.attributes).toEqual({
      cnam_display_name: "Client A Supply",
    });
  });

  it("takes a number off the products and the profile before releasing it", async () => {
    const sid = numberSids[1] as string;
    const res = await H.call(OPERATOR, "DELETE", ops(`/numbers/${sid}`));
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    const stored = (await row()).config.calling;
    for (const b of [profile, stored.shakenStir.sid, stored.cnam.sid]) {
      expect([...(twilio.a2p.bundles.get(b)?.channels?.values() ?? [])]).toEqual([numberSids[0]]);
    }
    expect(Object.keys(stored.assignments).some((k: string) => k.endsWith(sid))).toBe(false);
    expect(twilio.numbers.has(sid)).toBe(false);
  });
});
