// The still frame (docs/audit-plan.md 1.1) as React draws it: the twin of the one in index.html's
// #root, shown while the session (and its language) is not known yet and while the back office's
// chunk loads, so the first picture holds from the first byte to the first screen. A test
// (StillFrame.test.tsx) keeps the two the same; styles are the shell's, plus `.ui-frame__*` in
// styles.css.
import logo from "@countersign/design-system/assets/Logos/mezonas-logo.svg";
import logoPaper from "@countersign/design-system/assets/Logos/mezonas-logo-paper.svg";
import mark from "@countersign/design-system/assets/Logos/mezonas-mark.svg";
import markPaper from "@countersign/design-system/assets/Logos/mezonas-mark-paper.svg";
import { useI18n } from "../i18n/i18n";

const NAV = ["long", "half", "long", "short", "half", "long"] as const;

export function StillFrame() {
  const { t } = useI18n();
  return (
    <div className="ui-shell ui-frame" data-testid="still-frame">
      <p className="sr-only" role="status">
        {t("common.loading")}
      </p>
      <div aria-hidden="true" className="ds-header ui-topbar">
        <span className="ui-skel ui-topbar__menu ui-frame__menu" />
        <span className="ui-topbar__logo">
          <span className="ui-topbar__lockup">
            <img src={logo} alt="" width="130" height="18" className="theme-light-only" />
            <img src={logoPaper} alt="" width="130" height="18" className="theme-dark-only" />
          </span>
          <span className="ui-topbar__mark">
            <img src={mark} alt="" width="28" height="28" className="theme-light-only" />
            <img src={markPaper} alt="" width="28" height="28" className="theme-dark-only" />
          </span>
        </span>
        <span className="ui-topbar__sep" />
        <span className="ui-skel ui-frame__context" />
        <span className="ui-topbar__search">
          <span className="ui-skel ui-frame__search" />
        </span>
        <span className="ui-skel ui-frame__avatar" />
      </div>
      <div aria-hidden="true" className="ui-shell__body">
        <aside className="ds-sidebar ui-sidebar">
          <span className="ui-sidebar__nav">
            {NAV.map((width, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: fixed placeholder rows.
              <span key={i} className="ds-navitem ui-navitem ui-navskel">
                <span className={`ui-skel ui-frame__nav ui-frame__nav--${width}`} />
              </span>
            ))}
          </span>
        </aside>
        <main className="ui-main">
          <span className="ui-skel-page">
            <span className="ui-skel-line ui-skel-line--heading">
              <span className="ui-skel ui-frame__heading" />
            </span>
            <span className="ds-card ui-skel-card ui-frame__card" />
            <span className="ds-card ui-skel-card ui-frame__card" />
          </span>
        </main>
      </div>
    </div>
  );
}
