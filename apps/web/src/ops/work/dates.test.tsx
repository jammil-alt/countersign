// S5.1 (overnight fixes, 2026-11-23): one date format in the work screens, the shared formatter's
// ("23 Nov", with the year when it isn't this year), where hand-made helpers wrote "Nov 23" and
// raw ISO days ("2026-11-22").
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { shortDate } from "./parts";
import { Due } from "./sales/parts";

const YEAR = new Date().getFullYear();

describe("dates in the work screens", () => {
  it("writes a day as the house format", () => {
    expect(shortDate(`${YEAR}-11-23`)).toBe("23 Nov");
    expect(shortDate("2019-11-23")).toBe("23 Nov 2019");
  });

  it("shows a deal's due day in the house format", () => {
    render(<Due on={`${YEAR}-11-20`} today={`${YEAR}-11-23`} />);
    expect(screen.getByText("20 Nov")).toBeVisible();
    expect(screen.getByText("3 days late")).toBeVisible();
  });
});
