// @countersign/api: the Hono Worker. Serves /api/*, the built apps/web as static assets, the
// Cloudflare Workflow classes and the cron handler. The only place that wires packages together.

import { app, runCron } from "./app";
import type { Bindings } from "./env";

export { app } from "./app";
export { RunWorkflow } from "./runs/workflow";

export default {
  fetch: app.fetch,
  scheduled(controller, env, ctx) {
    ctx.waitUntil(runCron(env, new Date(controller.scheduledTime)));
  },
} satisfies ExportedHandler<Bindings>;
