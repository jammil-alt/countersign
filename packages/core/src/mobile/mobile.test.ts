import { describe, expect, it } from "vitest";
import { ResolveBody } from "../api/routes";
import {
  personNotifications,
  personPush,
  withPersonNotifications,
  withPersonPush,
} from "../notify/notify";
import { renderPush } from "../notify/render";
import {
  DevicePublicKey,
  deviceSignedText,
  itemFingerprintText,
  PkceChallenge,
  PkceVerifier,
  PushToken,
} from "./mobile";

describe("the phone app's contract", () => {
  it("signs fixed lines, so the decision and item are part of what is signed", () => {
    const base = {
      deviceId: "0190a1b2-0000-7000-8000-000000000001",
      itemId: "0190a1b2-0000-7000-8000-000000000002",
      fingerprint: "a".repeat(64),
      at: "2026-11-13T15:00:00.000Z",
    };
    const approve = deviceSignedText({ ...base, decision: "approve" });
    expect(approve).toBe(
      ["mezonas-sign:v1", base.deviceId, base.itemId, "approve", base.fingerprint, base.at].join(
        "\n",
      ),
    );
    expect(deviceSignedText({ ...base, decision: "reject" })).not.toBe(approve);
  });

  it("fingerprints what the person reads, whatever the key order", () => {
    const a = itemFingerprintText({ id: "i", title: "Send PO", display: { b: 1, a: [2, 3] } });
    const b = itemFingerprintText({ display: { a: [2, 3], b: 1 }, title: "Send PO", id: "i" });
    expect(a).toBe(b);
    expect(itemFingerprintText({ id: "i", title: "Send PO" })).toBe(
      '{"display":null,"id":"i","title":"Send PO"}',
    );
    expect(itemFingerprintText({ id: "i", title: "Send PO", display: { b: 2 } })).not.toBe(a);
  });

  it("accepts Expo push tokens and P-256 public keys only", () => {
    expect(PushToken.safeParse("ExponentPushToken[xxxxxxxxxxxxxxxxxxxxxx]").success).toBe(true);
    expect(PushToken.safeParse("ExpoPushToken[abc-DEF_123]").success).toBe(true);
    expect(PushToken.safeParse("fcm:abc").success).toBe(false);
    const key = { kty: "EC", crv: "P-256", x: "A".repeat(43), y: "B".repeat(43) };
    expect(DevicePublicKey.safeParse(key).success).toBe(true);
    expect(DevicePublicKey.safeParse({ ...key, d: "C".repeat(43) }).success).toBe(false);
    expect(DevicePublicKey.safeParse({ ...key, crv: "P-384" }).success).toBe(false);
  });

  it("checks PKCE shapes", () => {
    expect(PkceVerifier.safeParse("a".repeat(43)).success).toBe(true);
    expect(PkceVerifier.safeParse("a".repeat(42)).success).toBe(false);
    expect(PkceChallenge.safeParse("b".repeat(43)).success).toBe(true);
    expect(PkceChallenge.safeParse("b+".repeat(22)).success).toBe(false);
  });

  it("lets a resolve carry a phone's signature, and nothing else new", () => {
    const deviceSignature = {
      deviceId: "0190a1b2-0000-7000-8000-000000000001",
      at: "2026-11-13T15:00:00.000Z",
      fingerprint: "f".repeat(64),
      signature: "s".repeat(86),
    };
    expect(ResolveBody.safeParse({ decision: "approve", deviceSignature }).success).toBe(true);
    expect(
      ResolveBody.safeParse({ decision: "approve", deviceSignature: { ...deviceSignature, x: 1 } })
        .success,
    ).toBe(false);
  });
});

describe("push settings", () => {
  const user = "0190a1b2-0000-7000-8000-000000000009";

  it("defaults to on, right away, a count only", () => {
    expect(personPush({}, user)).toEqual({ push: true, pushEvery: "now", pushShowsClient: false });
  });

  it("keeps push settings when email and texts are written, and the other way round", () => {
    let settings: Record<string, unknown> = {};
    settings = withPersonPush(settings, user, {
      push: false,
      pushEvery: "hour",
      pushShowsClient: true,
    });
    settings = withPersonNotifications(settings, user, { email: false, sms: true });
    expect(personPush(settings, user)).toEqual({
      push: false,
      pushEvery: "hour",
      pushShowsClient: true,
    });
    settings = withPersonPush(settings, user, {
      push: true,
      pushEvery: "now",
      pushShowsClient: false,
    });
    expect(personNotifications(settings, user)).toEqual({ email: false, sms: true });
  });

  it("puts a count and the business name at most on the lock screen", () => {
    const plain = renderPush({ kind: "items_waiting", counts: { items: 3 }, locale: "en" });
    expect(plain.title).toBe("Mezonas");
    expect(plain.body).toMatch(/3/);
    expect(plain.body).not.toMatch(/https?:/);
    const named = renderPush({
      kind: "items_waiting",
      counts: { items: 3 },
      locale: "en",
      clientName: "Northside Millwork",
    });
    expect(named.title).toBe("Northside Millwork");
    expect(named.body).toBe(plain.body);
  });
});
