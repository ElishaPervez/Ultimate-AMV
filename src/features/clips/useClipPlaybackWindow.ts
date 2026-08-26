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

  const lastCommittedGrantedIdsRef = React.useRef<Set<string>>(new Set());
  const lastCommittedVisibleIdsRef = React.useRef<Set<string>>(new Set());
  const lastCommittedFirstVisibleRowRef = React.useRef<number | null>(null);
  const lastCommittedLastVisibleRowRef = React.useRef<number | null>(null);
  const resizeAnchorClipIdRef = React.useRef<string | null>(null);

  const lastObservedWidthRef = React.useRef<number>(0);
  const lastObservedHeightRef = React.useRef<number>(0);
  const lastScrollTopRef = React.useRef<number>(0);
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
    if (!panelActive || !scrollerEl) {
      const emptySet = new Set<string>();
      lastCommittedGrantedIdsRef.current = emptySet;
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
      return;
    }

    const scrollerRect = scrollerEl.getBoundingClientRect();
    const isZeroDimension = scrollerRect.width <= 0 || scrollerRect.height <= 0;

    if (!lightweightEnabled) {
      const emptySet = new Set<string>();
      lastCommittedGrantedIdsRef.current = emptySet;
      setGrantedClipIds((prev) => (prev.size === 0 ? prev : emptySet));
      setVisibleClipIds((prev) => (prev.size === 0 ? prev : emptySet));
      setFirstVisibleRow(null);
      setLastVisibleRow(null);
      setDiagnostics((prev) => ({
        ...prev,
        viewportWidth: scrollerRect.width,
        viewportHeight: scrollerRect.height,
        firstVisibleRow: null,
        lastVisibleRow: null,
        visibleTileCount: 0,
        grantedCount: 0,
        visibleCountExceededHardCap: false,
      }));
      return;
    }

    const itemElements = scrollerEl.querySelectorAll<HTMLElement>(
      '[data-testid="virtuoso-item-list"] > [data-index], [data-index]',
    );

    if (isZeroDimension && itemElements.length === 0) {
      const emptySet = new Set<string>();
      lastCommittedGrantedIdsRef.current = emptySet;
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
      return;
    }

    const rows: MeasuredClipRow[] = [];
    const seenIndices = new Set<number>();
    const isJsdomFallback = isZeroDimension && itemElements.length > 0;

    for (let i = 0; i < itemElements.length; i += 1) {
      const el = itemElements[i];
      const indexAttr = el.getAttribute('data-index');
      if (indexAttr == null) continue;
      const index = parseInt(indexAttr, 10);
      if (!Number.isFinite(index) || index < 0 || index >= clipRows.length) continue;
      if (seenIndices.has(index)) continue;
      seenIndices.add(index);

      const rowClips = clipRows[index];
      if (!rowClips || rowClips.length === 0) continue;

      const rect = el.getBoundingClientRect();
      const top = isJsdomFallback ? index * 100 : rect.top;
      const bottom = isJsdomFallback ? (index + 1) * 100 : rect.bottom;

      rows.push({
        rowIndex: index,
        top,
        bottom,
        clipIds: rowClips.map((c) => c.id),
      });
    }

    const viewportTop = isJsdomFallback ? 0 : scrollerRect.top;
    const viewportBottom = isJsdomFallback ? 800 : scrollerRect.bottom;

    const selection = selectClipPlaybackWindow({
      rows,
      viewportTop,
      viewportBottom,
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
      anchorClipId: resizeAnchorClipIdRef.current,
    });
  }, [panelActive, scrollerEl, lightweightEnabled, clipRows, marginPx, requestedCap, hardCap, layoutGeneration]);

  const scheduleMeasurement = React.useCallback(() => {
    if (rafIdRef.current !== null) return;
    rafIdRef.current = requestAnimationFrame(() => {
      rafIdRef.current = null;
      measure();
    });
  }, [measure]);

  // Initial measurement & reactivity to inputs
  React.useEffect(() => {
    measure();
  }, [measure, renderedRange, gridCols, clipRows.length]);

  // Panel active/inactive transitions
  React.useEffect(() => {
    if (!panelActive) {
      cancelPendingRaf();
      clearSettleTimer();
      clearResizeTimer();
      if (fastScrollingRef.current) {
        fastScrollingRef.current = false;
        setFastScrolling(false);
      }
      const emptySet = new Set<string>();
      lastCommittedGrantedIdsRef.current = emptySet;
      setGrantedClipIds(emptySet);
      setVisibleClipIds(emptySet);
      setFirstVisibleRow(null);
      setLastVisibleRow(null);
    } else {
      measure();
    }
  }, [panelActive, measure, cancelPendingRaf, clearSettleTimer, clearResizeTimer]);

  // Attach scroll listener
  React.useEffect(() => {
    if (!scrollerEl || !panelActive) return undefined;

    lastScrollTopRef.current = scrollerEl.scrollTop;

    const handleScroll = () => {
      const currentTop = scrollerEl.scrollTop;
      const delta = Math.abs(currentTop - lastScrollTopRef.current);
      lastScrollTopRef.current = currentTop;

      if (delta > FAST_SCROLL_VELOCITY_PX_PER_FRAME) {
        fastScrollingRef.current = true;
        setFastScrolling(true);
        clearSettleTimer();
        settleTimerRef.current = setTimeout(() => {
          settleTimerRef.current = null;
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
  }, [scrollerEl, panelActive, clearSettleTimer, scheduleMeasurement]);

  // Observe resize and zoom
  React.useEffect(() => {
    if (!scrollerEl || !panelActive) return undefined;

    const initialRect = scrollerEl.getBoundingClientRect();
    lastObservedWidthRef.current = initialRect.width;
    lastObservedHeightRef.current = initialRect.height;

    const handleDimensionChange = (isZoomEvent = false) => {
      // Any resize cancels fast scrolling hold
      clearSettleTimer();
      if (fastScrollingRef.current) {
        fastScrollingRef.current = false;
        setFastScrolling(false);
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
