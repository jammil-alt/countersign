// What changed between two revisions of an agent's SOP, in words, by code (docs/sop-plan.md §6),
// and the fingerprint that says whether there is a new revision at all. Only what the SOP says
// counts: when it was read, its revision and history, this month's measures and what the agent
// learned are left out, so they never make a revision on their own; so is a pause, a state of the
// moment (a pause and a resume would otherwise each make one, from the hourly check too). The outline is the procedure's
// shape again, for the chart (§6a): left out too, so adding it made no revision.

import { canonicalJson, sha256Hex } from "../canonical";
import type { SopChange, SopControl, SopStepLine, SopSystem, SopView } from "./view";

/** The part of the SOP a revision is about. */
export function sopContent(view: SopView): unknown {
  const {
    asOf: _a,
    revision: _r,
    previous: _p,
    history: _h,
    measures: _m,
    learned: _l,
    outline: _o,
    paused: _pa,
    ...rest
  } = view;
  return rest;
}

/** sha256 of the SOP's content: a new revision exactly when this changes. */
export async function sopFingerprint(view: SopView): Promise<string> {
  return sha256Hex(canonicalJson(sopContent(view)));
}

const LEVEL: Record<string, string> = { auto: "On its own", ask: "Ask me first", off: "Off" };
const METHOD: Record<string, string> = {
  rules: "Rules",
  ai: "AI",
  rules_then_ai: "Rules, then AI",
  person: "A person",
};

function method(s: SopStepLine): string {
  const m = s.method ? (METHOD[s.method] ?? s.method) : "Not known";
  return s.model ? `${m} (${s.model})` : m;
}

function approvers(s: SopStepLine): string {
  const list = s.approval?.approvers ?? [];
  if (list.length === 0) return "nobody";
  return list
    .map((a) => (a.condition ? `${a.party.name} ${a.condition}` : a.party.name))
    .join(", ");
}

function stepsOf(view: SopView): Map<string, SopStepLine> {
  return new Map(
    view.procedure.filter((l): l is SopStepLine => l.line === "step").map((s) => [s.id, s]),
  );
}

/** Each change from `before` to `after`, newest wording first: steps, then controls, systems, the rest. */
export function sopChanges(before: SopView | null, after: SopView): SopChange[] {
  if (!before)
    return [{ section: "header", ref: null, words: "First revision of this SOP.", was: null }];
  // A new way of writing SOPs, not a change to the agent: said once, without a diff between two
  // ways of writing that would list changes nobody made.
  if ((before.format ?? 0) !== after.format) {
    return [
      {
        section: "header",
        ref: null,
        words: "We changed how SOPs are written. How the agent works is the same.",
        was: null,
      },
    ];
  }
  const out: SopChange[] = [];
  const add = (c: SopChange) => out.push(c);

  // Header.
  if (before.stage.id !== after.stage.id) {
    add({
      section: "header",
      ref: null,
      words: `Stage: ${after.stage.words}`,
      was: before.stage.words,
    });
  }
  if ((before.owner?.party.name ?? null) !== (after.owner?.party.name ?? null)) {
    add({
      section: "header",
      ref: null,
      words: `Area owner: ${after.owner?.party.name ?? "none"}`,
      was: before.owner?.party.name ?? "none",
    });
  }
  if ((before.owner?.model ?? null) !== (after.owner?.model ?? null)) {
    add({
      section: "header",
      ref: null,
      words: `The area owner reasons on ${after.owner?.model ?? "no model of its own"}`,
      was: before.owner?.model ?? "no model of its own",
    });
  }
  const names = (l: { name: string }[]) => l.map((p) => p.name).join(", ");
  if (names(before.accountable) !== names(after.accountable)) {
    add({
      section: "roles",
      ref: null,
      words: `Accountable: ${names(after.accountable) || "nobody named"}`,
      was: names(before.accountable) || "nobody named",
    });
  }
  if (before.purpose !== after.purpose) {
    add({ section: "header", ref: null, words: "What it does was rewritten", was: null });
  }

  // How it starts.
  const bt = before.start.triggers.join("; ");
  const at = after.start.triggers.join("; ");
  if (bt !== at)
    add({
      section: "start",
      ref: null,
      words: `Starts when: ${at || "nothing"}`,
      was: bt || "nothing",
    });
  if (before.start.hours !== after.start.hours) {
    add({
      section: "start",
      ref: null,
      words: `Business hours: ${after.start.hours ?? "not set"}`,
      was: before.start.hours ?? "not set",
    });
  }

  // Steps, by id: steps keep their ids across versions (invariant 3).
  const b = stepsOf(before);
  const a = stepsOf(after);
  for (const [id, s] of a) {
    const old = b.get(id);
    const ref = s.number;
    if (!old) {
      add({ section: "procedure", ref, words: `New step ${s.number}, ${s.name}`, was: null });
      continue;
    }
    if (old.name !== s.name)
      add({
        section: "procedure",
        ref,
        words: `Step ${s.number} is now "${s.name}"`,
        was: `"${old.name}"`,
      });
    if (method(old) !== method(s))
      add({
        section: "procedure",
        ref,
        words: `Step ${s.number}, ${s.name}: ${method(s)}`,
        was: method(old),
      });
    if (old.purpose !== s.purpose && (old.purposeWritten || s.purposeWritten)) {
      add({
        section: "procedure",
        ref,
        words: `Step ${s.number}'s purpose: ${s.purpose}`,
        was: old.purpose,
      });
    }
    if ((old.who?.name ?? null) !== (s.who?.name ?? null)) {
      add({
        section: "procedure",
        ref,
        words: `Step ${s.number} is done by ${s.who?.name ?? "the agent"}`,
        was: old.who?.name ?? "the agent",
      });
    }
    const ol = old.approval?.level ?? null;
    const nl = s.approval?.level ?? null;
    if (ol !== nl && nl !== null) {
      add({
        section: "procedure",
        ref,
        words: `Step ${s.number}, ${s.name}: ${LEVEL[nl] ?? nl}`,
        was: ol ? (LEVEL[ol] ?? ol) : "no change to your tools",
      });
    }
    if (nl === "ask" && approvers(old) !== approvers(s)) {
      add({
        section: "procedure",
        ref,
        words: `Step ${s.number} is approved by ${approvers(s)}`,
        was: approvers(old),
      });
    }
    if ((old.byWhen ?? null) !== (s.byWhen ?? null) && s.byWhen) {
      add({
        section: "procedure",
        ref,
        words: `Step ${s.number}: within ${s.byWhen}`,
        was: old.byWhen,
      });
    }
  }
  for (const [id, s] of b) {
    if (!a.has(id))
      add({ section: "procedure", ref: null, words: `Step "${s.name}" was removed`, was: null });
  }

  // Controls, by key.
  const bc = new Map(before.controls.map((c) => [c.key, c]));
  const ac = new Map(after.controls.map((c) => [c.key, c]));
  const fresh = (c: SopControl) => !bc.has(c.key);
  for (const c of after.controls) {
    const old = bc.get(c.key);
    if (fresh(c)) {
      // A step's own new control is already said with the step; say the others.
      if (
        !c.key.startsWith("approval:") &&
        !c.key.startsWith("system:") &&
        !c.key.startsWith("paths:")
      ) {
        add({ section: "controls", ref: c.id, words: `New control: ${c.name}`, was: null });
      }
    } else if (old && old.name !== c.name) {
      add({ section: "controls", ref: c.id, words: c.name, was: old.name });
    }
  }
  for (const c of before.controls) {
    if (
      !ac.has(c.key) &&
      !c.key.startsWith("approval:") &&
      !c.key.startsWith("system:") &&
      !c.key.startsWith("paths:")
    ) {
      add({ section: "controls", ref: null, words: `Control removed: ${c.name}`, was: null });
    }
  }

  // Systems, by key: what the agent may do in each.
  const bs = new Map(before.systems.map((s) => [s.key, s]));
  for (const s of after.systems) {
    const old = bs.get(s.key);
    if (!old) {
      add({ section: "systems", ref: s.id, words: `Now uses ${s.name}`, was: null });
      continue;
    }
    for (const verb of ["read", "create", "update", "delete"] as const) {
      const was = old[verb];
      const now = s[verb];
      if (was !== now && now !== null) {
        const words = verb === "read" ? (now === "off" ? "Off" : "On") : (LEVEL[now] ?? now);
        const prev =
          was === null
            ? "not used"
            : verb === "read"
              ? was === "off"
                ? "Off"
                : "On"
              : (LEVEL[was] ?? was);
        add({ section: "systems", ref: s.id, words: `${s.name} ${verb}: ${words}`, was: prev });
      }
    }
    if (old.connected !== s.connected) {
      add({
        section: "systems",
        ref: s.id,
        words: `${s.name} is ${s.connected ? "connected" : "not connected"}`,
        was: old.connected ? "connected" : "not connected",
      });
    }
  }
  for (const s of before.systems) {
    if (!after.systems.some((x: SopSystem) => x.key === s.key)) {
      add({ section: "systems", ref: null, words: `No longer uses ${s.name}`, was: null });
    }
  }

  // Decisions and settings.
  const bd = new Map(before.decisions.map((d) => [d.id, d]));
  for (const d of after.decisions) {
    const old = bd.get(d.id);
    if (!old) add({ section: "decisions", ref: null, words: `New decision: ${d.what}`, was: null });
    else if (old.what !== d.what || old.value !== d.value) {
      add({
        section: "decisions",
        ref: null,
        words: d.value ? `${d.what}: ${d.value}` : d.what,
        was: old.value ? `${old.what}: ${old.value}` : old.what,
      });
    }
  }
  const bset = new Map(before.settings.map((s) => [s.label, s]));
  for (const s of after.settings) {
    const old = bset.get(s.label);
    if (old && old.value !== s.value)
      add({ section: "decisions", ref: null, words: `${s.label}: ${s.value}`, was: old.value });
  }

  // Anything else the SOP says (data, references, exceptions): one line, so no change goes unsaid.
  if (out.length === 0) {
    add({
      section: "references",
      ref: null,
      words: "Details of how it works were updated",
      was: null,
    });
  }
  return out;
}
