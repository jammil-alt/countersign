// @countersign/api: the Hono Worker. Serves /api/*, the built apps/web as static assets, the
// Cloudflare Workflow classes and the cron handler. The only place that wires packages together.

import { captureException } from "@sentry/cloudflare";
import { app, runCron } from "./app";
import type { Bindings } from "./env";

export { app } from "./app";
export { RunWorkflow } from "./runs/workflow";

export default {
  fetch: app.fetch,
  scheduled(controller, env, ctx) {
    // A failed tick is reported (a no-op where Sentry is off), then fails the invocation as before.
    ctx.waitUntil(
      runCron(env, new Date(controller.scheduledTime)).catch((error: unknown) => {
        captureException(error, { tags: { kind: "cron" } });
        throw error;
      }),
    );
  },
} satisfies ExportedHandler<Bindings>;
