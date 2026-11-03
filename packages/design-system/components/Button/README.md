# Button

Buttons trigger actions; one primary (`ds-btn--primary`, `slate` fill) per view.

- Consumer provides: a `<button>` with `ds-btn` plus one variant (`--primary`, `--secondary`, `--ghost`, `--link`) and optionally `--sm` or `--icon`.
- Labels name the action: "Sign", "Ask a question", "Add vendor" — never "Submit" or "Continue". Approving an action is always "Sign".
- Icon-only buttons carry a `title`; icons are 16px Mezonas icons.
- `radius-md`. Press scales to .97 over 120ms; hover steps the background. No lift, no glow.
- Focus: a 2px `focus-ring` plus the `focus-halo`.
