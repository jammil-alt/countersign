# Motion

How an agent's step shows what kind of thinking it is doing while it runs, and how a job with a
known end shows how far it has got. `motion.css`, loaded after `tokens.css`; `preview.html` is the
delivery as the owner sent it (open it for the motion large and at real size, with markup).

| Use when the agent is… | Component | Class |
|---|---|---|
| Processing or loading | Weighing or Tracing (interchangeable; Tracing for fetching, connecting, matching, reconciling) | `mz-think--weighing`, `mz-think--tracing` |
| Writing (drafts, summaries, replies) | Drafting | `mz-think--drafting` |
| Reviewing its own work before it goes to the Mezonas lead | Rechecking | `mz-think--rechecking` |
| Working toward a known total (0–100%) | Ruler or Sheets (interchangeable) | `mz-progress--ruler`, `mz-progress--sheets` |

- Consumer provides: for a thinking state, a `span.mz-think.mz-think--<state>` with `aria-hidden="true"` and its children exactly as `preview.html` shows them (`<i>`s and a `<b>`, or Tracing's SVG); the step's words carry the meaning, in a `role="status"` region so screen readers hear step changes. For progress, `role="progressbar"` with `aria-valuenow`, and the 41 ruler ticks or 10 sheets (each sheet's `--fill`, 0–1, and `is-started`; each tick's `is-on` when `tick × 2.5 ≤ percent`).
- Every icon is 24px. `--mz-pace` multiplies every loop's duration (1 default, 2 half speed).
- Under `prefers-reduced-motion` the loops stop on a still frame; progress still updates.
- Colours are tokens, so the dark theme works.
