// The step model §10c (stream A's wiring of stream E): a merged action runs on the first of its
// connectors, in the merge's order, that the agent is bound to and whose action is on. An off
// action is refused before the gate; another bound connector still runs it.

import { mergedOutput, resolveMergedCall } from "@countersign/connectors";
import { describe, expect, it } from "vitest";
import { boundWithActionOn, channelFallback, pickMerged } from "./merged-pick";

const offFor =
  (...off: string[]) =>
  async (_connector: string, tool: string) =>
    !off.includes(tool);
const name = (c: string) =>
  ({ slack: "Slack", teams: "Microsoft Teams", gchat: "Google Chat" })[c] ?? c;

describe("a merged action for one agent", () => {
  it("runs on the first bound connector, in the merge's order", async () => {
    expect(await pickMerged("teamchat.message.post", ["gchat", "teams"], offFor(), name)).toEqual({
      tool: "teams.message.post",
      connector: "teams",
    });
  });

  it("skips a connector whose action is switched off, for the next one bound", async () => {
    expect(
      await pickMerged(
        "teamchat.message.post",
        ["teams", "gchat"],
        offFor("teams.message.post"),
        name,
      ),
    ).toEqual({ tool: "gchat.message.post", connector: "gchat" });
  });

  it("is refused in plain words when every bound connector has it off, or none is bound", async () => {
    expect(
      await pickMerged("teamchat.message.post", ["teams"], offFor("teams.message.post"), name),
    ).toEqual({ refused: "Post a message is switched off for Microsoft Teams" });
    expect(await pickMerged("teamchat.message.post", ["qbo"], offFor(), name)).toEqual({
      refused: "Post a message: no connection of it is set up for this agent",
    });
  });

  it("maps the action's words to the tool it resolved to, and back", () => {
    expect(
      resolveMergedCall("teamchat.message.post", ["gchat"], { channel: "spaces/A", text: "hi" })
        ?.input,
    ).toEqual({ space: "spaces/A", text: "hi" });
    expect(
      mergedOutput("teamchat.message.post", "gchat", { space: "spaces/A", messageId: "m1" }),
    ).toMatchObject({ channel: "spaces/A", ts: "m1" });
  });
});

describe("today's write actions with the operator's switches", () => {
  it("leaves out an accounting connector whose action is off", async () => {
    expect(
      await boundWithActionOn("create_bill", ["qbo", "billcom"], offFor("qbo.bill.create")),
    ).toEqual({ bound: ["billcom"], off: ["qbo"] });
  });

  it("sends email on another bound connector when the channel's send is off", async () => {
    expect(
      await channelFallback("send_email", "resend", ["gmail", "resend"], offFor("email.send")),
    ).toEqual({ tool: "gmail.send", connector: "gmail" });
    expect(
      await channelFallback("send_email", "resend", ["resend"], offFor("email.send")),
    ).toBeNull();
  });
});
