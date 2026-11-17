// Reporting something that can happen on every request without reporting it every time: the
// calls in this isolate are counted, and `report` is called at most once per window with how many
// there were since the last report (and the latest value, e.g. the last error).

export function sampled<T = undefined>(
  report: (count: number, latest: T) => void,
  windowMs = 60_000,
  now: () => number = Date.now,
): (latest: T) => void {
  let count = 0;
  let last = Number.NEGATIVE_INFINITY;
  return (latest) => {
    count += 1;
    const t = now();
    if (t - last < windowMs) return;
    last = t;
    const n = count;
    count = 0;
    report(n, latest);
  };
}
