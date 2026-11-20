// The first picture (docs/audit-plan.md 1.1; owner, 2026-11-20): before the app's code runs,
// index.html shows the app's frame only to a browser that was signed in here before
// (`mz.signedIn`, set and cleared by session.tsx). Anyone else sees the Mezonas logo alone, so a
// signed-out visit goes from the logo to the sign-in without a glimpse of the app. Loaded as a
// file (the CSP allows no inline script), before the page is drawn.
(() => {
  let known = false;
  try {
    known = window.localStorage.getItem("mz.signedIn") === "1";
  } catch {
    known = false;
  }
  if (!known) document.documentElement.setAttribute("data-frame", "sign-in");
})();
