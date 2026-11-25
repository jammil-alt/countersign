// Seats (docs/setup-plan.md §4.1): a template names `seat:<role>`, each client fills it.

import { describe, expect, it } from "vitest";
import { PersonRole, seatKindOf, seatLabelOf } from "../reach/rules";
import type { ToolSpec } from "../schemas/tool";
import type { TypingContext } from "../template/typer";
import { validateBundle } from "./bundle";
import { Process } from "./schema";
import {
  EMPTY_SEAT_FALLBACK,
  fillSeats,
  namesSeats,
  type Seats,
  seatProblems,
  seatRoleOf,
  seatsFromBindings,
  seatsNamed,
  seatWho,
} from "./seats";

const CREATE: ToolSpec = {
  id: "testkit.record.create",
  description: "Create a record",
  input: { type: "object", properties: { name: { type: "string" } } },
  output: { type: "object", properties: { id: { type: "string" } } },
  sideEffect: "external",
  verb: "create",
  source: "testkit",
  connector: "testkit",
};
const CTX: TypingContext = { tools: { [CREATE.id]: CREATE } };

const ROLES = [
  PersonRole.parse({ role: "bill-approver", kind: "signs", label: "Approves bills" }),
  PersonRole.parse({ role: "job-codes", kind: "answers" }),
  PersonRole.parse({ role: "summary", kind: "told" }),
  PersonRole.parse({ role: "vendor-rep" }),
];

const DANA = "00000000-0000-4000-8000-00000000000d";
const LUIS = "00000000-0000-4000-8000-00000000000a";
const MARK = "00000000-0000-4000-8000-00000000000b";
const CONTACT = "00000000-0000-4000-8000-00000000000c";

function proc(approval: object, extra: object[] = []) {
  return Process.parse({
    schemaVersion: 4,
    triggers: [{ id: "t", on: { type: "manual", input: {} } }],
    steps: [
      {
        id: "create",
        kind: "write",
        name: "Create",
        tool: CREATE.id,
        input: { name: "x" },
        checks: { approval },
      },
      ...extra,
    ],
  });
}

const ASK = {
  id: "ask",
  kind: "person",
  name: "Ask",
  mode: "ask",
  assignee: seatWho("job-codes"),
  title: "Which job?",
  deadline: { after: "1 day", tell: [seatWho("summary")] },
};
const TELL = {
  id: "tell",
  kind: "notify",
  name: "Summary",
  notify: { to: [seatWho("summary"), "client_admin"], message: "Done" },
};

describe("seat names", () => {
  it("reads and writes seat:<role>", () => {
    expect(seatWho("bill-approver")).toBe("seat:bill-approver");
    expect(seatRoleOf("seat:bill-approver")).toBe("bill-approver");
    expect(seatRoleOf("client_admin")).toBeNull();
    expect(seatRoleOf(DANA)).toBeNull();
    expect(seatRoleOf(undefined)).toBeNull();
  });

  it("reads a role declared before seats as reached, and words it", () => {
    expect(seatKindOf(PersonRole.parse({ role: "vendor-rep" }))).toBe("reached");
    expect(seatLabelOf({ role: "vendor-rep" })).toBe("Vendor rep");
    expect(seatLabelOf({ role: "bill-approver", label: "Approves bills" })).toBe("Approves bills");
  });

  it("keeps a role without kind or label as it was stored", () => {
    const stored = { role: "purchaser", description: "", required: false };
    expect(PersonRole.parse(stored)).toEqual(stored);
  });
});

describe("seatProblems", () => {
  it("accepts seats of the right kind", () => {
    const p = proc({ approvers: [{ who: seatWho("bill-approver") }] }, [ASK, TELL]);
    expect(seatProblems(p, ROLES)).toEqual([]);
    expect([...seatsNamed(p).keys()].sort()).toEqual(["bill-approver", "job-codes", "summary"]);
    expect(namesSeats(p)).toBe(true);
    expect(namesSeats(proc({}))).toBe(false);
  });

  it("refuses a seat the bundle doesn't declare", () => {
    const p = proc({ approvers: [{ who: seatWho("nobody") }] });
    expect(seatProblems(p, ROLES)).toEqual([
      expect.objectContaining({
        stepId: "create",
        field: "checks.approval.approvers.0.who",
        code: "unknown_seat",
      }),
    ]);
  });

  it("never lets a seat that only answers, is told or is contacted approve", () => {
    for (const role of ["job-codes", "summary", "vendor-rep"]) {
      const p = proc({ approvers: [{ who: seatWho(role) }] });
      expect(seatProblems(p, ROLES)).toEqual([expect.objectContaining({ code: "seat_kind" })]);
    }
    const approveStep = { ...ASK, mode: "approve", assignee: seatWho("summary") };
    expect(seatProblems(proc({}, [approveStep]), ROLES)).toEqual(
      expect.arrayContaining([expect.objectContaining({ stepId: "ask", field: "assignee" })]),
    );
  });

  it("finds seats in an escalation and inside an if", () => {
    const p = proc({}, [
      {
        id: "branch",
        kind: "if",
        name: "Big?",
        paths: [
          {
            id: "big",
            name: "Big",
            when: { rules: [{ field: "{{trigger.total}}", op: ">", value: 1 }] },
            steps: [
              {
                ...ASK,
                deadline: {
                  after: "1 day",
                  ifNoAnswer: {
                    escalate: { to: seatWho("summary"), deadline: { after: "1 day" } },
                  },
                },
              },
            ],
          },
        ],
        otherwise: { id: "small", steps: [] },
      },
    ]);
    expect(seatProblems(p, ROLES)).toEqual([
      expect.objectContaining({
        stepId: "ask",
        field: "deadline.ifNoAnswer.escalate.to",
        code: "seat_kind",
      }),
    ]);
  });
});

describe("validateBundle with seats", () => {
  const definition = {
    schemaVersion: 2 as const,
    identity: { name: "Clerk", role: "Bills", mission: "Enter bills" },
    kind: "functional" as const,
    model: { id: "m" },
    instructions: "Work carefully.",
    skills: [],
    extraTools: [CREATE.id],
    permissions: { mode: "act" as const },
  };
  const bundle = (people: object[]) => ({
    schemaVersion: 1,
    definition,
    people,
    workflows: [
      {
        slug: "bills",
        name: "Bills",
        workflow: proc({ approvers: [{ who: seatWho("bill-approver") }] }),
      },
    ],
  });

  it("is valid when the seat is declared to sign", () => {
    const r = validateBundle(bundle([{ role: "bill-approver", kind: "signs" }]), CTX);
    expect(r.errors).toEqual([]);
  });

  it("names the workflow when a seat is unknown or can't sign", () => {
    expect(validateBundle(bundle([]), CTX).errors).toEqual([
      expect.objectContaining({ workflow: "bills", stepId: "create", code: "unknown_seat" }),
    ]);
    expect(validateBundle(bundle([{ role: "bill-approver" }]), CTX).errors).toEqual([
      expect.objectContaining({ workflow: "bills", code: "seat_kind" }),
    ]);
  });
});

describe("fillSeats", () => {
  const seats: Seats = seatsFromBindings({
    "bill-approver": { contactIds: [], userIds: [LUIS], backupUserIds: [DANA] },
    "job-codes": { contactIds: [], userIds: [MARK] },
    summary: { contactIds: [CONTACT], userIds: [LUIS] },
  });

  it("asks each person in an approval's seat in turn, then its backups", () => {
    const p = proc({
      approvers: [{ who: seatWho("bill-approver"), deadline: { after: "2 days" } }],
    });
    const filled = fillSeats(p, seats);
    const approvers = filled.steps[0]?.checks?.approval?.approvers;
    expect(approvers?.map((a) => a.who)).toEqual([LUIS, DANA]);
    expect(approvers?.[1]?.deadline?.after).toBe("2 days");
    // Nothing mutated: the version's process still names the seat.
    expect(p.steps[0]?.checks?.approval?.approvers?.[0]?.who).toBe("seat:bill-approver");
  });

  it("leaves backups out when any or all of them decide", () => {
    for (const mode of ["any", "all"]) {
      const filled = fillSeats(
        proc({ mode, approvers: [{ who: seatWho("bill-approver") }] }),
        seats,
      );
      expect(filled.steps[0]?.checks?.approval?.approvers?.map((a) => a.who)).toEqual([LUIS]);
    }
  });

  it("makes an empty seat the default approver, never nobody", () => {
    const filled = fillSeats(proc({ approvers: [{ who: seatWho("bill-approver") }] }), {});
    expect(filled.steps[0]?.checks?.approval?.approvers).toEqual([{}]);
  });

  it("gives a person step its seat's first person and tells everyone told", () => {
    const filled = fillSeats(proc({}, [ASK, TELL]), seats);
    const ask = filled.steps[1];
    const tell = filled.steps[2];
    if (ask?.kind !== "person" || tell?.kind !== "notify") throw new Error("fixture");
    expect(ask.assignee).toBe(MARK);
    expect(ask.deadline.tell).toEqual([LUIS, CONTACT]);
    expect(tell.notify.to).toEqual([LUIS, CONTACT, "client_admin"]);
  });

  it("sends an empty seat's question and notice to the client admin", () => {
    const filled = fillSeats(
      proc({}, [ASK, { ...TELL, notify: { to: [seatWho("summary")], message: "x" } }]),
      {},
    );
    const ask = filled.steps[1];
    const tell = filled.steps[2];
    if (ask?.kind !== "person" || tell?.kind !== "notify") throw new Error("fixture");
    expect(ask.assignee).toBe(EMPTY_SEAT_FALLBACK);
    expect(tell.notify.to).toEqual([EMPTY_SEAT_FALLBACK]);
  });

  it("leaves a process with no seats as it was", () => {
    const p = proc({ approvers: [{ who: "client_admin" }] }, [
      { ...TELL, notify: { to: [DANA, "client_admin"], message: "Done" } },
    ]);
    expect(fillSeats(p, seats)).toEqual(p);
  });
});
