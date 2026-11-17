// A screen that throws while rendering shows a plain notice with "Try again" in its own place,
// instead of blanking the app: around the routed page inside the frame (../shell/Shell.tsx), so
// the sidebar and the top bar stay usable, and around parts of a page that one bad item shouldn't
// take down (the Desk's open card, a run's step panel). Changing `resetKey` (the address, the
// item) clears it, as "Try again" does.
//
// DECISION: the boundary reports nothing itself. React hands every error a boundary catches to
// createRoot's `onCaughtError` (../main.tsx), which already sends it to Sentry with its component
// stack, or reloads the page for a screen's file from an old build; reporting here too would send
// each crash twice.
import { Component, type ReactNode } from "react";
import { useI18n } from "../i18n/i18n";
import { ErrorNotice } from "./ErrorState";

interface Props {
  children: ReactNode;
  /** When it changes (a new address, another item), a caught error is cleared. */
  resetKey?: unknown;
  /** Inside a page (a card, a panel): no page padding of its own. */
  inline?: boolean;
  testId?: string;
}

interface State {
  failed: boolean;
}

export class ErrorBoundary extends Component<Props, State> {
  override state: State = { failed: false };

  static getDerivedStateFromError(): State {
    return { failed: true };
  }

  override componentDidUpdate(prev: Props): void {
    if (this.state.failed && !Object.is(prev.resetKey, this.props.resetKey)) {
      this.setState({ failed: false });
    }
  }

  private readonly retry = () => this.setState({ failed: false });

  override render(): ReactNode {
    if (!this.state.failed) return this.props.children;
    return (
      <CrashNotice
        onRetry={this.retry}
        inline={this.props.inline ?? false}
        testId={this.props.testId ?? "screen-crash"}
      />
    );
  }
}

/** The fallback: ErrorNotice in plain words, never the exception's own message. */
function CrashNotice({
  onRetry,
  inline,
  testId,
}: {
  onRetry: () => void;
  inline: boolean;
  testId: string;
}) {
  const { t } = useI18n();
  return (
    <div className={inline ? undefined : "ui-page"} data-testid={testId}>
      <ErrorNotice error={new Error(t("errorPage.crash"))} onRetry={onRetry} />
    </div>
  );
}
