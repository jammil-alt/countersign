// The site Worker's entry (wrangler.jsonc `main`). It runs only for /guides, /guides/* and
// /sitemap.xml; everything else on mezonas.com is a static file. The work is in ./guides.ts. A
// Worker's main module may export only handlers, so this exports nothing but the default.

import { type Env, handle } from "./guides";

export default {
  fetch: (request: Request, env: Env): Promise<Response> => handle(request, env),
};
