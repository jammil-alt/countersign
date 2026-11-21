// Where an automation lives in the back office (F7): its page (versions, used by) and its steps in
// the one-screen builder. On their own, so a link to either doesn't load the builder.

/** An automation's page: what it takes in and needs, its versions and the agents that use it. */
export const automationPagePath = (id: string) => `/ops/skills/automations/${id}`;

/**
 * An automation's steps in the builder. What an automation step's box in an agent's chart links
 * to, with the automation's id (`BuilderAutomation` names it by slug and version: the id is the
 * library row's, `AutomationListItem.id`).
 */
export const automationStepsPath = (id: string) => `${automationPagePath(id)}/steps`;
