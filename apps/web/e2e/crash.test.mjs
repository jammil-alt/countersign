// The sweep's crash check (./crash.mjs) against plain pages and against the app's own error
// boundary, so a fallback the boundary renders is always one the sweep finds.
import { cleanup, render } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ErrorBoundary } from "../src/ui/ErrorBoundary";
import { crashesIn } from "./crash.mjs";

afterEach(() => {
  cleanup();
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

function page(html) {
  document.body.innerHTML = `<div id="root">${html}</div>`;
  return document.getElementById("root");
}

function Boom() {
  throw new Error("render failed");
}

describe("crashesIn", () => {
  it("passes a page that rendered", () => {
    page("<main><p>Runs</p></main>");
    expect(crashesIn(document)).toEqual([]);
  });

  it("finds an empty root", () => {
    page("");
    expect(crashesIn(document)).toEqual(["the screen crashed: #root is empty"]);
  });

  it("finds the error boundary's fallback, for the page and for a part of it", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const root = page("");
    render(
      createElement(
        "main",
        null,
        createElement(ErrorBoundary, null, createElement(Boom)),
        createElement(ErrorBoundary, { part: "desk-card" }, createElement(Boom)),
      ),
      { container: root },
    );
    expect(crashesIn(document)).toEqual([
      "the screen crashed: the page shows the error fallback",
      "the screen crashed: the desk-card shows the error fallback",
    ]);
  });
});
