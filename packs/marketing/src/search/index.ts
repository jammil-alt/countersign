// The search area (M45): a site's Search Console and Bing figures, imported nightly by the
// `gsc` and `bing_webmaster` connectors into search_query_daily and search_page_daily, with
// search_source keeping each import's state. Its read tool (`marketing.search.figures`), the
// `search` and `search-sources` reports and the source actions land here.
// Owned by the search builder (docs/marketing-plan.md §11).

import { type AreaModule, EMPTY_AREA } from "../pack";

export const AREA: AreaModule = { ...EMPTY_AREA };
