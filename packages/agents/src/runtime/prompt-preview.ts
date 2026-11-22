// What a skill step's model is sent, worked out without a run (owner, 2026-11-21: "a way to look
// at what the prompt will look like when it comes in"; docs/plan.md §1.180). The same builders as
// the runtime's loop (./prompt, ./governance, ./model, `customizedSkill`), over what the caller
// has already read: the skill, the agent's definition, the client's governance and the agent's
// notes. Nothing is read or written here and no model is called.
import { BrowseScope, NEED_HELP_TOOL_SPEC } from "@countersign/connectors";
import {
  type AgentDefinition,
  type ClientGovernance,
  composeGovernance,
  type Locale,
  type ModelChoice,
  parameterValueProblems,
  parseSkillRef,
  type processes,
  resolveSkillParameters,
  resolveSkillSettings,
  type SkillDefinition,
  type StepPromptPreview,
  undiscussedFor,
} from "@countersign/core";
import type { ToolRegistry } from "../registry/tools";
import { stepProfile } from "./governance";
import { resolveModel } from "./model";
import type { PinnedAgent } from "./ports";
import { stepToolIds, systemParts, taskTurnText } from "./prompt";
import {
  customizedSkill,
  FINISH_TOOL,
  INPUT_TOOL,
  INPUT_TOOL_SPEC,
  isRuleSkill,
  languageInstruction,
  toolName,
} from "./run-agent";

export interface StepPromptInput {
  tools: ToolRegistry;
  /** The agent as the step would run in it: its definition, and the area set on it. */
  agent: Pick<PinnedAgent, "bundle" | "area">;
  /** The step's skill as the agent resolves it, before the step's own changes. */
  skillRef: string;
  skill: SkillDefinition;
  /** The step's id, and what it sets for this use of the skill. */
  step: {
    id: string;
    settings?: Record<string, unknown> | undefined;
    model?: ModelChoice | undefined;
    customize?: processes.SkillCustomization | undefined;
  };
  /** The client's confirmed charter and tagged policies; null where there is no client. */
  client: ClientGovernance | null;
  /** The agent's own notes, newest first, as the runtime reads them (up to 50). */
  memory: readonly string[];
  language?: Locale | undefined;
  now?: (() => Date) | undefined;
}

export function previewStepPrompt(input: StepPromptInput): StepPromptPreview {
  const definition: AgentDefinition = input.agent.bundle.definition;
  const problems: string[] = [];
  let def = input.skill;
  const id = parseSkillRef(input.skillRef).id;
  const own = definition.skills.find((s) => parseSkillRef(s.skill).id === id);
  // The step's settings and its customization's over the agent's, as the executor layers them.
  const settings = resolveSkillSettings(def, {
    ...own?.settings,
    ...input.step.settings,
    ...input.step.customize?.settings,
  });
  const parameters = resolveSkillParameters(def, {
    agent: own?.parameters,
    step: input.step.customize?.parameters,
  });
  for (const p of parameterValueProblems(def, parameters, { complete: true })) {
    problems.push(p.message);
  }
  if (input.step.customize) {
    const customized = customizedSkill(def, input.step.customize);
    if (customized.ok) def = customized.def;
    else problems.push(customized.error);
  }
  const skill = { ref: input.skillRef, name: def.name, mode: def.mode };
  const memoryEnabled = definition.memory.enabled;
  const none = (runs: "rules" | "code"): StepPromptPreview => ({
    runs,
    skill,
    model: null,
    system: [],
    governance: [],
    tools: [],
    turn: "",
    data: { keys: [], memory: { enabled: memoryEnabled, given: false, notes: [] } },
    problems,
  });
  if (isRuleSkill(def)) return none("rules");
  if (def.mode === "tool") return none("code");

  const isTask = def.mode === "task";
  const model = resolveModel(
    definition.model,
    def,
    input.step.model ?? input.step.customize?.model,
    own?.model,
  );
  const scope = BrowseScope.of(def, input.now ? { now: input.now } : {});
  const allowed = new Set(stepToolIds(def, definition.extraTools, input.tools));
  if (scope) for (const t of BrowseScope.tools) allowed.add(t);
  // A task skill reads our guardrails only: the client's part is left out, as in a run.
  const governance = composeGovernance(
    stepProfile({ tools: input.tools }, input.agent as PinnedAgent, {
      tools: allowed,
      browses: scope !== null,
      lean: isTask,
    }),
    isTask ? null : input.client,
  );
  const system = systemParts({
    governance: governance.text,
    isTask,
    identity: definition.identity,
    agentInstructions: definition.instructions,
    skill: def,
    settings,
    parameters,
    language: languageInstruction(input.language),
  });
  const tools: StepPromptPreview["tools"] = [];
  for (const toolId of [...allowed].sort()) {
    const t = input.tools.get(toolId);
    if (t) tools.push({ id: toolId, name: toolName(toolId), description: t.spec.description });
  }
  tools.push({
    id: FINISH_TOOL,
    name: FINISH_TOOL,
    description: `Finish with the result of "${def.name}". Call it exactly once, when you are done.`,
  });
  if (scope) {
    tools.push({
      id: NEED_HELP_TOOL_SPEC.name,
      name: NEED_HELP_TOOL_SPEC.name,
      description: NEED_HELP_TOOL_SPEC.description,
    });
  }
  tools.push({ id: INPUT_TOOL, name: INPUT_TOOL, description: INPUT_TOOL_SPEC.description });

  const given = memoryEnabled && !isTask;
  const undiscussed = undiscussedFor(definition, input.step.id);
  const keys = [
    "input",
    ...(given ? ["memory"] : []),
    ...(scope ? ["browse"] : []),
    ...(undiscussed.length > 0 ? ["undiscussed"] : []),
  ];
  return {
    runs: "model",
    skill,
    model,
    system,
    governance: governance.read.map((r) => ({
      tier: r.tier,
      source: r.source,
      id: r.id,
      version: r.version,
    })),
    tools,
    turn: taskTurnText(INPUT_TOOL, ""),
    data: {
      keys,
      memory: { enabled: memoryEnabled, given, notes: given ? [...input.memory] : [] },
    },
    problems,
  };
}
