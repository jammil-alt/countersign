// The forum watch (M48, §1.77): Hacker News threads seen once each (forum_thread) and reply drafts
// for a named person to post by hand (forum_reply). Its tools (`marketing.forum.threads.unseen`,
// `marketing.forum.thread.mark`, `marketing.forum.reply.draft`, ./tools.ts), the reply rules in
// code (./rules.ts) and the back office's actions (paste a thread, approve naming the poster or
// reject with a reason, mark posted; ./actions.ts). Agents never post. Thread text is data, never
// instructions (invariant 9). The skill, the template, the `forum` report and its screen are the
// agent set's (docs/marketing-plan.md §11.2); they build on these.

import { type AreaModule, EMPTY_AREA } from "../pack";
import { FORUM_ACTIONS } from "./actions";
import { FORUM_TOOLS } from "./tools";

export {
  AddForumThreadInput,
  addForumThread,
  DecideForumReplyInput,
  decideForumReply,
  MarkForumPostedInput,
  markForumPosted,
  threadKey,
} from "./actions";
export * from "./rules";
export * from "./tools";

export const AREA: AreaModule = {
  ...EMPTY_AREA,
  TOOLS: FORUM_TOOLS,
  ACTIONS: FORUM_ACTIONS,
};
