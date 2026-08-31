export type MeasuredClipRow = {
  rowIndex: number;
  top: number;
  bottom: number;
  clipIds: string[];
};

export type ClipPlaybackWindowInput = {
  rows: MeasuredClipRow[];
  viewportTop: number;
  viewportBottom: number;
  marginPx: number;
  requestedCap: number;
  hardCap: number;
};

export type ClipPlaybackWindowResult = {
  visibleIds: Set<string>;
  grantedIds: Set<string>;
  firstVisibleRow: number | null;
  lastVisibleRow: number | null;
  visibleCountExceededHardCap: boolean;
};

/**
 * Pure selection of visible and granted clip playback IDs from measured row rectangles.
 *
 * Does not read the DOM or React state.
 *
 * 1. Intersection requires `row.bottom > bandTop && row.top < bandBottom`.
 * 2. Grant every visible tile first.
 * 3. If capacity remains, grant prewarm tiles nearest the viewport center.
 * 4. Never exceed `hardCap`.
 * 5. If visible tiles exceed `hardCap`, grant visible tiles nearest viewport center and set overflow flag.
 */
export function selectClipPlaybackWindow(
  input: ClipPlaybackWindowInput,
): ClipPlaybackWindowResult {
  const { rows, viewportTop, viewportBottom, marginPx, requestedCap, hardCap } = input;
  const visibleIds = new Set<string>();
  const grantedIds = new Set<string>();

  const maxCap = Math.max(0, Math.floor(hardCap));
  if (
    !Number.isFinite(viewportTop) ||
    !Number.isFinite(viewportBottom) ||
    viewportBottom <= viewportTop ||
    maxCap <= 0 ||
    !Array.isArray(rows) ||
    rows.length === 0
  ) {
    return {
      visibleIds,
      grantedIds,
      firstVisibleRow: null,
      lastVisibleRow: null,
      visibleCountExceededHardCap: false,
    };
  }

  const validRows: MeasuredClipRow[] = [];
  for (const row of rows) {
    if (
      row &&
      Number.isFinite(row.top) &&
      Number.isFinite(row.bottom) &&
      row.bottom > row.top &&
      Array.isArray(row.clipIds)
    ) {
      validRows.push(row);
    }
  }

  if (validRows.length === 0) {
    return {
      visibleIds,
      grantedIds,
      firstVisibleRow: null,
      lastVisibleRow: null,
      visibleCountExceededHardCap: false,
    };
  }

  const margin = Math.max(0, Number.isFinite(marginPx) ? marginPx : 0);
  const bandTop = viewportTop - margin;
  const bandBottom = viewportBottom + margin;
  const viewportCenter = (viewportTop + viewportBottom) / 2;

  const visibleRows: MeasuredClipRow[] = [];
  const prewarmRows: MeasuredClipRow[] = [];

  let firstVisibleRow: number | null = null;
  let lastVisibleRow: number | null = null;

  for (const row of validRows) {
    const isVisible = row.bottom > viewportTop && row.top < viewportBottom;
    if (isVisible) {
      visibleRows.push(row);
      if (firstVisibleRow === null || row.rowIndex < firstVisibleRow) {
        firstVisibleRow = row.rowIndex;
      }
      if (lastVisibleRow === null || row.rowIndex > lastVisibleRow) {
        lastVisibleRow = row.rowIndex;
      }
      for (const clipId of row.clipIds) {
        if (clipId) visibleIds.add(clipId);
      }
    } else {
      const isPrewarm = row.bottom > bandTop && row.top < bandBottom;
      if (isPrewarm) {
        prewarmRows.push(row);
      }
    }
  }

  const visibleCountExceededHardCap = visibleIds.size > maxCap;

  if (visibleCountExceededHardCap) {
    // When visible tiles exceed hard cap, sort visible rows by distance to viewport center
    const sortedVisible = [...visibleRows].sort((a, b) => {
      const distA = Math.abs((a.top + a.bottom) / 2 - viewportCenter);
      const distB = Math.abs((b.top + b.bottom) / 2 - viewportCenter);
      if (distA !== distB) return distA - distB;
      return a.rowIndex - b.rowIndex;
    });

    for (const row of sortedVisible) {
      for (const clipId of row.clipIds) {
        if (!clipId) continue;
        grantedIds.add(clipId);
        if (grantedIds.size >= maxCap) break;
      }
      if (grantedIds.size >= maxCap) break;
    }

    return {
      visibleIds,
      grantedIds,
      firstVisibleRow,
      lastVisibleRow,
      visibleCountExceededHardCap: true,
    };
  }

  // Grant all visible tiles first
  for (const clipId of visibleIds) {
    grantedIds.add(clipId);
  }

  const effectiveCap = Math.min(
    maxCap,
    Math.max(Math.max(0, Math.floor(requestedCap) || 0), visibleIds.size),
  );

  if (grantedIds.size < effectiveCap && prewarmRows.length > 0) {
    const sortedPrewarm = [...prewarmRows].sort((a, b) => {
      const distA = Math.abs((a.top + a.bottom) / 2 - viewportCenter);
      const distB = Math.abs((b.top + b.bottom) / 2 - viewportCenter);
      if (distA !== distB) return distA - distB;
      return a.rowIndex - b.rowIndex;
    });

    for (const row of sortedPrewarm) {
      for (const clipId of row.clipIds) {
        if (!clipId) continue;
        grantedIds.add(clipId);
        if (grantedIds.size >= effectiveCap) break;
      }
      if (grantedIds.size >= effectiveCap) break;
    }
  }

  return {
    visibleIds,
    grantedIds,
    firstVisibleRow,
    lastVisibleRow,
    visibleCountExceededHardCap: false,
  };
}
