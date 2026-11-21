import { describe, expect, it } from "vitest";
import type { Process } from "../process/schema";
import { gapSteps } from "./gap-steps";

const person = (id: string, name: string, title: string) => ({
  id,
  kind: "person" as const,
  name,
  mode: "ask" as const,
  assignee: "client_admin",
  title,
  payload: {},
  deadline: { after: "2 days" },
  channel: "inbox" as const,
  onReject: "stop" as const,
});

const process = (steps: unknown[]) => ({ steps }) as unknown as Pick<Process, "steps">;

describe("gapSteps", () => {
  it("names the person step that does the part a gap names", () => {
    const p = process([
      person(
        "portal",
        "Read the vendor's portal",
        "Check the vendor's portal and enter the amount",
      ),
      person("cards", "Enter the card charges", "Enter this month's card charges"),
      { id: "w", kind: "write", name: "Update the record", tool: "t", input: {} },
    ]);
    expect(
      gapSteps(
        [
          "No connector reads the vendor's portal, so a person checks it for now.",
          "No connector reads card charges, so a person enters them for now.",
          "Nothing sends a fax yet.",
        ],
        [p],
      ),
    ).toEqual(["portal", "cards", null]);
  });

  it("finds a missing step inside a path, by its need", () => {
    const p = process([
      {
        id: "if",
        kind: "if",
        name: "Over the limit?",
        paths: [
          {
            id: "p1",
            name: "Over",
            when: { all: [] },
            steps: [
              {
                id: "fax",
                kind: "missing",
                name: "Fax the vendor",
                need: "There is no fax connector.",
              },
            ],
          },
        ],
        otherwise: { steps: [] },
      },
    ]);
    expect(gapSteps(["Nothing can fax the vendor yet."], [p])).toEqual(["fax"]);
  });

  it("leaves a gap on no step when two steps match it as well, or only an approval does", () => {
    const p = process([
      person("a", "Check the vendor's portal", "Check the portal"),
      person("b", "Check the vendor's portal again", "Check the portal"),
    ]);
    expect(gapSteps(["No connector reads the vendor's portal."], [p])).toEqual([null]);
    // A person step that approves is not a stand-in.
    expect(
      gapSteps(
        ["No connector reads the vendor's portal."],
        [process([{ ...person("c", "Read the vendor's portal", "x"), mode: "approve" }])],
      ),
    ).toEqual([null]);
  });
});
