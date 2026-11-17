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
  /**
   * A part of a page (the Desk's card, a step panel), named for the screen sweep: the notice then
   * says this part could not be shown, without page padding of its own. Left out: the whole page.
   */
  part?: string;
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
    return <CrashNotice onRetry={this.retry} part={this.props.part ?? null} />;
  }
}

/**
 * The fallback: ErrorNotice in plain words, never the exception's own message. Every one carries
 * `data-testid="screen-crash"` (and the part's name), which the screen sweep looks for
 * (apps/web/e2e/crash.mjs): a caught crash leaves #root full and logs nothing on its own.
 */
function CrashNotice({ onRetry, part }: { onRetry: () => void; part: string | null }) {
  const { t } = useI18n();
  return (
    <div
      className={part ? undefined : "ui-page"}
      data-testid="screen-crash"
      data-crash-part={part ?? "page"}
    >
      <ErrorNotice
        error={new Error(t(part ? "errorPage.crashPart" : "errorPage.crash"))}
        onRetry={onRetry}
      />
    </div>
  );
}
