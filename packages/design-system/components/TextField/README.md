# TextField

Single- and multi-line text entry with the label above.

- Consumer provides: a `<label class="ds-field">` holding a `ds-label` span and an `ds-input` or `ds-textarea`.
- Mark optional fields with `<span class="ds-opt">optional</span>`; never asterisk required ones.
- Border is `line-strong` (3:1+); focus swaps it for `focus-ring` and adds the `focus-halo`.
- Errors: add `ds-input--error` and `aria-invalid`, then a `ds-error` line saying what to fix.
