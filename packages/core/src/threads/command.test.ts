import { describe, expect, it } from "vitest";
import { LOCALES } from "../i18n/locale";
import { THREAD_WORDS } from "../i18n/threads";
import {
  agentCommandNames,
  commandWord,
  firstName,
  parseCommand,
  resolveAgentCommand,
  resolveSkillCommand,
} from "./command";
import { isClientThreadKind, ThreadMessagePostedPayload } from "./schemas";

const ID = (n: number) => `0192f7a0-0000-7000-8000-${String(n).padStart(12, "0")}`;

describe("parseCommand", () => {
  it.each([
    ["/remy hello", { name: "remy", args: "hello" }],
    ["/Remy   look at bill 1042  ", { name: "remy", args: "look at bill 1042" }],
    ["/remy", { name: "remy", args: "" }],
    ["  /pia\nline two", { name: "pia", args: "line two" }],
    ["/docs.extract file 3", { name: "docs.extract", args: "file 3" }],
    ["/custom:intake now", { name: "custom:intake", args: "now" }],
  ])("%j is a command", (text, want) => {
    expect(parseCommand(text)).toEqual(want);
  });

  it.each([
    "hello /remy",
    "/ remy",
    "//remy",
    "/path/to/file",
    "/remy/again",
    "",
    "/",
    "/-dash",
    "/rémy hi",
  ])("%j is plain text", (text) => {
    expect(parseCommand(text)).toBeNull();
  });
});

describe("long input (no polynomial backtracking)", () => {
  const quick = (fn: () => unknown) => {
    const started = Date.now();
    fn();
    return Date.now() - started;
  };

  it("lowers a 100k-dash name quickly", () => {
    const dashes = "-".repeat(100_000);
    expect(quick(() => commandWord(dashes))).toBeLessThan(200);
    expect(commandWord(dashes)).toBe("");
    expect(quick(() => commandWord(`a${dashes}b`))).toBeLessThan(200);
    expect(commandWord(`--Remy--`)).toBe("remy");
    expect(quick(() => firstName(dashes))).toBeLessThan(200);
  });

  it("parses a 100k-whitespace message quickly", () => {
    const spaces = " \t\n".repeat(33_334);
    for (const text of [
      spaces,
      `/remy${spaces}`,
      `/remy${spaces}x`,
      `/${spaces}`,
      `/remy-${"-".repeat(100_000)}`,
    ]) {
      expect(quick(() => parseCommand(text))).toBeLessThan(200);
    }
    expect(parseCommand(spaces)).toBeNull();
    expect(parseCommand(`/remy${spaces}`)).toEqual({ name: "remy", args: "" });
    expect(parseCommand(`/remy${spaces}x`)).toEqual({ name: "remy", args: "x" });
    expect(quick(() => firstName(spaces))).toBeLessThan(200);
  });
});

describe("command names", () => {
  it("lowers a first name to a word", () => {
    expect(commandWord(firstName("Rémy Dupont"))).toBe("remy");
    expect(commandWord("Ana-Lú")).toBe("ana-lu");
    expect(commandWord("!!")).toBe("");
    expect(firstName("  Pia  ")).toBe("Pia");
  });

  it("uses the first word of the identity name, else the slug when it clashes", () => {
    const names = agentCommandNames([
      { agentId: ID(1), slug: "remy", identityName: "Remy" },
      { agentId: ID(2), slug: "pia-materials", identityName: "Pia" },
      { agentId: ID(3), slug: "bill-clerk", identityName: "Sam Clerk" },
      { agentId: ID(4), slug: "bill-clerk-2", identityName: "Sam Second" },
      { agentId: ID(5), slug: "x", identityName: "***" },
    ]);
    expect(names.get(ID(1))).toBe("remy");
    expect(names.get(ID(2))).toBe("pia");
    expect(names.get(ID(3))).toBe("bill-clerk");
    expect(names.get(ID(4))).toBe("bill-clerk-2");
    expect(names.get(ID(5))).toBe("x");
  });

  it("does not let a first word take another agent's slug", () => {
    const names = agentCommandNames([
      { agentId: ID(1), slug: "pia", identityName: "Pia" },
      { agentId: ID(2), slug: "clerk", identityName: "Pia's helper" },
      { agentId: ID(3), slug: "other", identityName: "Clerk" },
    ]);
    expect(names.get(ID(1))).toBe("pia");
    expect(names.get(ID(2))).toBe("pias");
    expect(names.get(ID(3))).toBe("other");
  });

  it("resolves /remy to the agent and /nobody to nothing", () => {
    const candidates = [{ agentId: ID(1), slug: "remy-agent", identityName: "Remy" }];
    expect(resolveAgentCommand("remy", candidates)?.agentId).toBe(ID(1));
    expect(resolveAgentCommand("REMY", candidates)?.agentId).toBe(ID(1));
    expect(resolveAgentCommand("nobody", candidates)).toBeNull();
    expect(resolveAgentCommand("remy-agent", candidates)).toBeNull();
  });

  it("resolves a skill by id or by its last part when only one matches", () => {
    const skills = ["materials.match-lines", "docs.extract", "pricing.extract", "custom:intake"];
    expect(resolveSkillCommand("match-lines", skills)).toBe("materials.match-lines");
    expect(resolveSkillCommand("docs.extract", skills)).toBe("docs.extract");
    expect(resolveSkillCommand("extract", skills)).toBeNull();
    expect(resolveSkillCommand("intake", skills)).toBe("custom:intake");
    expect(resolveSkillCommand("nothing", skills)).toBeNull();
  });
});

describe("thread words and payload", () => {
  it("answers an unknown command in every language, naming it", () => {
    for (const locale of LOCALES) {
      const text = THREAD_WORDS[locale].unknownCommand("remy");
      expect(text).toContain("/remy");
      expect(text).not.toContain("!");
    }
  });

  it("keeps the text out of thread.message_posted", () => {
    const base = {
      threadId: ID(1),
      subjectType: "lead",
      subjectId: ID(2),
      messageId: ID(3),
      senderType: "user",
      senderId: ID(4),
      audience: "client",
    };
    expect(ThreadMessagePostedPayload.safeParse(base).success).toBe(true);
    expect(ThreadMessagePostedPayload.safeParse({ ...base, text: "hello" }).success).toBe(false);
    expect(
      ThreadMessagePostedPayload.safeParse({
        ...base,
        command: { name: "remy", agentId: ID(5), args: "hello" },
      }).success,
    ).toBe(false);
  });

  it("knows the client's kinds", () => {
    expect(isClientThreadKind("lead")).toBe(true);
    expect(isClientThreadKind("account")).toBe(true);
    expect(isClientThreadKind("agent")).toBe(true);
    expect(isClientThreadKind("run")).toBe(false);
    expect(isClientThreadKind(null)).toBe(false);
  });
});
