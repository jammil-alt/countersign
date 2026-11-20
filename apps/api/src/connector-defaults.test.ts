// Connectors C2 (docs/connectors-plan.md §5.1): the access a new connection starts with, reviewed
// per connector. Reads are on, no write starts on its own, delete is off, and each connector asks
// first only for the writes the snapshot below names. A change to a connector's `askFirst` shows up
// here, so it is reviewed with the plan's table.

import {
  connectionDefaults,
  connectionLevel,
  createDesktopConnector,
  describeAccess,
} from "@countersign/connectors";
import { describe, expect, it } from "vitest";
import { deploymentConnectors } from "./platform";

const connectors = [...deploymentConnectors({}, false), createDesktopConnector()];

describe("what a new connection starts with", () => {
  it("covers every connector a deployment registers, and the desktop app", () => {
    expect(connectors.length).toBeGreaterThanOrEqual(25);
  });

  it.each(connectors.map((c) => [c.manifest.id, c] as const))(
    "%s: has its own start, reads on, no write on its own, delete off",
    (_id, c) => {
      const m = c.manifest;
      expect(m.defaultPermissions).toBeDefined();
      const matrix = connectionDefaults(m);
      expect(matrix.read).toBe("auto");
      expect(matrix.delete).toBe("off");
      for (const a of describeAccess(m, matrix)) {
        if (a.verb === "read") expect(a.access, a.toolId).toBe("runs");
        else expect(a.access, a.toolId).not.toBe("steps_may_skip_approval");
        if (a.verb === "delete") expect(a.access, a.toolId).toBe("not_allowed");
      }
    },
  );

  it("asks first only for these writes; every other write starts off", () => {
    // A tool whose input names its record type (HubSpot's, Zoho's and Odoo's record tools) is
    // checked for each type it can name, as the gate decides it at run time.
    const asks = connectors.flatMap((c) => {
      const m = c.manifest;
      const matrix = connectionDefaults(m);
      return m.tools
        .filter((t) => t.verb !== "read")
        .flatMap((t) => {
          const inputs = t.entityInput
            ? Object.keys(t.entityInput.values).map((v) => ({ [t.entityInput?.field ?? ""]: v }))
            : [undefined];
          return inputs
            .map((input) => ({ input, level: connectionLevel(m, t, matrix, input) }))
            .filter((x) => x.level !== "off")
            .map((x) => {
              const on = x.input ? ` on ${Object.values(x.input)[0]}` : "";
              return `${m.id}: ${t.id}${on} (${x.level})`;
            });
        });
    });
    expect(asks.sort()).toMatchInlineSnapshot(`
      [
        "billcom: billcom.bill.attach_document (approval)",
        "desktop: desktop.file.create (approval)",
        "desktop: desktop.xlsx.append (approval)",
        "excel: excel.rows.append (approval)",
        "gcal: calendar.event.create (approval)",
        "gchat: gchat.message.post (approval)",
        "gdrive: drive.file.upload (approval)",
        "gmail: gmail.send (approval)",
        "gsheets: sheets.rows.append (approval)",
        "hubspot: hubspot.note.create (approval)",
        "hubspot: hubspot.task.create (approval)",
        "odoo: odoo.activity.create (approval)",
        "odoo: odoo.note.create (approval)",
        "onedrive: drive.file.upload (approval)",
        "outlook: outlook.send (approval)",
        "outlook_calendar: calendar.event.create (approval)",
        "podio: podio.comment.create (approval)",
        "podio: podio.task.create (approval)",
        "qbo: qbo.attachable.upload (approval)",
        "qbo: qbo.invoice.add_note (approval)",
        "ramp: ramp.receipt.upload (approval)",
        "resend: email.send (approval)",
        "slack: slack.message.post (approval)",
        "teams: teams.message.post (approval)",
        "testkit: testkit.record.update (approval)",
        "twilio: sms.send (approval)",
        "twilio: whatsapp.send (approval)",
        "webhook: webhook.event.send (approval)",
        "whatsapp_meta: whatsapp.send (approval)",
        "zoho_crm: zoho_crm.note.create (approval)",
        "zoho_crm: zoho_crm.task.create (approval)",
      ]
    `);
  });
});
