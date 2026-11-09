// @countersign/api: the Hono Worker. Serves /api/*, the built apps/web as static assets, the
// Cloudflare Workflow classes and the cron handler. The only place that wires packages together.

import { app } from "./app";
import { handleEmail } from "./email";
import type { Bindings } from "./env";
import { routeEmail } from "./mail-route";
import { scheduled } from "./scheduled";

export { app } from "./app";
// v0.14 capture: WhatsApp attachments
export { CaptureWorkflow } from "./conversations/workflow";
export { ExportWorkflow } from "./exports/workflow";
export { QboSyncWorkflow } from "./qbo/workflow";
export { RunWorkflow } from "./runs/workflow";
// v0.12 W2-C: the test bench
export { TestSuiteWorkflow } from "./testbench/workflow";

export default {
  fetch: app.fetch,
  scheduled,
  // Email Routing (one catch-all per zone) → here: the agent domain's mail goes on to the code
  // service, the rest is forwarding (ARCHITECTURE §6.5; ./mail-route.ts).
  async email(message, env, ctx) {
    await routeEmail(message, env, (m) => handleEmail(m, env, (p) => ctx.waitUntil(p)));
  },
} satisfies ExportedHandler<Bindings>;
