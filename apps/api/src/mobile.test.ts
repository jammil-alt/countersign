// The phone app's session header (docs/plan.md §1.116): `mobileSession` reads the app's header as
// the session cookie and answers a new session in the header, never as a cookie; a browser's
// request is left alone.

import { MOBILE_SESSION_HEADER } from "@countersign/core";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import type { AppEnv } from "./http";
import { mobileSession } from "./routes/mobile";

describe("the app's session header", () => {
  const app = new Hono<AppEnv>();
  app.use("*", mobileSession);
  app.get("/api/echo", (c) => {
    c.header("Set-Cookie", "__Host-cs_session=v1.new.seal; Path=/; Max-Age=60; HttpOnly; Secure", {
      append: true,
    });
    c.header("Set-Cookie", "other=1; Path=/", { append: true });
    return c.json({ cookie: c.req.header("cookie") ?? null });
  });
  app.get("/api/out", (c) => {
    c.header("Set-Cookie", "__Host-cs_session=; Path=/; Max-Age=0; HttpOnly; Secure", {
      append: true,
    });
    return c.json({});
  });

  it("reads the header as the session cookie and hands the new session back in the header", async () => {
    const r = await app.request("/api/echo", {
      headers: { [MOBILE_SESSION_HEADER]: "v1.old.seal" },
    });
    expect(await r.json()).toEqual({ cookie: "__Host-cs_session=v1.old.seal" });
    expect(r.headers.get(MOBILE_SESSION_HEADER)).toBe("v1.new.seal");
    expect(r.headers.get("set-cookie")).toBeNull();
  });

  it("says signed out with an empty header", async () => {
    const r = await app.request("/api/out", {
      headers: { [MOBILE_SESSION_HEADER]: "v1.old.seal" },
    });
    expect(r.headers.get(MOBILE_SESSION_HEADER)).toBe("");
  });

  it("leaves a browser's request alone", async () => {
    const r = await app.request("/api/echo", { headers: { cookie: "a=1" } });
    expect(await r.json()).toEqual({ cookie: "a=1" });
    expect(r.headers.get(MOBILE_SESSION_HEADER)).toBeNull();
    expect(r.headers.get("set-cookie")).toContain("__Host-cs_session=v1.new.seal");
  });
});
