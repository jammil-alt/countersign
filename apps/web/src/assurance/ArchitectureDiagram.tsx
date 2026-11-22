// An agent's architecture, drawn from its setup (docs/agent-assurance-plan.md §3): the trust zones as
// columns (your business, Mezonas, AI providers), each box stacked in its zone, and the flows between
// them with the controls on each. Laid out by code: the same view always draws the same picture.
// Design-system tokens only (styles.css, `.arch`); people in copper, AI flows dashed.

import type { Architecture } from "@countersign/core";
import { useMemo } from "react";

const W = 1000;
const TOP = 46;
const GAP = 12;
const LINE = 15;
const OUTSIDE = { x: 770, w: 222 };
// The gutters between zones hold the flows' words, wrapped to fit.
const COLS: Record<string, { x: number; w: number }> = {
  business: { x: 8, w: 232 },
  mezonas: { x: 384, w: 262 },
  ai: OUTSIDE,
  outside: OUTSIDE,
};
/** A flow carries at most this many control ids; the SOP's section 6 lists every one. */
const MAX_REFS = 5;

/** Words wrapped to `max` characters a line. */
export function wrap(text: string, max: number): string[] {
  const out: string[] = [];
  let line = "";
  for (const word of text.split(/\s+/)) {
    if (line && `${line} ${word}`.length > max) {
      out.push(line);
      line = word;
    } else {
      line = line ? `${line} ${word}` : word;
    }
  }
  if (line) out.push(line);
  return out;
}

type Placed = {
  key: string;
  zone: string;
  title: string;
  lines: string[];
  person: boolean;
  x: number;
  y: number;
  w: number;
  h: number;
};

export function layoutArchitecture(arch: Architecture) {
  const placed: Placed[] = [];
  const bottom: Record<string, number> = {};
  for (const z of arch.zones) bottom[z.key] = TOP;
  for (const b of arch.boxes) {
    const col = COLS[b.zone] ?? OUTSIDE;
    const w = col.w - 24;
    const lines = b.lines.flatMap((l) => wrap(l, Math.floor((w - 24) / 6.2)));
    const h = 30 + lines.length * LINE + 6;
    const y = bottom[b.zone] ?? TOP;
    placed.push({ ...b, lines, x: col.x + 12, y, w, h });
    bottom[b.zone] = y + h + GAP;
  }
  const height = Math.max(...Object.values(bottom), TOP + 60) + 4;
  return { placed, height };
}

export function ArchitectureDiagram({ arch, label }: { arch: Architecture; label: string }) {
  const { placed, height } = useMemo(() => layoutArchitecture(arch), [arch]);
  const at = new Map(placed.map((p) => [p.key, p]));
  return (
    <svg
      className="arch"
      viewBox={`0 0 ${W} ${height}`}
      role="img"
      aria-label={label}
      data-testid="arch-diagram"
    >
      <defs>
        <marker
          id="arch-arrow"
          viewBox="0 0 10 10"
          refX="9"
          refY="5"
          markerWidth="7"
          markerHeight="7"
          orient="auto-start-reverse"
        >
          <path d="M0 0 L10 5 L0 10 z" className="arch-arrowhead" />
        </marker>
      </defs>
      {arch.zones.map((z) => {
        const col = COLS[z.key] ?? OUTSIDE;
        return (
          <g key={z.key}>
            <rect
              className="arch-zone"
              x={col.x}
              y={8}
              width={col.w}
              height={height - 12}
              rx={10}
            />
            <text className="arch-zone-title" x={col.x + 14} y={32}>
              {z.title}
            </text>
          </g>
        );
      })}
      {placed.map((b) => (
        <g key={b.key} data-box={b.key}>
          <rect
            className={b.person ? "arch-box arch-box--person" : "arch-box"}
            x={b.x}
            y={b.y}
            width={b.w}
            height={b.h}
            rx={8}
          />
          <text className={b.person ? "arch-t1 arch-tp" : "arch-t1"} x={b.x + 12} y={b.y + 21}>
            {b.title}
          </text>
          {b.lines.map((l, i) => (
            <text
              // biome-ignore lint/suspicious/noArrayIndexKey: wrapped lines of one box, in order.
              key={i}
              className={b.person ? "arch-t2 arch-tp" : "arch-t2"}
              x={b.x + 12}
              y={b.y + 38 + i * LINE}
            >
              {l}
            </text>
          ))}
        </g>
      ))}
      {arch.flows.map((f) => {
        const a = at.get(f.from);
        const b = at.get(f.to);
        if (!a || !b) return null;
        let d: string;
        let lx: number;
        let ly: number;
        let room = 20;
        if (a.zone === b.zone) {
          const down = a.y < b.y;
          const x = Math.round(Math.min(a.x, b.x) + Math.min(a.w, b.w) / 2);
          const y1 = down ? a.y + a.h : a.y;
          const y2 = down ? b.y : b.y + b.h;
          d = `M${x} ${y1} V${y2}`;
          lx = x + 8;
          ly = (y1 + y2) / 2 + 4;
        } else {
          const right = a.x < b.x;
          const x1 = right ? a.x + a.w : a.x;
          const x2 = right ? b.x : b.x + b.w;
          const y1 = Math.round(a.y + Math.min(a.h / 2, 30));
          const y2 = Math.round(b.y + Math.min(b.h / 2, 30));
          const xm = Math.round((x1 + x2) / 2);
          d = y1 === y2 ? `M${x1} ${y1} H${x2}` : `M${x1} ${y1} H${xm} V${y2} H${x2}`;
          lx = Math.min(x1, x2) + 8;
          ly = Math.min(y1, y2) - 6;
          room = Math.floor((Math.abs(x2 - x1) - 16) / 6);
        }
        // Inside one zone the arrow is short: its control ids go on the label's line.
        const inline = a.zone === b.zone;
        const words = inline
          ? [[f.label, ...f.refs.slice(0, MAX_REFS)].join("  ")]
          : wrap(f.label, room);
        const refs = wrap(
          [...f.refs.slice(0, MAX_REFS), ...(f.refs.length > MAX_REFS ? ["…"] : [])].join(" "),
          room,
        );
        return (
          <g key={`${f.from}>${f.to}`}>
            <path
              className={f.ai ? "arch-flow arch-flow--ai" : "arch-flow"}
              d={d}
              markerEnd="url(#arch-arrow)"
            />
            {words.map((w, i) => (
              <text
                // biome-ignore lint/suspicious/noArrayIndexKey: wrapped words of one label, in order.
                key={`l${i}`}
                className="arch-label"
                x={lx}
                y={ly - (words.length - 1 - i) * 12}
              >
                {w}
              </text>
            ))}
            {f.refs.length > 0 && !inline
              ? refs.map((r, i) => (
                  <text
                    // biome-ignore lint/suspicious/noArrayIndexKey: wrapped ids of one flow, in order.
                    key={`r${i}`}
                    className="arch-ctl"
                    x={lx}
                    y={ly + 19 + i * 12}
                  >
                    {r}
                  </text>
                ))
              : null}
          </g>
        );
      })}
    </svg>
  );
}
