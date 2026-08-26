import React from 'react';
import {
  FAST_SCROLL_VELOCITY_PX_PER_FRAME,
  MAX_GRID_VIDEO_PLAYERS_CEILING,
} from '../../lib/constants';
import { UI_ZOOM_CHANGED_EVENT } from '../../lib/uiScale';
import {
  type MeasuredClipRow,
  selectClipPlaybackWindow,
} from './clipPlaybackWindow';

const FAST_SCROLL_SETTLE_MS = 140;
const RESIZE_SETTLE_MS = 120;

export type UseClipPlaybackWindowParams = {
  scrollerEl: HTMLElement | null;
  panelActive: boolean;
  lightweightEnabled: boolean;
  clipRows: Array<Array<{ id: string }>>;
  requestedCap: number;
  hardCap?: number;
  marginPx: number;
  gridCols: number;
  renderedRange?: { startIndex: number; endIndex: number } | null;
  onResetLayout?: (anchorClipId: string | null) => void;
};

export type ClipPlaybackDiagnostics = {
  viewportWidth: number;
  viewportHeight: number;
  firstVisibleRow: number | null;
  lastVisibleRow: number | null;
  visibleTileCount: number;
  grantedCount: number;
  hardCap: number;
  fastScrolling: boolean;
  layoutGeneration: number;
  visibleCountExceededHardCap: boolean;
  anchorClipId: string | null;
};

export type UseClipPlaybackWindowResult = {
  grantedClipIds: Set<string>;
  visibleClipIds: Set<string>;
  firstVisibleRow: number | null;
  lastVisibleRow: number | null;
  fastScrolling: boolean;
  layoutGeneration: number;
  diagnostics: ClipPlaybackDiagnostics;
};

function areSetsEqual(a: Set<string>, b: Set<string>): boolean {
  if (a === b) return true;
  if (a.size !== b.size) return false;
  for (const item of a) {
    if (!b.has(item)) return false;
  }
  return true;
}

export function useClipPlaybackWindow({
  scrollerEl,
  panelActive,
  lightweightEnabled,
  clipRows,
  requestedCap,
  hardCap = MAX_GRID_VIDEO_PLAYERS_CEILING,
  marginPx,
  gridCols,
  renderedRange,
  onResetLayout,
}: UseClipPlaybackWindowParams): UseClipPlaybackWindowResult {
  const [grantedClipIds, setGrantedClipIds] = React.useState<Set<string>>(() => new Set());
  const [visibleClipIds, setVisibleClipIds] = React.useState<Set<string>>(() => new Set());
  const [firstVisibleRow, setFirstVisibleRow] = React.useState<number | null>(null);
  const [lastVisibleRow, setLastVisibleRow] = React.useState<number | null>(null);
  const [fastScrolling, setFastScrolling] = React.useState<boolean>(false);
  const [layoutGeneration, setLayoutGeneration] = React.useState<number>(0);
  const [diagnostics, setDiagnostics] = React.useState<ClipPlaybackDiagnostics>(() => ({
    viewportWidth: 0,
    viewportHeight: 0,
    firstVisibleRow: null,
    lastVisibleRow: null,
    visibleTileCount: 0,
    grantedCount: 0,
    hardCap,
    fastScrolling: false,
    layoutGeneration: 0,
    visibleCountExceededHardCap: false,
    anchorClipId: null,
  }));

  const isMountedRef = React.useRef<boolean>(true);
  React.useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  const lastCommittedGrantedIdsRef = React.useRef<Set<string>>(new Set());
  const lastCommittedVisibleIdsRef = React.useRef<Set<string>>(new Set());
  const lastCommittedFirstVisibleRowRef = React.useRef<number | null>(null);
  const lastCommittedLastVisibleRowRef = React.useRef<number | null>(null);

  const resizeAnchorClipIdRef = React.useRef<string | null>(null);
  const savedHiddenAnchorClipIdRef = React.useRef<string | null>(null);

  const lastObservedWidthRef = React.useRef<number>(0);
  const lastObservedHeightRef = React.useRef<number>(0);
  const lastObservedZoomRef = React.useRef<number>(0);

  const lastFrameSampledScrollTopRef = React.useRef<number>(0);
  const fastScrollingRef = React.useRef<boolean>(false);

  const rafIdRef = React.useRef<number | null>(null);
  const settleTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const resizeTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);

  const onResetLayoutRef = React.useRef(onResetLayout);
  onResetLayoutRef.current = onResetLayout;

  const cancelPendingRaf = React.useCallback(() => {
    if (rafIdRef.current !== null) {
      cancelAnimationFrame(rafIdRef.current);
      rafIdRef.current = null;
    }
  }, []);

  const clearSettleTimer = React.useCallback(() => {
    if (settleTimerRef.current !== null) {
      clearTimeout(settleTimerRef.current);
      settleTimerRef.current = null;
    }
  }, []);

  const clearResizeTimer = React.useCallback(() => {
    if (resizeTimerRef.current !== null) {
      clearTimeout(resizeTimerRef.current);
      resizeTimerRef.current = null;
    }
  }, []);

  // Measure DOM row positions and derive visibility & player grants
  const measure = React.useCallback(() => {
    if (!isMountedRef.current || !panelActive || !scrollerEl) {
      const emptySet = new Set<string>();
      lastCommittedGrantedIdsRef.current = emptySet;
      if (isMountedRef.current) {
        setGrantedClipIds((prev) => (prev.size === 0 ? prev : emptySet));
        setVisibleClipIds((prev) => (prev.size === 0 ? prev : emptySet));
        setFirstVisibleRow(null);
        setLastVisibleRow(null);
        setDiagnostics((prev) => ({
          ...prev,
          viewportWidth: 0,
          viewportHeight: 0,
          firstVisibleRow: null,
          lastVisibleRow: null,
          visibleTileCount: 0,
          grantedCount: 0,
          visibleCountExceededHardCap: false,
        }));
      }
      return;
    }

    if (!lightweightEnabled) {
      const emptySet = new Set<string>();
      lastCommittedGrantedIdsRef.current = emptySet;
      if (isMountedRef.current) {
        setGrantedClipIds((prev) => (prev.size === 0 ? prev : emptySet));
        setVisibleClipIds((prev) => (prev.size === 0 ? prev : emptySet));
        setFirstVisibleRow(null);
        setLastVisibleRow(null);
      }
      return;
    }

    const scrollerRect = scrollerEl.getBoundingClientRect();
    if (scrollerRect.width <= 0 || scrollerRect.height <= 0) {
      // Grid is zero-sized. Release players, retain anchor, do NOT grant top clips
      const emptySet = new Set<string>();
      lastCommittedGrantedIdsRef.current = emptySet;
      if (isMountedRef.current) {
        setGrantedClipIds((prev) => (prev.size === 0 ? prev : emptySet));
        setVisibleClipIds((prev) => (prev.size === 0 ? prev : emptySet));
        setFirstVisibleRow(null);
        setLastVisibleRow(null);
        setDiagnostics((prev) => ({
          ...prev,
          viewportWidth: 0,
          viewportHeight: 0,
          firstVisibleRow: null,
          lastVisibleRow: null,
          visibleTileCount: 0,
          grantedCount: 0,
          visibleCountExceededHardCap: false,
        }));
      }
      return;
    }

    // Check if layout dimensions or zoom changed while hidden before updating lastObserved values
    const currentZoom = typeof window !== 'undefined' ? window.devicePixelRatio : 1;
    const widthChangedWhileHidden =
      lastObservedWidthRef.current > 0 &&
      Math.abs(scrollerRect.width - lastObservedWidthRef.current) >= 1;
    const zoomChangedWhileHidden =
      lastObservedZoomRef.current > 0 &&
      Math.abs(currentZoom - lastObservedZoomRef.current) >= 0.01;

    if (widthChangedWhileHidden || zoomChangedWhileHidden) {
      const anchorToPreserve = savedHiddenAnchorClipIdRef.current;
      savedHiddenAnchorClipIdRef.current = null;
      setLayoutGeneration((g) => g + 1);
      if (onResetLayoutRef.current) {
        onResetLayoutRef.current(anchorToPreserve);
      }
    } else {
      savedHiddenAnchorClipIdRef.current = null;
    }

    lastObservedWidthRef.current = scrollerRect.width;
    lastObservedHeightRef.current = scrollerRect.height;
    lastObservedZoomRef.current = currentZoom;

    // Check frame scroll movement
    const currentScrollTop = scrollerEl.scrollTop;
    const frameScrollDelta = Math.abs(currentScrollTop - lastFrameSampledScrollTopRef.current);
    lastFrameSampledScrollTopRef.current = currentScrollTop;

    if (frameScrollDelta > FAST_SCROLL_VELOCITY_PX_PER_FRAME) {
      if (!fastScrollingRef.current) {
        fastScrollingRef.current = true;
        if (isMountedRef.current) setFastScrolling(true);
      }
      clearSettleTimer();
      settleTimerRef.current = setTimeout(() => {
        settleTimerRef.current = null;
        if (!isMountedRef.current) return;
        fastScrollingRef.current = false;
        setFastScrolling(false);
        scheduleMeasurement();
      }, FAST_SCROLL_SETTLE_MS);
    }

    // Direct row wrappers under [data-testid="virtuoso-item-list"] > [data-index]
    const itemElements = scrollerEl.querySelectorAll<HTMLElement>(
      '[data-testid="virtuoso-item-list"] > [data-index]',
    );

    const rows: MeasuredClipRow[] = [];
    const seenIndices = new Set<number>();

    for (let i = 0; i < itemElements.length; i += 1) {
      const el = itemElements[i];
      const indexAttr = el.getAttribute('data-index');
      if (indexAttr == null || !/^\d+$/.test(indexAttr)) continue;
      const index = Number(indexAttr);
      if (!Number.isSafeInteger(index) || index < 0 || index >= clipRows.length) continue;
      if (seenIndices.has(index)) continue;
      seenIndices.add(index);

      const rowClips = clipRows[index];
      if (!rowClips || rowClips.length === 0) continue;

      const rect = el.getBoundingClientRect();
      rows.push({
        rowIndex: index,
        top: rect.top,
        bottom: rect.bottom,
        clipIds: rowClips.map((c) => c.id),
      });
    }

    const selection = selectClipPlaybackWindow({
      rows,
      viewportTop: scrollerRect.top,
      viewportBottom: scrollerRect.bottom,
      marginPx,
      requestedCap,
      hardCap,
    });

    let grantedToCommit: Set<string>;
    if (fastScrollingRef.current) {
      grantedToCommit = lastCommittedGrantedIdsRef.current;
    } else {
      grantedToCommit = selection.grantedIds;
      lastCommittedGrantedIdsRef.current = selection.grantedIds;
      lastCommittedVisibleIdsRef.current = selection.visibleIds;
      lastCommittedFirstVisibleRowRef.current = selection.firstVisibleRow;
      lastCommittedLastVisibleRowRef.current = selection.lastVisibleRow;
    }

    if (isMountedRef.current) {
      setGrantedClipIds((prev) => (areSetsEqual(prev, grantedToCommit) ? prev : grantedToCommit));
      setVisibleClipIds((prev) => (areSetsEqual(prev, selection.visibleIds) ? prev : selection.visibleIds));
      setFirstVisibleRow(selection.firstVisibleRow);
      setLastVisibleRow(selection.lastVisibleRow);

      setDiagnostics({
        viewportWidth: scrollerRect.width,
        viewportHeight: scrollerRect.height,
        firstVisibleRow: selection.firstVisibleRow,
        lastVisibleRow: selection.lastVisibleRow,
        visibleTileCount: selection.visibleIds.size,
        grantedCount: grantedToCommit.size,
        hardCap,
        fastScrolling: fastScrollingRef.current,
        layoutGeneration,
        visibleCountExceededHardCap: selection.visibleCountExceededHardCap,
        anchorClipId: resizeAnchorClipIdRef.current ?? savedHiddenAnchorClipIdRef.current,
      });
    }
  }, [panelActive, scrollerEl, lightweightEnabled, clipRows, marginPx, requestedCap, hardCap, layoutGeneration, clearSettleTimer]);

  const measureRef = React.useRef(measure);
  measureRef.current = measure;

  const scheduleMeasurement = React.useCallback(() => {
    if (rafIdRef.current !== null) return;
    rafIdRef.current = requestAnimationFrame(() => {
      rafIdRef.current = null;
      measureRef.current();
    });
  }, []);

  // Initial measurement & reactivity to inputs (always through scheduleMeasurement!)
  React.useEffect(() => {
    scheduleMeasurement();
  }, [scheduleMeasurement, renderedRange, gridCols, clipRows, scrollerEl]);

  // Panel active/inactive transitions
  React.useEffect(() => {
    if (!panelActive) {
      // Save anchor clip ID before deactivating
      const rowIdx = lastCommittedFirstVisibleRowRef.current;
      if (rowIdx != null && clipRows[rowIdx]?.[0]) {
        savedHiddenAnchorClipIdRef.current = clipRows[rowIdx][0].id;
      }
      cancelPendingRaf();
      clearSettleTimer();
      clearResizeTimer();
      if (fastScrollingRef.current) {
        fastScrollingRef.current = false;
        if (isMountedRef.current) setFastScrolling(false);
      }
      const emptySet = new Set<string>();
      lastCommittedGrantedIdsRef.current = emptySet;
      if (isMountedRef.current) {
        setGrantedClipIds(emptySet);
        setVisibleClipIds(emptySet);
        setFirstVisibleRow(null);
        setLastVisibleRow(null);
      }
    } else {
      scheduleMeasurement();
    }
  }, [panelActive, clipRows, scheduleMeasurement, cancelPendingRaf, clearSettleTimer, clearResizeTimer]);

  // Attach scroll listener (ONLY when lightweightEnabled is true)
  React.useEffect(() => {
    if (!scrollerEl || !panelActive || !lightweightEnabled) return undefined;

    lastFrameSampledScrollTopRef.current = scrollerEl.scrollTop;

    const handleScroll = () => {
      if (fastScrollingRef.current) {
        clearSettleTimer();
        settleTimerRef.current = setTimeout(() => {
          settleTimerRef.current = null;
          if (!isMountedRef.current) return;
          fastScrollingRef.current = false;
          setFastScrolling(false);
          scheduleMeasurement();
        }, FAST_SCROLL_SETTLE_MS);
      }

      const currentScrollTop = scrollerEl.scrollTop;
      const deltaSinceLastFrame = Math.abs(currentScrollTop - lastFrameSampledScrollTopRef.current);
      if (deltaSinceLastFrame > FAST_SCROLL_VELOCITY_PX_PER_FRAME) {
        if (!fastScrollingRef.current) {
          fastScrollingRef.current = true;
          if (isMountedRef.current) setFastScrolling(true);
        }
        clearSettleTimer();
        settleTimerRef.current = setTimeout(() => {
          settleTimerRef.current = null;
          if (!isMountedRef.current) return;
          fastScrollingRef.current = false;
          setFastScrolling(false);
          scheduleMeasurement();
        }, FAST_SCROLL_SETTLE_MS);
      }

      scheduleMeasurement();
    };

    scrollerEl.addEventListener('scroll', handleScroll, { passive: true });
    return () => {
      scrollerEl.removeEventListener('scroll', handleScroll);
    };
  }, [scrollerEl, panelActive, lightweightEnabled, clearSettleTimer, scheduleMeasurement]);

  // Observe resize and zoom
  React.useEffect(() => {
    if (!scrollerEl || !panelActive) return undefined;

    const initialRect = scrollerEl.getBoundingClientRect();
    if (lastObservedWidthRef.current === 0 && initialRect.width > 0) {
      lastObservedWidthRef.current = initialRect.width;
      lastObservedHeightRef.current = initialRect.height;
    }
    if (lastObservedZoomRef.current === 0 && typeof window !== 'undefined') {
      lastObservedZoomRef.current = window.devicePixelRatio;
    }

    const handleDimensionChange = (isZoomEvent = false) => {
      clearSettleTimer();
      if (fastScrollingRef.current) {
        fastScrollingRef.current = false;
        if (isMountedRef.current) setFastScrolling(false);
      }

      const rect = scrollerEl.getBoundingClientRect();
      const currentWidth = rect.width;
      const currentHeight = rect.height;

      if (currentWidth <= 0 || currentHeight <= 0) {
        scheduleMeasurement();
        return;
      }

      const widthChanged =
        isZoomEvent ||
        (lastObservedWidthRef.current > 0 && Math.abs(currentWidth - lastObservedWidthRef.current) >= 1);
      const heightChanged =
        lastObservedHeightRef.current > 0 && Math.abs(currentHeight - lastObservedHeightRef.current) >= 1;

      if (widthChanged) {
        if (resizeAnchorClipIdRef.current == null) {
          const rowIdx = lastCommittedFirstVisibleRowRef.current;
          const anchorClip =
            rowIdx != null && clipRows[rowIdx]?.[0] ? clipRows[rowIdx][0].id : null;
          resizeAnchorClipIdRef.current = anchorClip;
        }

        clearResizeTimer();
        resizeTimerRef.current = setTimeout(() => {
          resizeTimerRef.current = null;
          if (!isMountedRef.current) return;
          const anchorToPreserve = resizeAnchorClipIdRef.current;
          setLayoutGeneration((g) => g + 1);
          if (onResetLayoutRef.current) {
            onResetLayoutRef.current(anchorToPreserve);
          }
          scheduleMeasurement();
          resizeAnchorClipIdRef.current = null;
        }, RESIZE_SETTLE_MS);

        lastObservedWidthRef.current = currentWidth;
      } else if (heightChanged) {
        lastObservedHeightRef.current = currentHeight;
      }

      scheduleMeasurement();
    };

    let resizeObserver: ResizeObserver | null = null;
    if (typeof ResizeObserver !== 'undefined') {
      resizeObserver = new ResizeObserver(() => {
        handleDimensionChange(false);
      });
      resizeObserver.observe(scrollerEl);
    }

    const handleZoomEvent = () => {
      handleDimensionChange(true);
    };

    window.addEventListener(UI_ZOOM_CHANGED_EVENT, handleZoomEvent);

    return () => {
      if (resizeObserver) resizeObserver.disconnect();
      window.removeEventListener(UI_ZOOM_CHANGED_EVENT, handleZoomEvent);
      clearResizeTimer();
      cancelPendingRaf();
    };
  }, [scrollerEl, panelActive, clipRows, clearResizeTimer, clearSettleTimer, scheduleMeasurement, cancelPendingRaf]);

  // Comprehensive unmount cleanup
  React.useEffect(() => {
    return () => {
      cancelPendingRaf();
      clearSettleTimer();
      clearResizeTimer();
    };
  }, [cancelPendingRaf, clearSettleTimer, clearResizeTimer]);

  return {
    grantedClipIds,
    visibleClipIds,
    firstVisibleRow,
    lastVisibleRow,
    fastScrolling,
    layoutGeneration,
    diagnostics,
  };
}
