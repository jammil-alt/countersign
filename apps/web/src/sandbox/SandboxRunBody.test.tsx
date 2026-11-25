// A sandbox run's view (docs/plan.md §1.243), shared by the portal and the back office: that
// nothing was written; the steps; an email as it would arrive with Send to me (to the person
// looking, from the client's own mailbox); a text that can't be sent with the server's reason; a
// record's fields before and after; the sends already made; and the notices it would send.
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ApiError } from "../api/client";
import { EN } from "../i18n/i18n";
import { OPS_SANDBOX_WORDS } from "../ops/client/ClientSandbox";
import {
  SANDBOX_EMAIL as EMAIL,
  SANDBOX_RECORD as RECORD,
  sandboxRun,
  SANDBOX_TEXT as TEXT,
} from "../test/sandbox";
import { SandboxRunBody } from "./SandboxRunBody";
import { sandboxWords } from "./words";

describe("a sandbox run's view", () => {
  it("shows the email as it would arrive, with Send to me to the person looking", async () => {
    const onSend = vi.fn(async () => {});
    render(<SandboxRunBody run={sandboxRun()} words={sandboxWords(EN)} onSend={onSend} />);
    expect(screen.getByTestId("sandbox-run-not-written")).toHaveTextContent(
      "Nothing was written to your tools",
    );
    expect(screen.getByTestId("sandbox-step-email")).toHaveTextContent(
      "Would email Northside Lumber",
    );
    // A person's step reads in copper.
    expect(within(screen.getByTestId("sandbox-step-update")).getByText("Done")).toHaveClass(
      "text-copper-ink",
    );

    const email = screen.getByTestId(`sandbox-change-${EMAIL}`);
    expect(within(email).getByTestId(`sandbox-change-${EMAIL}-title`)).toHaveTextContent(
      "Email to Northside Lumber",
    );
    expect(within(email).getByTestId(`sandbox-change-${EMAIL}-to`)).toHaveTextContent(
      "Northside Lumber <orders@northside.example.com>",
    );
    expect(email).toHaveTextContent("office@harbor.example.com");
    expect(email).toHaveTextContent("Order 1042");
    expect(email).toHaveTextContent("2 attachments");
    expect(email).toHaveTextContent("Not written");
    // The body keeps its line breaks.
    const body = within(email).getByTestId(`sandbox-change-${EMAIL}-body`);
    expect(body.textContent).toBe("Hello,\nPlease confirm Friday.");
    expect(body).toHaveClass("whitespace-pre-wrap");
    expect(within(email).getByTestId(`sandbox-change-${EMAIL}-send-to`)).toHaveTextContent(
      "From your own mailbox to dana@harbor.example.com, and nobody else.",
    );
    const send = within(email).getByTestId(`sandbox-change-${EMAIL}-send`);
    expect(send).toBeEnabled();
    expect(send).toHaveTextContent("Send to me");
    await userEvent.click(send);
    expect(onSend).toHaveBeenCalledWith(EMAIL);

    // A record: its fields, as they are and as they would be.
    const fields = screen.getByTestId(`sandbox-change-${RECORD}-fields`);
    expect(
      within(fields)
        .getAllByRole("row")
        .map((r) => r.textContent),
    ).toEqual(["FieldNowWould be", "amount10.0012.00", "memo(empty)Rush"]);
    expect(screen.queryByTestId(`sandbox-change-${RECORD}-send`)).toBeNull();

    expect(screen.getByTestId("sandbox-run-notices")).toHaveTextContent(
      "Tell the office · Email · To Luis Ortega",
    );
  });

  it("shows a text as a message, and why it can't be sent", () => {
    render(<SandboxRunBody run={sandboxRun()} words={sandboxWords(EN)} onSend={async () => {}} />);
    const text = screen.getByTestId(`sandbox-change-${TEXT}`);
    expect(within(text).getByTestId(`sandbox-change-${TEXT}-title`)).toHaveTextContent(
      "Text to +15125550100",
    );
    expect(within(text).getByTestId(`sandbox-change-${TEXT}-bubble`)).toHaveTextContent(
      "Pick up at 9.",
    );
    expect(within(text).getByTestId(`sandbox-change-${TEXT}-send`)).toBeDisabled();
    expect(within(text).getByTestId(`sandbox-change-${TEXT}-reason`)).toHaveTextContent(
      "Your texting number isn't set up yet",
    );
  });

  it("lists the sends made, and shows a refused send's words", async () => {
    const run = sandboxRun();
    const [email] = run.changes;
    if (!email) throw new Error("no email");
    const sent = {
      ...run,
      changes: [
        {
          ...email,
          sent: [
            {
              at: "2026-11-24T10:05:00.000Z",
              byName: "Dana Reyes",
              channel: "email" as const,
              to: "dana@harbor.example.com",
            },
          ],
        },
      ],
    };
    const onSend = vi.fn(async () => {
      throw new ApiError({
        status: 429,
        code: "rate_limited",
        route: "POST /api/sandbox/runs/:runId/changes/:changeId/send",
        message: "We sent you a preview less than a minute ago. Wait a minute and try again.",
      });
    });
    render(<SandboxRunBody run={sent} words={sandboxWords(EN)} onSend={onSend} />);
    expect(screen.getByTestId(`sandbox-change-${EMAIL}-sent`)).toHaveTextContent(
      /Sent to Dana Reyes, .+ \(dana@harbor\.example\.com\)\./,
    );
    await userEvent.click(screen.getByTestId(`sandbox-change-${EMAIL}-send`));
    await waitFor(() =>
      expect(screen.getByTestId(`sandbox-change-${EMAIL}`)).toHaveTextContent(
        "less than a minute ago",
      ),
    );
  });

  it("speaks of the client's tools in the back office", () => {
    render(
      <SandboxRunBody
        run={sandboxRun({ changes: [], notices: [] })}
        words={OPS_SANDBOX_WORDS}
        onSend={async () => {}}
      />,
    );
    expect(screen.getByTestId("sandbox-run-not-written")).toHaveTextContent(
      "Nothing was written to the client's tools",
    );
    expect(screen.getByTestId("sandbox-run-changes")).toHaveTextContent(
      "It wouldn't change anything in the client's tools.",
    );
    expect(screen.queryByTestId("sandbox-run-notices")).toBeNull();
  });
});
