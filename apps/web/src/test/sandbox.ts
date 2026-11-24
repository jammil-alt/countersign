// A sandbox run as the API answers it (docs/plan.md §1.243), for both sides' tests: an email that
// can be sent to the person looking, a record's fields, a text whose number isn't set up, a notice.
import type { SandboxRun } from "@countersign/core";

export const SANDBOX_RUN = "00000000-0000-4000-8000-0000000e5001";
export const SANDBOX_EMAIL = "00000000-0000-4000-8000-0000000e5101";
export const SANDBOX_RECORD = "00000000-0000-4000-8000-0000000e5102";
export const SANDBOX_TEXT = "00000000-0000-4000-8000-0000000e5103";

export function sandboxRun(over: Partial<SandboxRun> = {}): SandboxRun {
  return {
    runId: SANDBOX_RUN,
    agentId: "00000000-0000-4000-8000-0000000a0001",
    agentName: "Order desk",
    title: "Send an order",
    status: "done",
    startedAt: "2026-11-24T10:00:00.000Z",
    side: "portal",
    byName: "Dana Reyes",
    changeCount: 3,
    messages: 2,
    steps: [
      {
        id: "email",
        name: "Email the vendor",
        state: "done",
        summary: "Would email Northside Lumber (test run, not sent).",
        person: false,
      },
      { id: "update", name: "Update the record", state: "done", summary: null, person: true },
      { id: "text", name: "Text the driver", state: "done", summary: null, person: false },
    ],
    changes: [
      {
        id: SANDBOX_EMAIL,
        stepId: "email",
        stepName: "Email the vendor",
        kind: "message",
        title: "Email to Northside Lumber",
        tool: { connector: "gmail", connectorName: "Gmail" },
        message: {
          channel: "email",
          to: "orders@northside.example.com",
          toName: "Northside Lumber",
          from: "office@harbor.example.com",
          subject: "Order 1042",
          text: "Hello,\nPlease confirm Friday.",
          attachments: 2,
        },
        fields: [],
        send: { channel: "email", to: "dana@harbor.example.com", can: true, reason: null },
        sent: [],
      },
      {
        id: SANDBOX_RECORD,
        stepId: "update",
        stepName: "Update the record",
        kind: "record",
        title: "Update the record",
        tool: { connector: "qbo", connectorName: "QuickBooks Online" },
        message: null,
        fields: [
          { field: "amount", before: "10.00", after: "12.00" },
          { field: "memo", before: null, after: "Rush" },
        ],
        send: null,
        sent: [],
      },
      {
        id: SANDBOX_TEXT,
        stepId: "text",
        stepName: "Text the driver",
        kind: "message",
        title: "Text to +15125550100",
        tool: { connector: "twilio", connectorName: "Twilio" },
        message: {
          channel: "sms",
          to: "+15125550100",
          toName: null,
          from: null,
          subject: null,
          text: "Pick up at 9.",
          attachments: 0,
        },
        fields: [],
        send: {
          channel: "sms",
          to: null,
          can: false,
          reason: "Your texting number isn't set up yet, so texts can be read here but not sent.",
        },
        sent: [],
      },
    ],
    notices: [
      {
        stepId: "tell",
        stepName: "Tell the office",
        channel: "email",
        to: "Luis Ortega",
        text: "Order 1042 went out.",
      },
    ],
    ...over,
  };
}
