/*
 * Measuring mezonas.com, the page's half (docs/marketing-plan.md §4.3; ported from Plenary Labs'
 * `apps/site/public/track.js`, copied, not shared). build.mjs inlines it into every page, with
 * the collector's address in place of __MEASURE_URL__, only when MEZONAS_MEASURE_URL is set.
 * This comment is not inlined.
 *
 * What it reports, to the Marketing pack's collector and nobody else:
 *
 * - a view of this page: its path, the campaign tags in its address and the referrer, and
 *   whether the browser says it is driven by automation (`navigator.webdriver`);
 * - time engaged: milliseconds the page was in view with the reader active (a key, a click, a
 *   scroll or a pointer moving within the last 30 seconds), and how far down they got, in
 *   quarters, sent when the page is hidden or left;
 * - a click on an element marked `data-track`, with where it sits on the page, in %;
 * - a form marked `data-form` coming into sight, once per form (the site has none today).
 *
 * It sets no cookie and stores nothing in the browser. Each page load gets a random id so its
 * reports can be put together; the id is forgotten with the page. A browser that sends Global
 * Privacy Control or Do Not Track is not measured at all: nothing is sent. Every failure is
 * swallowed, so measuring can never stop the page working. The body is text/plain, so the
 * browser sends it without a preflight; the collector answers 204 to everything.
 */
(() => {
  if (navigator.globalPrivacyControl === true || navigator.doNotTrack === "1") return;
  try {
    const URL_ = __MEASURE_URL__;
    const ACTIVE_WINDOW_MS = 30000;

    const newId = () => {
      if (crypto.randomUUID) return crypto.randomUUID();
      const b = crypto.getRandomValues(new Uint8Array(16));
      b[6] = (b[6] & 0x0f) | 0x40;
      b[8] = (b[8] & 0x3f) | 0x80;
      const h = Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
      return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
    };

    const send = (events) => {
      try {
        const body = JSON.stringify({ events });
        if (navigator.sendBeacon?.(URL_, body)) return;
        fetch(URL_, {
          method: "POST",
          body,
          keepalive: true,
          mode: "no-cors",
          credentials: "omit",
          headers: { "content-type": "text/plain" },
        }).catch(() => {});
      } catch {
        // Measuring must never break the page.
      }
    };

    const path = location.pathname;
    let viewId = newId();

    const view = () =>
      send([
        {
          k: "view",
          id: viewId,
          p: path,
          q: location.search.slice(0, 2048),
          r: document.referrer.slice(0, 2048),
          ...(navigator.webdriver === true ? { wd: true } : {}),
        },
      ]);

    let engagedMs = 0;
    let lastActive = Date.now();
    let lastTick = Date.now();
    let quarter = 0;
    let reportedQuarter = 0;
    let reported = false;

    const scrollQuarter = () => {
      const height = document.documentElement.scrollHeight;
      if (height <= 0) return 0;
      const seen = Math.min(1, (window.scrollY + window.innerHeight) / height);
      return Math.max(0, Math.min(4, Math.floor(seen * 4 + 0.0001)));
    };
    const tick = () => {
      const now = Date.now();
      if (document.visibilityState === "visible" && now - lastActive < ACTIVE_WINDOW_MS) {
        engagedMs += Math.min(now - lastTick, 5000);
      }
      lastTick = now;
    };
    const active = () => {
      tick();
      lastActive = Date.now();
    };
    for (const type of ["keydown", "pointerdown", "pointermove", "scroll", "touchstart", "wheel"]) {
      window.addEventListener(type, active, { passive: true, capture: true });
    }
    window.addEventListener(
      "scroll",
      () => {
        quarter = Math.max(quarter, scrollQuarter());
      },
      { passive: true },
    );
    setInterval(tick, 1000);

    const reportEngagement = () => {
      tick();
      quarter = Math.max(quarter, scrollQuarter());
      const ms = Math.min(Math.round(engagedMs), 3600000);
      if (reported && ms === 0 && quarter === reportedQuarter) return;
      send([{ k: "engage", id: viewId, p: path, ms, s: quarter }]);
      engagedMs = 0;
      reportedQuarter = quarter;
      reported = true;
    };
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "hidden") reportEngagement();
      else lastTick = lastActive = Date.now();
    });
    window.addEventListener("pagehide", reportEngagement);
    // Back to this page from the history cache: a view again, with an id of its own.
    window.addEventListener("pageshow", (event) => {
      if (!event.persisted) return;
      viewId = newId();
      engagedMs = 0;
      reported = false;
      quarter = reportedQuarter = scrollQuarter();
      lastTick = lastActive = Date.now();
      view();
    });

    // Where an element sits, as % of the page's height; one in the sticky header is at the top.
    const placeOf = (element) => {
      for (let node = element; node && node !== document.body; node = node.parentElement) {
        const position = getComputedStyle(node).position;
        if (position === "fixed" || position === "sticky") {
          return node.getBoundingClientRect().top < window.innerHeight / 2 ? 0 : 100;
        }
      }
      const height = document.documentElement.scrollHeight || 1;
      const top = element.getBoundingClientRect().top + window.scrollY;
      return Math.max(0, Math.min(100, Math.round((top / height) * 100)));
    };
    document.addEventListener(
      "click",
      (event) => {
        const target =
          event.target instanceof Element ? event.target.closest("[data-track]") : null;
        const name = target?.getAttribute("data-track");
        if (!target || !name) return;
        send([{ k: "click", id: viewId, p: path, n: name, y: placeOf(target) }]);
      },
      { capture: true },
    );

    if ("IntersectionObserver" in window) {
      const seen = new Set();
      const observer = new IntersectionObserver(
        (entries) => {
          for (const entry of entries) {
            const form = entry.target.getAttribute("data-form") || "form";
            if (!entry.isIntersecting || seen.has(form)) continue;
            seen.add(form);
            send([{ k: "form_seen", id: viewId, p: path, f: form.slice(0, 40) }]);
            observer.unobserve(entry.target);
          }
        },
        { threshold: 0.5 },
      );
      for (const form of document.querySelectorAll("form[data-form]")) observer.observe(form);
    }

    quarter = reportedQuarter = scrollQuarter();
    view();
  } catch {
    // Measuring must never break the page.
  }
})();
