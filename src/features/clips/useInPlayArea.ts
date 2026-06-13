import React from "react";

/**
 * useInPlayArea — per-tile IntersectionObserver "play area" gate.
 *
 * Returns true exactly when `targetRef`'s element is inside (or within
 * `rootMarginPx` above/below) the visible scroll area of `rootEl`, and false
 * once it leaves. This replaces the old row-range + fixed-count budget for
 * deciding which featherweight grid tiles mount their looping offset <video>;
 * the count of playing tiles now scales automatically with viewport size and
 * column count.
 *
 * Contract:
 *  - `enabled === false` → returns false and observes nothing.
 *  - No IntersectionObserver in the runtime → returns true so non-IO runtimes
 *    (tests/SSR) still play instead of going dark.
 *  - Otherwise the observer's rootMargin is `${margin}px 0px` (vertical only,
 *    horizontal columns are always in-view in a scroll grid), threshold 0. The
 *    observer is re-created when `rootEl`, `rootMarginPx`, or `enabled` change,
 *    and disconnected on cleanup.
 *
 * Initial state is false. IntersectionObserver's first callback is delivered
 * ASYNCHRONOUSLY (a microtask/frame after observe()), so it cannot be relied on
 * to seed the resting state of a tile that mounts already on-screen during a
 * fast fling — by the time it would fire the element is at rest and no new
 * intersection boundary is crossed, so no callback arrives. To self-correct we
 * additionally schedule ONE rAF after observe() that measures the element's rect
 * against the (margin-expanded) root rect and seeds inPlayArea synchronously.
 */
export function useInPlayArea(
  targetRef: React.RefObject<HTMLElement | null>,
  rootEl: HTMLElement | null,
  rootMarginPx: number,
  enabled: boolean,
): boolean {
  const [inPlayArea, setInPlayArea] = React.useState(false);

  React.useEffect(() => {
    if (!enabled) {
      setInPlayArea(false);
      return undefined;
    }
    // Non-IO runtimes (tests/SSR): play rather than break.
    if (typeof IntersectionObserver === "undefined") {
      setInPlayArea(true);
      return undefined;
    }
    const target = targetRef.current;
    if (!target) return undefined;

    const observer = new IntersectionObserver(
      (entries) => {
        // Read the LAST entry: coalesced same-target crossings from a fast fling
        // resolve to the latest reported state, not the stale first one.
        const entry = entries[entries.length - 1];
        if (entry) setInPlayArea(entry.isIntersecting);
      },
      {
        root: rootEl ?? null,
        rootMargin: `${Math.max(0, rootMarginPx)}px 0px`,
        threshold: 0,
      },
    );
    observer.observe(target);

    // SELF-SEED the resting state. The IO's first callback is async and may
    // never fire for an element that mounts already at rest on-screen mid-fling
    // (no boundary crossed once settled). One rAF after observe(), measure the
    // element against the margin-expanded root rect and seed true if they
    // intersect vertically. (takeRecords() alone is insufficient — it returns
    // empty before the initial computation is even queued.)
    const margin = Math.max(0, rootMarginPx);
    const rafId = requestAnimationFrame(() => {
      const el = targetRef.current;
      if (!el) return;
      const rootRect = rootEl
        ? rootEl.getBoundingClientRect()
        : { top: 0, bottom: window.innerHeight };
      const rect = el.getBoundingClientRect();
      // Vertical-only test (columns are always in-view in a scroll grid),
      // mirroring the observer's `${margin}px 0px` rootMargin.
      const intersects =
        rect.bottom >= rootRect.top - margin && rect.top <= rootRect.bottom + margin;
      if (intersects) setInPlayArea(true);
    });

    return () => {
      cancelAnimationFrame(rafId);
      observer.disconnect();
    };
  }, [targetRef, rootEl, rootMarginPx, enabled]);

  return inPlayArea;
}
