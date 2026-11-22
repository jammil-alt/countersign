// A sidebar place lit for pages that belong to it but live at another address (owner, 2026-11-21:
// a template's workflow and steps "should be part of the lab as well").
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it } from "vitest";
import { SidebarLink } from "./Shell";

afterEach(() => cleanup());

const at = (path: string, current?: boolean) =>
  render(
    <MemoryRouter initialEntries={[path]}>
      <SidebarLink to="/ops/lab" label="Agent lab" testId="lab" current={current} />
    </MemoryRouter>,
  );

describe("SidebarLink", () => {
  it("is lit at its own address, and not elsewhere", () => {
    at("/ops/lab");
    expect(screen.getByTestId("lab")).toHaveAttribute("aria-current", "page");
    cleanup();
    at("/ops/templates/bookkeeping-agent/workflows/pull");
    expect(screen.getByTestId("lab")).not.toHaveAttribute("aria-current");
  });

  it("is lit elsewhere when the page is said to be its own", () => {
    at("/ops/templates/bookkeeping-agent/workflows/pull", true);
    const link = screen.getByTestId("lab");
    expect(link).toHaveAttribute("aria-current", "page");
    expect(link).toHaveAttribute("href", "/ops/lab");
  });
});
