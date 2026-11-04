// The deployed Worker's entry point (wrangler.jsonc `main`): the API from ./index, with Sentry
// around its fetch and scheduled handlers and around RunWorkflow (./observability/sentry.ts).
// Tests import ./index or ./app, which know nothing of Sentry; with no SENTRY_DSN this wrapper is
// inert. Pattern from Plenary Labs' apps/api/src/worker.ts.

import * as Sentry from "@sentry/cloudflare";
import api from "./index";
import { sentryOptions } from "./observability/sentry";
import { RunWorkflow as Run } from "./runs/workflow";

export const RunWorkflow = Sentry.instrumentWorkflowWithSentry(sentryOptions, Run);

export default Sentry.withSentry(sentryOptions, api);
