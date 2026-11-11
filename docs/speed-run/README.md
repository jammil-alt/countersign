# Speed run: shared material

- `measure.mjs`: the measurement script from `docs/audit-plan.md` appendix A, as the lead runs it.
  Copy it outside the repo before running (it needs `require("playwright")`, which works from any
  directory in the cloud containers).
- `phase0/`: phase 0's output at `1c30e45` on the demo seed. `p0-ops.txt` and `p0-portal.txt` are
  plain; the `-lat` files are with `LATENCY_MS=100`. Compare a PR's before and after against a run
  of your own on your own machine, not against these: machines differ.

The ids the lead used (Harbor Millwork, one of its runs, its Bill clerk) are fixed by the seed:

```bash
CLIENT_ID=d05e3878-9438-5523-b4b2-ef83e76a0da2 RUN_ID=65051fda-35fd-564a-a619-2b315848eb38 \
  AGENT_ID=2249ecf7-3a8e-5031-8e74-092837d39c74 node measure.mjs ops ops.json
```
