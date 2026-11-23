// S5.3 (overnight fixes, 2026-11-23): the portal's Home greets and dates on the client's day from
// its first draw. The browser here is in Los Angeles (Sunday evening); the client is in Madrid
// (Monday morning). Before the fix, Home drew "Sunday … Good evening" until the table answered.
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { AppProviders, AppRoutes } from "../../App";
import { CLIENT_SESSION, fakeApi } from "../../test/fixtures";

const BROWSER_TZ = process.env.TZ;

beforeAll(() => {
  process.env.TZ = "America/Los_Angeles";
  // 05:30 UTC on Monday 23 Nov: 21:30 on Sunday in Los Angeles, 06:30 on Monday in Madrid.
  vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-11-23T05:30:00.000Z") });
});

afterAll(() => {
  vi.useRealTimers();
  if (BROWSER_TZ === undefined) delete process.env.TZ;
  else process.env.TZ = BROWSER_TZ;
});

describe("Home in the client's time zone", () => {
  it("greets on the client's day before the table answers", async () => {
    expect(new Date().getHours()).toBe(21); // The browser's own clock: Sunday evening.
    const never = new Promise<never>(() => {});
    const api = fakeApi({
      "GET /api/session": () => ({
        ...CLIENT_SESSION,
        user: { ...CLIENT_SESSION.user, name: "Dana Kim" },
        timezone: "Europe/Madrid",
      }),
      "GET /api/feedback/status": () => ({ enabled: false }),
      // The table (which also carries the zone) never answers: the first draw is all there is.
      "GET /api/table": () => never,
      "GET /api/overview": () => never,
      "GET /api/access": () => never,
      "GET /api/weekly": () => never,
    });
    render(
      <MemoryRouter initialEntries={["/"]}>
        <AppProviders client={api.client}>
          <AppRoutes />
        </AppProviders>
      </MemoryRouter>,
    );
    expect(await screen.findByRole("heading", { name: "Good morning, Dana" })).toBeVisible();
    expect(screen.getByText("Monday 23 November")).toBeVisible();
    expect(screen.queryByText(/Sunday/)).toBeNull();
  });
});
