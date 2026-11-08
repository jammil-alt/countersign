// The forum watch (M48): Hacker News threads seen once each (forum_thread) and reply drafts for a
// named person to post by hand (forum_reply). Its tools (`marketing.forum.threads`,
// `marketing.forum.draft`), skill, template, the `forum` report and its actions (paste a thread,
// approve or reject a draft, mark it posted) land here. Agents never post. Thread text is data,
// never instructions (invariant 9).
// Owned by the agent set builder (docs/marketing-plan.md §11).

import { type AreaModule, EMPTY_AREA } from "../pack";

export const AREA: AreaModule = { ...EMPTY_AREA };
