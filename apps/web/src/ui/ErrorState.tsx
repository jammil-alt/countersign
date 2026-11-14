// What a page shows when what it asked for didn't come (the app's one ErrorNotice, used by every
// screen): by the failure, not by the screen.
// - Not found (a 404, a route id the API refused, another client's item): a calm dead end, no red
//   and no "Try again" (it can't help), with the way back to the matching list. A connection page
//   with no connection says what is missing and links to Accounts.
// - Forbidden (a 403 for the role): "You don't have access to this page" and the way home.
// - Failure (5xx, network, 429, an answer we didn't expect): the red box and "Try again", in plain
//   words; never the API's own message.
// Anything else (a form's 400, a 409), and every notice an action shows (one without a retry),
// reads as before.
// Each of the three offers "Report an issue": the Feedback flow, opened with a first line and what
// failed for us (route, URL, status, code, the call, when, client, user, release, Sentry's event).
// DECISION: the button shows where the Feedback button is on (always in the back office; in the
// portal where the operator switched feedback on for the client), the same rule, the same route.
// DECISION: the page's resource is read from its address (./error-pages.ts), so no screen passes it.
import { useState } from "react";
import { Link, useInRouterContext, useLocation } from "react-router-dom";
import { isApiError } from "../api/client";
import { type FeedbackReport, useFeedbackStarter } from "../feedback/Feedback";
import { errorText } from "../i18n/errors";
import { useI18n } from "../i18n/i18n";
import { appRelease } from "../observability";
import { useOptionalSession } from "../session/session";
import { cx } from "./cx";
import { type ErrorKind, errorKind, pageResource } from "./error-pages";
import { Icon } from "./icons";
import { Button, buttonClass } from "./primitives";

export function ErrorNotice({
  error,
  onRetry,
}: {
  error: unknown;
  onRetry?: (() => void) | undefined;
}) {
  // DECISION: a notice with a retry is a page's load (every screen passes its `reload`); one
  // without is an action's answer or a screen's own message (a refused save, a 429 on "Send a test
  // email", a sign-in refusal), and reads as before: the API's words for what was wrong with it.
  // Outside a router (a component on its own in a test) there is no page to go back from.
  const inRouter = useInRouterContext();
  if (!onRetry) return <ErrorBanner error={error} onRetry={undefined} kind="other" />;
  return inRouter ? (
    <RoutedErrorNotice error={error} onRetry={onRetry} />
  ) : (
    <ErrorBanner error={error} onRetry={onRetry} kind={errorKind(error)} />
  );
}

function RoutedErrorNotice({
  error,
  onRetry,
}: {
  error: unknown;
  onRetry: (() => void) | undefined;
}) {
  const { pathname } = useLocation();
  const kind = errorKind(error);
  const report = useReport(error, pathname);
  if (kind === "not_found" || kind === "forbidden") {
    return <DeadEnd error={error} kind={kind} pathname={pathname} report={report} />;
  }
  return <ErrorBanner error={error} onRetry={onRetry} kind={kind} report={report} />;
}

interface Report {
  send: (() => void) | null;
  sent: boolean;
}

/** "Report an issue": the Feedback flow with what failed; null where feedback is off. */
function useReport(error: unknown, pathname: string): Report {
  const start = useFeedbackStarter();
  const { t } = useI18n();
  const session = useOptionalSession();
  const [sent, setSent] = useState(false);
  // When it failed: the moment the page showed it, not when the report is sent.
  const [at] = useState(() => new Date().toISOString());
  if (!start) return { send: null, sent };
  const api = isApiError(error) ? error : null;
  const report: FeedbackReport = {
    comment: t("errorPage.reportComment"),
    context: {
      route: pathname.slice(0, 300),
      url: (typeof window === "undefined" ? pathname : window.location.href).slice(0, 2000),
      status: api?.status ?? 0,
      code: (api?.code ?? "client_error").slice(0, 300),
      request: api?.request?.slice(0, 2000) ?? null,
      at,
      tenantId: session?.activeTenantId ?? null,
      userId: session?.user.id ?? null,
      release: appRelease(),
      sentryEventId: api?.sentryEventId ?? null,
    },
    onSent: () => setSent(true),
  };
  return { send: () => start(report), sent };
}

function ReportButton({ report }: { report: Report | undefined }) {
  const { t } = useI18n();
  if (!report?.send) return null;
  if (report.sent) {
    return (
      <p className="text-sm text-ink-muted" role="status" data-testid="error-reported">
        {t("errorPage.reported")}
      </p>
    );
  }
  return (
    <Button variant="ghost" size="sm" onClick={report.send} data-testid="error-report">
      {t("errorPage.report")}
    </Button>
  );
}

function DeadEnd({
  error,
  kind,
  pathname,
  report,
}: {
  error: unknown;
  kind: "not_found" | "forbidden";
  pathname: string;
  report: Report;
}) {
  const { t } = useI18n();
  const page = pageResource(pathname);
  const missingConnection = kind === "not_found" && page.kind === "connection";
  const title =
    kind === "forbidden"
      ? t("errorPage.forbidden.title")
      : missingConnection
        ? t("errorPage.connection.title")
        : t(`errorPage.notFound.${page.kind === "connection" ? "page" : page.kind}`);
  const line =
    kind === "forbidden"
      ? null
      : missingConnection
        ? t("errorPage.connection.line")
        : t("errorPage.notFound.line");
  const back = kind === "forbidden" ? page.home : page.back;
  // TODO(error pages): offer "Switch to <client>" when the item is another of the person's
  // clients'. The API can't say so without looking in every client the person belongs to, so not
  // yet.
  return (
    <div
      className="ds-empty ui-empty"
      data-testid={kind === "forbidden" ? "error-forbidden" : "error-not-found"}
      {...(isApiError(error) ? { "data-error-code": error.code } : {})}
    >
      <span className="ui-empty__icon" aria-hidden="true">
        <Icon name="info" size={20} />
      </span>
      <div className="ui-empty__text">
        <p className="ui-empty__title">{title}</p>
        {line ? <div className="ui-empty__line">{line}</div> : null}
      </div>
      <div className="flex flex-wrap items-center justify-center gap-2">
        <Link
          to={back.to}
          className={buttonClass("primary", undefined, "sm")}
          data-testid="error-back"
        >
          {t(back.label)}
        </Link>
        <ReportButton report={report} />
      </div>
    </div>
  );
}

function ErrorBanner({
  error,
  onRetry,
  kind,
  report,
}: {
  error: unknown;
  onRetry: (() => void) | undefined;
  kind: ErrorKind;
  report?: Report;
}) {
  const i18n = useI18n();
  // A failure reads in plain words, never the API's message; anything else as before.
  const message =
    kind === "failure"
      ? i18n.t("errorPage.failure")
      : kind === "not_found"
        ? i18n.t("error.not_found")
        : kind === "forbidden"
          ? i18n.t("error.forbidden")
          : errorText(error, i18n);
  const retry = kind === "failure" || kind === "other" ? onRetry : undefined;
  return (
    <div
      role="alert"
      className={cx("ds-banner items-center", kind === "failure" && "flex-wrap")}
      data-testid={kind === "failure" ? "error-failure" : undefined}
      {...(isApiError(error) ? { "data-error-code": error.code } : {})}
    >
      <Icon name="alert" className="mt-px" />
      <span className="min-w-0 flex-1">{message}</span>
      {retry ? (
        <Button variant="ghost" size="sm" onClick={retry} className="text-risk">
          {i18n.t("common.tryAgain")}
        </Button>
      ) : null}
      {kind === "failure" ? <ReportButton report={report} /> : null}
    </div>
  );
}
