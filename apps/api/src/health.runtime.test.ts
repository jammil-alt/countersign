import { SELF } from "cloudflare:test";
import { expect, it } from "vitest";

it("answers /api/health inside workerd", async () => {
  const res = await SELF.fetch("http://example.com/api/health");
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ ok: true });
});
