// Small pieces the screens share: icons from the design system's sprite, the connection pill,
// times in plain words, and the bridge to the main process.
import type { DesktopBridge, DesktopView } from "../shared/ipc";

declare global {
  interface Window {
    mezonas: DesktopBridge;
  }
}

export const bridge = (): DesktopBridge => window.mezonas;

export type IconName =
  | "table"
  | "desk"
  | "document"
  | "worksheet"
  | "settings"
  | "notifications"
  | "check"
  | "alert"
  | "info"
  | "close"
  | "add"
  | "upload"
  | "arrow"
  | "report";

/**
 * An icon from the sprite (main.tsx puts it in the page once). Decorative: the button or row it
 * sits in carries the words.
 */
export function Icon({ name }: { name: IconName }) {
  return (
    <svg className="icon" aria-hidden="true">
      <use href={`#mz-${name}`} />
    </svg>
  );
}

export function ConnectionPill({ view }: { view: DesktopView }) {
  switch (view.connection) {
    case "online":
      return <span className="ds-pill ds-pill--positive">Connected</span>;
    case "offline":
      return <span className="ds-pill ds-pill--risk">Can't reach Mezonas</span>;
    case "waiting":
      return <span className="ds-pill ds-pill--neutral">Waiting for Mezonas</span>;
    case "unpaired":
      return <span className="ds-pill ds-pill--neutral">Not added</span>;
    default:
      return <span className="ds-pill ds-pill--neutral">Starting</span>;
  }
}

/** "Just now", "12 min ago", "Yesterday 16:40", "14 Nov 09:02". */
export function when(iso: string | null, now = new Date()): string {
  if (!iso) return "Not yet";
  const t = new Date(iso);
  const mins = Math.round((now.getTime() - t.getTime()) / 60_000);
  if (mins < 1) return "Just now";
  if (mins < 60) return `${mins} min ago`;
  const time = t.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  const day = new Date(now);
  day.setHours(0, 0, 0, 0);
  if (t >= day) return `Today ${time}`;
  day.setDate(day.getDate() - 1);
  if (t >= day) return `Yesterday ${time}`;
  return `${t.toLocaleDateString(undefined, { day: "numeric", month: "short" })} ${time}`;
}

export function Notice({ view }: { view: DesktopView }) {
  if (!view.notice) return null;
  const close = (
    <button
      type="button"
      className="ds-btn ds-btn--ghost ds-btn--icon ds-btn--sm"
      title="Dismiss"
      aria-label="Dismiss"
      onClick={() => void bridge().dismissNotice()}
    >
      <Icon name="close" />
    </button>
  );
  if (view.notice.tone === "risk") {
    return (
      <div className="ds-banner notice" role="alert">
        <span>{view.notice.text}</span>
        {close}
      </div>
    );
  }
  return (
    <div className="notice notice--info" role="status">
      <span>{view.notice.text}</span>
      {close}
    </div>
  );
}
