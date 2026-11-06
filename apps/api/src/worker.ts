// The deployed Worker's entry point (wrangler.jsonc `main`): the API from ./index, with Sentry
// around its fetch and scheduled handlers and around each Workflow class (./observability/sentry.ts).
// Every class_name in wrangler.jsonc must be exported here (worker.test.ts checks).
// Tests import ./index or ./app, which know nothing of Sentry; with no SENTRY_DSN this wrapper is
// inert. Pattern from Plenary Labs' apps/api/src/worker.ts.

import * as Sentry from "@sentry/cloudflare";
import { ExportWorkflow as Export } from "./exports/workflow";
import api from "./index";
import { sentryOptions } from "./observability/sentry";
import { QboSyncWorkflow as QboSync } from "./qbo/workflow";
import { RunWorkflow as Run } from "./runs/workflow";

export const RunWorkflow = Sentry.instrumentWorkflowWithSentry(sentryOptions, Run);
export const QboSyncWorkflow = Sentry.instrumentWorkflowWithSentry(sentryOptions, QboSync);
export const ExportWorkflow = Sentry.instrumentWorkflowWithSentry(sentryOptions, Export);

export default Sentry.withSentry(sentryOptions, api);
