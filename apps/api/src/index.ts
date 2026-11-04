// @countersign/api: the Hono Worker. Serves /api/*, the built apps/web as static assets, the
// Cloudflare Workflow classes and the cron handler. The only place that wires packages together.

import { app, runCron } from "./app";
import { handleEmail } from "./email";
import type { Bindings } from "./env";

export { app } from "./app";
export { RunWorkflow } from "./runs/workflow";

export default {
  fetch: app.fetch,
  scheduled(controller, env, ctx) {
    ctx.waitUntil(runCron(env, new Date(controller.scheduledTime)));
  },
  // Email forwarding (ARCHITECTURE §6.5): Email Routing on EMAIL_FORWARDING_DOMAIN → here.
  async email(message, env, ctx) {
    await handleEmail(message, env, (p) => ctx.waitUntil(p));
  },
} satisfies ExportedHandler<Bindings>;
