// What a crashed screen looks like to the route sweep and the walkthroughs (./harness.mjs
// `checkPage`): React unmounted the root (an empty #root), or an error boundary caught the crash
// and shows its fallback (apps/web/src/ui/ErrorBoundary.tsx, `data-testid="screen-crash"`). A
// caught crash leaves #root full and, with Sentry off as in the sweep's build, nothing else on the
// page says so; this is what does.

/**
 * The crashes a document shows, as problem lines; none for a healthy page. Self-contained: the
 * harness runs it in the page (`page.evaluate(crashesIn)`), so it may use nothing from this file.
 */
export function crashesIn(doc = document) {
  const out = [];
  if (!doc.getElementById("root")?.children.length) {
    out.push("the screen crashed: #root is empty");
  }
  for (const el of doc.querySelectorAll('[data-testid="screen-crash"]')) {
    const part = el.getAttribute("data-crash-part") || "page";
    out.push(`the screen crashed: the ${part} shows the error fallback`);
  }
  return out;
}
