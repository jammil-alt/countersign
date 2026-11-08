// The content area (M46): guides on a client's site (content_page, content_version,
// content_publish, content_redirect), the claims list (claims_version), the publish checks and the
// claims lint (`marketing.content.check`, pure), and the tools an agent drafts with
// (`marketing.content.get`, `marketing.content.draft`). Publishing itself is the `website`
// connector's `website.publish`, a verb a person always signs.
// Owned by the content builder (docs/marketing-plan.md §11).

import { type AreaModule, EMPTY_AREA } from "../pack";

export const AREA: AreaModule = { ...EMPTY_AREA };
