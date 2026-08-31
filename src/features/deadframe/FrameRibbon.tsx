import React from "react";

/**
 * The exposure sheet under the sensitivity dial.
 *
 * One tick per frame, left to right: a kept frame is a solid full-height tick
 * in the theme accent, a dropped frame is a short dim one. Dragging the dial
 * makes the dropped frames visibly fall away.
 *
 * The component is handed the SAME boolean array the kept/removed numbers are
 * derived from, and it derives the numbers it prints from that same array, so
 * the picture and the text beside it can never disagree.
 */

// A ten-minute clip is ~14,000 frames; one DOM node each would cost more than
// the whole panel. Past this many frames each column becomes a bucket and its
// look comes from how much of that bucket was dropped.
export const RIBBON_COLUMNS = 240;

/**
 * Collapse per-frame keep/drop flags into at most `columns` values, each the
 * FRACTION of the frames behind it that were dropped (0 = all kept, 1 = all
 * dropped). Bucket boundaries are evenly spread across the real frame range,
 * so every frame lands in exactly one column and no position is invented.
 * With `flags.length <= columns` it is one column per frame, giving exactly
 * 0 or 1 per column.
 */
export function ribbonColumns(flags: boolean[], columns: number = RIBBON_COLUMNS): number[] {
  const total = flags.length;
  if (total === 0) return [];
  if (total <= columns) return flags.map((kept) => (kept ? 0 : 1));

  const out: number[] = new Array(columns);
  for (let index = 0; index < columns; index += 1) {
    const start = Math.floor((index * total) / columns);
    const end = Math.floor(((index + 1) * total) / columns);
    const last = Math.max(end, start + 1);
    let dropped = 0;
    for (let frame = start; frame < last; frame += 1) {
      if (!flags[frame]) dropped += 1;
    }
    out[index] = dropped / (last - start);
  }
  return out;
}

export function FrameRibbon({
  flags,
  action,
}: {
  /** One entry per frame of the selected clip, or null when nothing is measured. */
  flags: boolean[] | null;
  /** Optional control parked at the right end of the counts line. */
  action?: React.ReactNode;
}) {
  const columns = React.useMemo(
    () => (flags && flags.length > 0 ? ribbonColumns(flags) : []),
    [flags],
  );

  if (!flags || flags.length === 0) {
    return (
      <div className="deadframe-ribbon is-empty">
        <div className="deadframe-ribbon-strip" aria-hidden="true">
          <div className="deadframe-ribbon-baseline" />
        </div>
        {action ? (
          <div className="deadframe-ribbon-counts">
            <span />
            <span />
            {action}
          </div>
        ) : null}
      </div>
    );
  }

  let kept = 0;
  for (const flag of flags) if (flag) kept += 1;
  const removed = flags.length - kept;

  return (
    <div className="deadframe-ribbon">
      <div className="deadframe-ribbon-strip" aria-hidden="true">
        {columns.map((drop, index) => (
          <i
            className="deadframe-ribbon-tick"
            data-drop={String(drop)}
            style={{ "--drop": drop } as React.CSSProperties}
            key={index}
          />
        ))}
      </div>
      <div className="deadframe-ribbon-counts">
        <span className="deadframe-ribbon-kept">{kept} kept</span>
        <span className="deadframe-ribbon-removed">{removed} removed</span>
        {action}
      </div>
    </div>
  );
}
