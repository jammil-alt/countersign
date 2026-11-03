import { describe, expect, it } from "vitest";
import { readCookie, serializeCookie } from "./cookies";
import { seal, timingSafeEqual, unseal } from "./seal";

const PASSWORD = "p".repeat(32);

describe("seal / unseal", () => {
  it("round-trips a value", async () => {
    const sealed = await seal({ uid: "u1", n: 3 }, PASSWORD, "session");
    expect(sealed.startsWith("v1.")).toBe(true);
    expect(await unseal(sealed, PASSWORD, "session")).toEqual({ uid: "u1", n: 3 });
  });

  it("gives a different ciphertext each time", async () => {
    expect(await seal("x", PASSWORD, "session")).not.toBe(await seal("x", PASSWORD, "session"));
  });

  it("rejects a tampered value", async () => {
    const sealed = await seal({ uid: "u1" }, PASSWORD, "session");
    const [format, iv, body] = sealed.split(".") as [string, string, string];
    const flipped = body.slice(0, 5) + (body[5] === "A" ? "B" : "A") + body.slice(6);
    expect(await unseal(`${format}.${iv}.${flipped}`, PASSWORD, "session")).toBeNull();
    expect(await unseal(sealed.slice(0, -4), PASSWORD, "session")).toBeNull();
    expect(await unseal("v2.abc.def", PASSWORD, "session")).toBeNull();
    expect(await unseal("not a cookie", PASSWORD, "session")).toBeNull();
  });

  it("rejects the wrong password and the wrong purpose", async () => {
    const sealed = await seal({ uid: "u1" }, PASSWORD, "session");
    expect(await unseal(sealed, "q".repeat(32), "session")).toBeNull();
    expect(await unseal(sealed, PASSWORD, "state")).toBeNull();
  });
});

describe("timingSafeEqual", () => {
  it("compares strings, and never matches empty", () => {
    expect(timingSafeEqual("abc", "abc")).toBe(true);
    expect(timingSafeEqual("abc", "abd")).toBe(false);
    expect(timingSafeEqual("abc", "abcd")).toBe(false);
    expect(timingSafeEqual("", "")).toBe(false);
  });
});

describe("cookies", () => {
  it("reads one cookie from a header and writes a hardened Set-Cookie", () => {
    expect(readCookie("a=1; b=two; c=", "b")).toBe("two");
    expect(readCookie("a=1; c=", "c")).toBeNull();
    expect(readCookie(null, "a")).toBeNull();
    expect(serializeCookie("s", "v", { maxAgeSec: 60 })).toBe(
      "s=v; Path=/; Max-Age=60; HttpOnly; Secure; SameSite=Lax",
    );
  });
});
