/* The marketing pages' demos (src/components.mjs renders every state they show into the page).
   This only switches between those states: it fetches nothing, stores nothing, sets no cookie
   and sends nothing. The demos advance on a 1.1-second clock while they are on screen; with
   reduced motion they stay still and show their finished state. Copied to dist/site.js. */
(() => {
  const TICK_MS = 1100;
  const still = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const all = (root, selector) => Array.from(root.querySelectorAll(selector));

  /** Calls `step` every tick while `el` is on screen and the page is visible. */
  function clock(el, step) {
    let onScreen = !("IntersectionObserver" in window);
    if (!onScreen) {
      new IntersectionObserver(
        (entries) => {
          onScreen = entries.some((e) => e.isIntersecting);
        },
        { threshold: 0.2 },
      ).observe(el);
    }
    setInterval(() => {
      if (onScreen && !document.hidden) step();
    }, TICK_MS);
  }

  /** Marks `on` pressed and the other buttons not. */
  function press(buttons, on) {
    for (const b of buttons) b.setAttribute("aria-pressed", String(b === on));
  }

  /** Shows `el` when `show`, touching it only on a change so its entry animation replays. */
  function show(el, visible) {
    if (el.hidden === visible) el.hidden = !visible;
  }

  /** The stepped line through a use case's cards (components.mjs, stepPath). */
  function stepPath(pts, k) {
    if (k < 1 || pts.length === 0) return "M0 0";
    let d = `M${pts[0][0]} ${pts[0][1]}`;
    for (let i = 1; i <= k && i < pts.length; i++) {
      d += ` H${pts[i - 1][0] + 50} V${pts[i][1]} H${pts[i][0]}`;
    }
    return d;
  }

  // Connectors: a category shows a grid of its connectors in place of the moving rows.
  for (const root of all(document, "[data-connectors]")) {
    const pills = all(root, "[data-conn-cat]");
    const rows = root.querySelector("[data-conn-all]");
    const grid = root.querySelector("[data-conn-grid]");
    for (const pill of pills) {
      pill.addEventListener("click", () => {
        const cat = pill.dataset.connCat;
        press(pills, pill);
        rows.hidden = cat !== "all";
        grid.hidden = cat === "all";
        for (const item of grid.children) item.hidden = item.dataset.cat !== cat;
      });
    }
  }

  // The gap chart: today, or with Mezonas (the dots move and the gold gaps close, in CSS).
  for (const root of all(document, "[data-gap]")) {
    const buttons = all(root, "[data-gap-view]");
    for (const b of buttons) {
      b.addEventListener("click", () => {
        press(buttons, b);
        root.classList.toggle("is-closed", b.dataset.gapView === "with");
      });
    }
  }

  // The purchasing run: five stages over the run's ticks, then round again.
  for (const root of all(document, "[data-run]")) {
    const ticks = Number(root.dataset.ticks);
    const steps = all(root, "[data-run-stage]");
    const starts = steps.map((s) => Number(s.dataset.start));
    const panels = all(root, "[data-run-panel]");
    const vendors = all(root, "[data-vendor]");
    const progress = root.querySelector("[data-run-progress]");
    const toggle = root.querySelector("[data-run-toggle]");
    const sign = root.querySelector("[data-run-sign]");
    const state = { tick: still ? ticks - 1 : 0, playing: !still, signed: false };

    const render = () => {
      let stage = 0;
      starts.forEach((start, i) => {
        if (state.tick >= start) stage = i;
      });
      steps.forEach((s, i) => {
        s.setAttribute("aria-current", i === stage ? "step" : "false");
        s.classList.toggle("is-done", i < stage);
      });
      panels.forEach((p, i) => {
        show(p, i === stage);
      });
      for (const v of vendors) {
        const answered = stage > 2 || (stage === 2 && state.tick >= Number(v.dataset.answerTick));
        show(v.querySelector("[data-vendor-wait]"), !answered);
        show(v.querySelector("[data-vendor-answer]"), answered);
        v.classList.toggle("is-picked", answered && v.hasAttribute("data-pick"));
      }
      progress.style.width = `${Math.round(((state.tick + 1) / ticks) * 100)}%`;
      toggle.textContent = state.playing ? "Pause" : state.tick === 0 ? "Play" : "Replay";
      const signed = state.signed && stage === starts.length - 1;
      sign.textContent = signed ? "Signed. Order sent." : "Sign";
      sign.classList.toggle("is-signed", signed);
    };

    toggle.addEventListener("click", () => {
      Object.assign(
        state,
        state.playing ? { playing: false } : { playing: true, tick: 0, signed: false },
      );
      render();
    });
    for (const s of steps) {
      s.addEventListener("click", () => {
        Object.assign(state, { tick: Number(s.dataset.tick), playing: false });
        render();
      });
    }
    sign.addEventListener("click", () => {
      Object.assign(state, { signed: true, playing: false });
      render();
    });
    root.querySelector("[data-run-quotes]").addEventListener("click", () => {
      Object.assign(state, { tick: starts[3] ?? 0, playing: false });
      render();
    });
    clock(root, () => {
      if (!state.playing) return;
      state.tick = (state.tick + 1) % ticks;
      if (state.tick === 0) state.signed = false;
      render();
    });
    render();
  }

  // Use cases: pick a result; its steps light up one by one along the lanes.
  for (const root of all(document, "[data-usecases]")) {
    const pills = all(root, "[data-uc]");
    const panels = all(root, "[data-uc-panel]");
    const current = pills.find((p) => p.getAttribute("aria-pressed") === "true") ?? pills[0];
    const state = { uc: current?.dataset.uc, n: 0 };

    const render = () => {
      for (const panel of panels) {
        const on = panel.dataset.ucPanel === state.uc;
        show(panel, on);
        if (!on) continue;
        const cells = all(panel, "[data-step]");
        const last = cells.length - 1;
        const n = still ? last : state.n;
        cells.forEach((c, i) => {
          c.classList.toggle("is-active", i === n && !still);
          c.classList.toggle("is-done", i < n || (still && i <= n));
        });
        const svg = panel.querySelector("[data-points]");
        const pts = svg.dataset.points.split(" ").map((p) => p.split(",").map(Number));
        svg.querySelector("[data-done]").setAttribute("d", stepPath(pts, Math.min(n, last)));
      }
    };

    for (const pill of pills) {
      pill.addEventListener("click", () => {
        press(pills, pill);
        Object.assign(state, { uc: pill.dataset.uc, n: 0 });
        render();
      });
    }
    if (!still) {
      clock(root, () => {
        // Six steps, then a short rest on the finished line before it starts again.
        state.n = (state.n + 1) % 9;
        render();
      });
    }
    render();
  }

  // How we work with you: each step's workflow lights up node by node, then the next step.
  // Picking a step stays on it; Play goes back to moving through all four.
  for (const root of all(document, "[data-process]")) {
    const buttons = all(root, "[data-proc]");
    const panels = all(root, "[data-proc-panel]");
    const toggle = root.querySelector("[data-proc-toggle]");
    const nodesOf = (i) => all(panels[i], "[data-node]");
    const state = { step: 0, n: still ? nodesOf(0).length : 0, playing: !still, locked: false };

    const render = () => {
      buttons.forEach((b, i) => {
        b.setAttribute("aria-pressed", String(i === state.step));
        show(b.querySelector(".mk-proc__desc"), i === state.step);
      });
      panels.forEach((p, i) => {
        show(p, i === state.step);
      });
      nodesOf(state.step).forEach((node, j) => {
        node.classList.toggle("is-active", j === state.n);
        node.classList.toggle("is-done", j < state.n);
      });
      toggle.textContent = state.playing ? "Pause" : "Play";
      toggle.hidden = still;
    };

    buttons.forEach((b, i) => {
      b.addEventListener("click", () => {
        Object.assign(
          state,
          still
            ? { step: i, n: nodesOf(i).length }
            : { step: i, n: 0, playing: true, locked: true },
        );
        render();
      });
    });
    toggle.addEventListener("click", () => {
      Object.assign(state, state.playing ? { playing: false } : { playing: true, locked: false });
      render();
    });
    clock(root, () => {
      if (!state.playing) return;
      const len = nodesOf(state.step).length;
      if (state.n < len + 1 && !(state.locked && state.n >= len)) state.n += 1;
      else if (!state.locked)
        Object.assign(state, { step: (state.step + 1) % panels.length, n: 0 });
      render();
    });
    render();
  }

  // The masking demo: what you see, or what the model sees.
  for (const root of all(document, "[data-mask]")) {
    const buttons = all(root, "[data-mask-view]");
    for (const b of buttons) {
      b.addEventListener("click", () => {
        press(buttons, b);
        root.classList.toggle("is-masked", b.dataset.maskView === "ai");
      });
    }
  }
})();
