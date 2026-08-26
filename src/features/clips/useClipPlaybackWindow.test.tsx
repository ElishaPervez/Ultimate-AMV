import React from 'react';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import {
  useClipPlaybackWindow,
  type UseClipPlaybackWindowParams,
} from './useClipPlaybackWindow';
import { UI_ZOOM_CHANGED_EVENT } from '../../lib/uiScale';
import * as uiScale from '../../lib/uiScale';

// Controllable ResizeObserver mock
type ResizeCallback = (entries: ResizeObserverEntry[], observer: ResizeObserver) => void;
let resizeCallbacks: ResizeCallback[] = [];

class MockResizeObserver implements ResizeObserver {
  private cb: ResizeCallback;
  constructor(cb: ResizeCallback) {
    this.cb = cb;
    resizeCallbacks.push(cb);
  }
  observe() {}
  unobserve() {}
  disconnect() {
    resizeCallbacks = resizeCallbacks.filter((c) => c !== this.cb);
  }
}

function triggerResize(target: HTMLElement) {
  const entry = {
    target,
    contentRect: target.getBoundingClientRect(),
  } as unknown as ResizeObserverEntry;
  for (const cb of resizeCallbacks) {
    cb([entry], {} as ResizeObserver);
  }
}

function createMockDom(options: {
  scrollerRect: { top: number; bottom: number; width: number; height: number };
  rowRects: Array<{ index: number; top: number; bottom: number; height: number }>;
}) {
  const scroller = document.createElement('div');
  scroller.scrollTop = 0;
  Object.defineProperty(scroller, 'clientWidth', {
    configurable: true,
    get: () => options.scrollerRect.width,
  });
  Object.defineProperty(scroller, 'clientHeight', {
    configurable: true,
    get: () => options.scrollerRect.height,
  });
  scroller.getBoundingClientRect = vi.fn(() => ({
    top: options.scrollerRect.top,
    bottom: options.scrollerRect.bottom,
    left: 0,
    right: options.scrollerRect.width,
    width: options.scrollerRect.width,
    height: options.scrollerRect.height,
    x: 0,
    y: options.scrollerRect.top,
    toJSON: () => {},
  }));

  const list = document.createElement('div');
  list.setAttribute('data-testid', 'virtuoso-item-list');
  scroller.appendChild(list);

  const rowEls: HTMLElement[] = [];
  for (const r of options.rowRects) {
    const rowEl = document.createElement('div');
    rowEl.setAttribute('data-index', String(r.index));
    rowEl.getBoundingClientRect = vi.fn(() => ({
      top: r.top,
      bottom: r.bottom,
      left: 0,
      right: options.scrollerRect.width,
      width: options.scrollerRect.width,
      height: r.height,
      x: 0,
      y: r.top,
      toJSON: () => {},
    }));
    list.appendChild(rowEl);
    rowEls.push(rowEl);
  }

  return { scroller, list, rowEls };
}

describe('useClipPlaybackWindow', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resizeCallbacks = [];
    (window as unknown as { ResizeObserver: typeof ResizeObserver }).ResizeObserver = MockResizeObserver;
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it('1. updates granted set on scroll with mocked unequal row rectangles', () => {
    const clipRows = [
      [{ id: 'c0_1' }, { id: 'c0_2' }],
      [{ id: 'c1_1' }, { id: 'c1_2' }],
      [{ id: 'c2_1' }, { id: 'c2_2' }],
    ];

    const dom = createMockDom({
      scrollerRect: { top: 0, bottom: 200, width: 800, height: 200 },
      rowRects: [
        { index: 0, top: 0, bottom: 90, height: 90 }, // unequal height 90
        { index: 1, top: 90, bottom: 220, height: 130 }, // unequal height 130
        { index: 2, top: 220, bottom: 350, height: 130 },
      ],
    });

    const { result } = renderHook(() =>
      useClipPlaybackWindow({
        scrollerEl: dom.scroller,
        panelActive: true,
        lightweightEnabled: true,
        clipRows,
        requestedCap: 4,
        hardCap: 35,
        marginPx: 0,
        gridCols: 2,
      }),
    );

    // Initial frame
    act(() => {
      vi.advanceTimersByTime(16);
    });

    expect(result.current.visibleClipIds).toEqual(new Set(['c0_1', 'c0_2', 'c1_1', 'c1_2']));
    expect(result.current.grantedClipIds).toEqual(new Set(['c0_1', 'c0_2', 'c1_1', 'c1_2']));
    expect(result.current.firstVisibleRow).toBe(0);
    expect(result.current.lastVisibleRow).toBe(1);

    // Scroll down: row 0 moves above viewport, row 2 moves into viewport
    dom.rowEls[0].getBoundingClientRect = () => ({
      top: -100,
      bottom: -10,
      left: 0,
      right: 800,
      width: 800,
      height: 90,
      x: 0,
      y: -100,
      toJSON: () => {},
    });
    dom.rowEls[1].getBoundingClientRect = () => ({
      top: -10,
      bottom: 120,
      left: 0,
      right: 800,
      width: 800,
      height: 130,
      x: 0,
      y: -10,
      toJSON: () => {},
    });
    dom.rowEls[2].getBoundingClientRect = () => ({
      top: 120,
      bottom: 250,
      left: 0,
      right: 800,
      width: 800,
      height: 130,
      x: 0,
      y: 120,
      toJSON: () => {},
    });

    act(() => {
      dom.scroller.dispatchEvent(new Event('scroll'));
      vi.advanceTimersByTime(16);
    });

    expect(result.current.visibleClipIds).toEqual(new Set(['c1_1', 'c1_2', 'c2_1', 'c2_2']));
    expect(result.current.grantedClipIds).toEqual(new Set(['c1_1', 'c1_2', 'c2_1', 'c2_2']));
    expect(result.current.firstVisibleRow).toBe(1);
    expect(result.current.lastVisibleRow).toBe(2);
  });

  it('2. updates granted set on viewport height change without a scroll event', () => {
    const clipRows = [
      [{ id: 'c0' }],
      [{ id: 'c1' }],
      [{ id: 'c2' }],
    ];

    const dom = createMockDom({
      scrollerRect: { top: 0, bottom: 100, width: 800, height: 100 },
      rowRects: [
        { index: 0, top: 0, bottom: 80, height: 80 },
        { index: 1, top: 80, bottom: 160, height: 80 },
        { index: 2, top: 160, bottom: 240, height: 80 },
      ],
    });

    const { result } = renderHook(() =>
      useClipPlaybackWindow({
        scrollerEl: dom.scroller,
        panelActive: true,
        lightweightEnabled: true,
        clipRows,
        requestedCap: 4,
        hardCap: 35,
        marginPx: 0,
        gridCols: 1,
      }),
    );

    act(() => {
      vi.advanceTimersByTime(16);
    });

    expect(result.current.visibleClipIds).toEqual(new Set(['c0', 'c1']));

    // Increase height to 250 without a scroll event
    dom.scroller.getBoundingClientRect = vi.fn(() => ({
      top: 0,
      bottom: 250,
      left: 0,
      right: 800,
      width: 800,
      height: 250,
      x: 0,
      y: 0,
      toJSON: () => {},
    }));

    act(() => {
      triggerResize(dom.scroller);
      vi.advanceTimersByTime(16);
    });

    expect(result.current.visibleClipIds).toEqual(new Set(['c0', 'c1', 'c2']));
    expect(result.current.grantedClipIds).toEqual(new Set(['c0', 'c1', 'c2']));
  });

  it('3. schedules one reset after 120ms on width change and preserves first visible clip', () => {
    const clipRows = [
      [{ id: 'c0_1' }, { id: 'c0_2' }],
      [{ id: 'c1_1' }, { id: 'c1_2' }],
      [{ id: 'c2_1' }, { id: 'c2_2' }],
    ];

    const dom = createMockDom({
      scrollerRect: { top: 0, bottom: 200, width: 800, height: 200 },
      rowRects: [
        { index: 0, top: -100, bottom: -10, height: 90 },
        { index: 1, top: 0, bottom: 100, height: 100 }, // row 1 is first visible -> clip 'c1_1'
        { index: 2, top: 100, bottom: 200, height: 100 },
      ],
    });

    const onResetLayout = vi.fn();

    const { result } = renderHook(() =>
      useClipPlaybackWindow({
        scrollerEl: dom.scroller,
        panelActive: true,
        lightweightEnabled: true,
        clipRows,
        requestedCap: 4,
        hardCap: 35,
        marginPx: 0,
        gridCols: 2,
        onResetLayout,
      }),
    );

    act(() => {
      vi.advanceTimersByTime(16);
    });

    expect(result.current.firstVisibleRow).toBe(1);

    // Change width to 600
    dom.scroller.getBoundingClientRect = vi.fn(() => ({
      top: 0,
      bottom: 200,
      left: 0,
      right: 600,
      width: 600,
      height: 200,
      x: 0,
      y: 0,
      toJSON: () => {},
    }));

    act(() => {
      triggerResize(dom.scroller);
    });

    expect(onResetLayout).not.toHaveBeenCalled();

    // 100ms passed (not settled yet)
    act(() => {
      vi.advanceTimersByTime(100);
    });
    expect(onResetLayout).not.toHaveBeenCalled();

    // Advance 30ms more (total 130ms > 120ms)
    act(() => {
      vi.advanceTimersByTime(30);
    });

    expect(onResetLayout).toHaveBeenCalledTimes(1);
    expect(onResetLayout).toHaveBeenCalledWith('c1_1');
    expect(result.current.layoutGeneration).toBe(1);
  });

  it('4. coalesces several width changes inside 120ms settle period into one reset', () => {
    const clipRows = [[{ id: 'c0' }], [{ id: 'c1' }]];
    const dom = createMockDom({
      scrollerRect: { top: 0, bottom: 200, width: 800, height: 200 },
      rowRects: [{ index: 0, top: 0, bottom: 100, height: 100 }],
    });
    const onResetLayout = vi.fn();

    const { result } = renderHook(() =>
      useClipPlaybackWindow({
        scrollerEl: dom.scroller,
        panelActive: true,
        lightweightEnabled: true,
        clipRows,
        requestedCap: 4,
        hardCap: 35,
        marginPx: 0,
        gridCols: 1,
        onResetLayout,
      }),
    );

    act(() => {
      vi.advanceTimersByTime(16);
    });

    // Resize burst: width 700, then 650, then 600
    act(() => {
      dom.scroller.getBoundingClientRect = vi.fn(() => ({
        top: 0, bottom: 200, left: 0, right: 700, width: 700, height: 200, x: 0, y: 0, toJSON: () => {},
      }));
      triggerResize(dom.scroller);
      vi.advanceTimersByTime(40);

      dom.scroller.getBoundingClientRect = vi.fn(() => ({
        top: 0, bottom: 200, left: 0, right: 650, width: 650, height: 200, x: 0, y: 0, toJSON: () => {},
      }));
      triggerResize(dom.scroller);
      vi.advanceTimersByTime(40);

      dom.scroller.getBoundingClientRect = vi.fn(() => ({
        top: 0, bottom: 200, left: 0, right: 600, width: 600, height: 200, x: 0, y: 0, toJSON: () => {},
      }));
      triggerResize(dom.scroller);
      vi.advanceTimersByTime(40);
    });

    expect(onResetLayout).not.toHaveBeenCalled();

    // Now let 120ms pass after the last burst
    act(() => {
      vi.advanceTimersByTime(120);
    });

    expect(onResetLayout).toHaveBeenCalledTimes(1);
    expect(result.current.layoutGeneration).toBe(1);
  });

  it('5. handles UI_ZOOM_CHANGED_EVENT by scheduling a reset and fresh measurement', () => {
    const clipRows = [[{ id: 'c0' }], [{ id: 'c1' }]];
    const dom = createMockDom({
      scrollerRect: { top: 0, bottom: 200, width: 800, height: 200 },
      rowRects: [{ index: 0, top: 0, bottom: 100, height: 100 }],
    });
    const onResetLayout = vi.fn();

    renderHook(() =>
      useClipPlaybackWindow({
        scrollerEl: dom.scroller,
        panelActive: true,
        lightweightEnabled: true,
        clipRows,
        requestedCap: 4,
        hardCap: 35,
        marginPx: 0,
        gridCols: 1,
        onResetLayout,
      }),
    );

    act(() => {
      vi.advanceTimersByTime(16);
    });

    act(() => {
      window.dispatchEvent(new CustomEvent(UI_ZOOM_CHANGED_EVENT, { detail: 1.25 }));
    });

    expect(onResetLayout).not.toHaveBeenCalled();

    act(() => {
      vi.advanceTimersByTime(125);
    });

    expect(onResetLayout).toHaveBeenCalledTimes(1);
  });

  it('6. holds prior set during fast fling and grants visible tiles after settling', () => {
    const clipRows = [
      [{ id: 'c0' }],
      [{ id: 'c1' }],
      [{ id: 'c2' }],
      [{ id: 'c3' }],
    ];

    const dom = createMockDom({
      scrollerRect: { top: 0, bottom: 100, width: 800, height: 100 },
      rowRects: [
        { index: 0, top: 0, bottom: 100, height: 100 },
        { index: 1, top: 100, bottom: 200, height: 100 },
        { index: 2, top: 200, bottom: 300, height: 100 },
        { index: 3, top: 300, bottom: 400, height: 100 },
      ],
    });

    const { result } = renderHook(() =>
      useClipPlaybackWindow({
        scrollerEl: dom.scroller,
        panelActive: true,
        lightweightEnabled: true,
        clipRows,
        requestedCap: 1,
        hardCap: 35,
        marginPx: 0,
        gridCols: 1,
      }),
    );

    act(() => {
      vi.advanceTimersByTime(16);
    });

    expect(result.current.grantedClipIds).toEqual(new Set(['c0']));

    // Fast scroll down (delta > 50px)
    dom.scroller.scrollTop = 300;
    // Row 3 is now physically in view
    dom.rowEls[0].getBoundingClientRect = () => ({
      top: -300, bottom: -200, left: 0, right: 800, width: 800, height: 100, x: 0, y: -300, toJSON: () => {},
    });
    dom.rowEls[3].getBoundingClientRect = () => ({
      top: 0, bottom: 100, left: 0, right: 800, width: 800, height: 100, x: 0, y: 0, toJSON: () => {},
    });

    act(() => {
      dom.scroller.dispatchEvent(new Event('scroll'));
      vi.advanceTimersByTime(16);
    });

    // Fling hold is active: fastScrolling is true, granted set is held at 'c0'
    expect(result.current.fastScrolling).toBe(true);
    expect(result.current.grantedClipIds).toEqual(new Set(['c0']));

    // Settle after 140ms
    act(() => {
      vi.advanceTimersByTime(150);
    });

    expect(result.current.fastScrolling).toBe(false);
    expect(result.current.grantedClipIds).toEqual(new Set(['c3']));
    expect(result.current.visibleClipIds).toEqual(new Set(['c3']));
  });

  it('7. cancels fling hold on resize and publishes resized visible set immediately', () => {
    const clipRows = [[{ id: 'c0' }], [{ id: 'c1' }]];
    const dom = createMockDom({
      scrollerRect: { top: 0, bottom: 100, width: 800, height: 100 },
      rowRects: [
        { index: 0, top: 0, bottom: 100, height: 100 },
        { index: 1, top: 100, bottom: 200, height: 100 },
      ],
    });

    const { result } = renderHook(() =>
      useClipPlaybackWindow({
        scrollerEl: dom.scroller,
        panelActive: true,
        lightweightEnabled: true,
        clipRows,
        requestedCap: 2,
        hardCap: 35,
        marginPx: 0,
        gridCols: 1,
      }),
    );

    act(() => {
      vi.advanceTimersByTime(16);
    });

    // Start fast fling
    dom.scroller.scrollTop = 100;
    act(() => {
      dom.scroller.dispatchEvent(new Event('scroll'));
      vi.advanceTimersByTime(16);
    });
    expect(result.current.fastScrolling).toBe(true);

    // Height resize occurs during fling
    dom.scroller.getBoundingClientRect = vi.fn(() => ({
      top: 0, bottom: 200, left: 0, right: 800, width: 800, height: 200, x: 0, y: 0, toJSON: () => {},
    }));

    act(() => {
      triggerResize(dom.scroller);
      vi.advanceTimersByTime(16);
    });

    // Fling hold cancelled by resize
    expect(result.current.fastScrolling).toBe(false);
    expect(result.current.grantedClipIds).toEqual(new Set(['c0', 'c1']));
  });

  it('8. releases grants when panel is hidden without replacing saved anchor with empty value', () => {
    const clipRows = [[{ id: 'c0' }], [{ id: 'c1' }]];
    const dom = createMockDom({
      scrollerRect: { top: 0, bottom: 100, width: 800, height: 100 },
      rowRects: [{ index: 0, top: 0, bottom: 100, height: 100 }],
    });
    const onResetLayout = vi.fn();

    let panelActive = true;
    const { result, rerender } = renderHook(
      (props: Partial<UseClipPlaybackWindowParams>) =>
        useClipPlaybackWindow({
          scrollerEl: dom.scroller,
          panelActive: props.panelActive ?? panelActive,
          lightweightEnabled: true,
          clipRows,
          requestedCap: 2,
          hardCap: 35,
          marginPx: 0,
          gridCols: 1,
          onResetLayout,
        }),
      { initialProps: { panelActive: true } },
    );

    act(() => {
      vi.advanceTimersByTime(16);
    });

    expect(result.current.grantedClipIds).toEqual(new Set(['c0']));

    // Hide panel
    rerender({ panelActive: false });
    act(() => {
      vi.advanceTimersByTime(16);
    });

    expect(result.current.grantedClipIds.size).toBe(0);
    expect(result.current.visibleClipIds.size).toBe(0);
  });

  it('9. measures on next frame and grants visible tiles when panel reactivates', () => {
    const clipRows = [[{ id: 'c0' }], [{ id: 'c1' }]];
    const dom = createMockDom({
      scrollerRect: { top: 0, bottom: 100, width: 800, height: 100 },
      rowRects: [{ index: 0, top: 0, bottom: 100, height: 100 }],
    });

    const { result, rerender } = renderHook(
      (props: { panelActive: boolean }) =>
        useClipPlaybackWindow({
          scrollerEl: dom.scroller,
          panelActive: props.panelActive,
          lightweightEnabled: true,
          clipRows,
          requestedCap: 2,
          hardCap: 35,
          marginPx: 0,
          gridCols: 1,
        }),
      { initialProps: { panelActive: false } },
    );

    expect(result.current.grantedClipIds.size).toBe(0);

    // Reactivate panel
    rerender({ panelActive: true });
    act(() => {
      vi.advanceTimersByTime(16);
    });

    expect(result.current.grantedClipIds).toEqual(new Set(['c0']));
  });

  it('10. returns empty granted IDs when lightweight previews are disabled', () => {
    const clipRows = [[{ id: 'c0' }], [{ id: 'c1' }]];
    const dom = createMockDom({
      scrollerRect: { top: 0, bottom: 100, width: 800, height: 100 },
      rowRects: [{ index: 0, top: 0, bottom: 100, height: 100 }],
    });

    const { result } = renderHook(() =>
      useClipPlaybackWindow({
        scrollerEl: dom.scroller,
        panelActive: true,
        lightweightEnabled: false,
        clipRows,
        requestedCap: 2,
        hardCap: 35,
        marginPx: 0,
        gridCols: 1,
      }),
    );

    act(() => {
      vi.advanceTimersByTime(16);
    });

    expect(result.current.grantedClipIds.size).toBe(0);
  });

  it('12. detects width/zoom change while panel was hidden on reactivation and triggers layout reset', () => {
    const clipRows = [
      [{ id: 'c0' }],
      [{ id: 'c1' }],
      [{ id: 'c2' }],
      [{ id: 'c3' }],
    ];
    const dom = createMockDom({
      scrollerRect: { top: 0, bottom: 200, width: 800, height: 200 },
      rowRects: [
        { index: 0, top: -200, bottom: -100, height: 100 },
        { index: 1, top: -100, bottom: 0, height: 100 },
        { index: 2, top: 0, bottom: 100, height: 100 },
        { index: 3, top: 100, bottom: 200, height: 100 },
      ],
    });
    const onResetLayout = vi.fn();

    const { result, rerender } = renderHook(
      (props: { panelActive: boolean }) =>
        useClipPlaybackWindow({
          scrollerEl: dom.scroller,
          panelActive: props.panelActive,
          lightweightEnabled: true,
          clipRows,
          requestedCap: 4,
          hardCap: 35,
          marginPx: 0,
          gridCols: 1,
          onResetLayout,
        }),
      { initialProps: { panelActive: true } },
    );

    act(() => {
      vi.advanceTimersByTime(16);
    });

    expect(result.current.grantedClipIds).toEqual(new Set(['c2', 'c3']));

    // Hide panel
    rerender({ panelActive: false });
    act(() => {
      vi.advanceTimersByTime(16);
    });
    expect(result.current.grantedClipIds.size).toBe(0);

    // Resize scroller while hidden: width changes from 800 to 500
    dom.scroller.getBoundingClientRect = vi.fn(() => ({
      top: 0, bottom: 200, left: 0, right: 500, width: 500, height: 200, x: 0, y: 0, toJSON: () => {},
    }));

    // Reactivate panel
    rerender({ panelActive: true });

    // Reactivation must not measure synchronously!
    expect(result.current.grantedClipIds.size).toBe(0);
    expect(onResetLayout).not.toHaveBeenCalled();

    // Advance to next frame
    act(() => {
      vi.advanceTimersByTime(16);
    });

    expect(onResetLayout).toHaveBeenCalledTimes(1);
    expect(onResetLayout).toHaveBeenCalledWith('c2');
    expect(result.current.layoutGeneration).toBe(1);
    expect(result.current.grantedClipIds).toEqual(new Set(['c2', 'c3']));
  });

  it('12b. detects UI zoom change while panel was hidden on reactivation with identical width and triggers layout reset preserving deep anchor', () => {
    let currentZoom = 1.0;
    const zoomSpy = vi.spyOn(uiScale, 'getUiZoom').mockImplementation(() => currentZoom);

    const clipRows = [
      [{ id: 'c0' }],
      [{ id: 'c1' }],
      [{ id: 'c2' }],
      [{ id: 'c3' }],
      [{ id: 'c4' }],
      [{ id: 'c5' }],
      [{ id: 'c6' }],
    ];
    const dom = createMockDom({
      scrollerRect: { top: 0, bottom: 200, width: 800, height: 200 },
      rowRects: [
        { index: 0, top: -500, bottom: -400, height: 100 },
        { index: 1, top: -400, bottom: -300, height: 100 },
        { index: 2, top: -300, bottom: -200, height: 100 },
        { index: 3, top: -200, bottom: -100, height: 100 },
        { index: 4, top: -100, bottom: 0, height: 100 },
        { index: 5, top: 0, bottom: 100, height: 100 },
        { index: 6, top: 100, bottom: 200, height: 100 },
      ],
    });
    const onResetLayout = vi.fn();

    const { result, rerender } = renderHook(
      (props: { panelActive: boolean }) =>
        useClipPlaybackWindow({
          scrollerEl: dom.scroller,
          panelActive: props.panelActive,
          lightweightEnabled: true,
          clipRows,
          requestedCap: 4,
          hardCap: 35,
          marginPx: 0,
          gridCols: 1,
          onResetLayout,
        }),
      { initialProps: { panelActive: true } },
    );

    act(() => {
      vi.advanceTimersByTime(16);
    });

    expect(result.current.grantedClipIds).toEqual(new Set(['c5', 'c6']));

    // Hide panel
    rerender({ panelActive: false });
    act(() => {
      vi.advanceTimersByTime(16);
    });
    expect(result.current.grantedClipIds.size).toBe(0);

    // Application UI zoom changes while width remains strictly identical (800px)
    currentZoom = 1.25;

    // Reactivate panel
    rerender({ panelActive: true });

    // Reactivation must not measure synchronously!
    expect(result.current.grantedClipIds.size).toBe(0);
    expect(onResetLayout).not.toHaveBeenCalled();

    // Advance to next frame
    act(() => {
      vi.advanceTimersByTime(16);
    });

    // Deep anchor 'c5' is preserved and reset exactly once
    expect(onResetLayout).toHaveBeenCalledTimes(1);
    expect(onResetLayout).toHaveBeenCalledWith('c5');
    expect(result.current.layoutGeneration).toBe(1);
    expect(result.current.grantedClipIds).toEqual(new Set(['c5', 'c6']));

    zoomSpy.mockRestore();
  });

  it('13. releases players and does not grant top-of-episode clips when grid is zero-sized, preserving anchor', () => {
    const clipRows = [
      [{ id: 'c0' }],
      [{ id: 'c1' }],
      [{ id: 'c2' }],
    ];
    const dom = createMockDom({
      scrollerRect: { top: 0, bottom: 100, width: 800, height: 100 },
      rowRects: [
        { index: 0, top: -100, bottom: 0, height: 100 },
        { index: 1, top: 0, bottom: 100, height: 100 },
        { index: 2, top: 100, bottom: 200, height: 100 },
      ],
    });

    const { result } = renderHook(() =>
      useClipPlaybackWindow({
        scrollerEl: dom.scroller,
        panelActive: true,
        lightweightEnabled: true,
        clipRows,
        requestedCap: 2,
        hardCap: 35,
        marginPx: 0,
        gridCols: 1,
      }),
    );

    act(() => {
      vi.advanceTimersByTime(16);
    });

    expect(result.current.grantedClipIds).toEqual(new Set(['c1']));

    // Make scroller zero-sized (e.g. collapsed or display:none) while rendered row elements still exist in DOM
    dom.scroller.getBoundingClientRect = vi.fn(() => ({
      top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 0, x: 0, y: 0, toJSON: () => {},
    }));

    act(() => {
      triggerResize(dom.scroller);
      vi.advanceTimersByTime(16);
    });

    // Zero-sized: must release players and NEVER grant top clips (c0)
    expect(result.current.grantedClipIds.size).toBe(0);
    expect(result.current.visibleClipIds.size).toBe(0);
    expect(result.current.grantedClipIds.has('c0')).toBe(false);
  });

  it('14. coalesces multiple small scroll events in one frame crossing threshold to trigger fast-scroll hold', () => {
    const clipRows = [
      [{ id: 'c0' }],
      [{ id: 'c1' }],
      [{ id: 'c2' }],
      [{ id: 'c3' }],
    ];
    const dom = createMockDom({
      scrollerRect: { top: 0, bottom: 100, width: 800, height: 100 },
      rowRects: [
        { index: 0, top: 0, bottom: 100, height: 100 },
        { index: 1, top: 100, bottom: 200, height: 100 },
        { index: 2, top: 200, bottom: 300, height: 100 },
        { index: 3, top: 300, bottom: 400, height: 100 },
      ],
    });

    const { result } = renderHook(() =>
      useClipPlaybackWindow({
        scrollerEl: dom.scroller,
        panelActive: true,
        lightweightEnabled: true,
        clipRows,
        requestedCap: 1,
        hardCap: 35,
        marginPx: 0,
        gridCols: 1,
      }),
    );

    act(() => {
      vi.advanceTimersByTime(16);
    });

    expect(result.current.grantedClipIds).toEqual(new Set(['c0']));

    // Send 3 small scroll events (20px, 25px, 25px = 70px > 60px) in the same frame before rAF runs
    act(() => {
      dom.scroller.scrollTop = 20;
      dom.scroller.dispatchEvent(new Event('scroll'));
      dom.scroller.scrollTop = 45;
      dom.scroller.dispatchEvent(new Event('scroll'));
      dom.scroller.scrollTop = 70;
      dom.scroller.dispatchEvent(new Event('scroll'));
    });

    // Move row 3 into view
    dom.rowEls[0].getBoundingClientRect = () => ({
      top: -300, bottom: -200, left: 0, right: 800, width: 800, height: 100, x: 0, y: -300, toJSON: () => {},
    });
    dom.rowEls[3].getBoundingClientRect = () => ({
      top: 0, bottom: 100, left: 0, right: 800, width: 800, height: 100, x: 0, y: 0, toJSON: () => {},
    });

    act(() => {
      vi.advanceTimersByTime(16);
    });

    // Hold should be active: no new players mounted!
    expect(result.current.fastScrolling).toBe(true);
    expect(result.current.grantedClipIds).toEqual(new Set(['c0']));
  });

  it('15. restarts 140ms settle timer on every scroll event during hold until scrolling stops', () => {
    const clipRows = [
      [{ id: 'c0' }],
      [{ id: 'c1' }],
      [{ id: 'c2' }],
    ];
    const dom = createMockDom({
      scrollerRect: { top: 0, bottom: 100, width: 800, height: 100 },
      rowRects: [
        { index: 0, top: 0, bottom: 100, height: 100 },
        { index: 1, top: 100, bottom: 200, height: 100 },
        { index: 2, top: 200, bottom: 300, height: 100 },
      ],
    });

    const { result } = renderHook(() =>
      useClipPlaybackWindow({
        scrollerEl: dom.scroller,
        panelActive: true,
        lightweightEnabled: true,
        clipRows,
        requestedCap: 1,
        hardCap: 35,
        marginPx: 0,
        gridCols: 1,
      }),
    );

    act(() => {
      vi.advanceTimersByTime(16);
    });

    // Trigger fast scroll
    act(() => {
      dom.scroller.scrollTop = 100;
      dom.scroller.dispatchEvent(new Event('scroll'));
      vi.advanceTimersByTime(16);
    });
    expect(result.current.fastScrolling).toBe(true);

    // Keep scrolling periodically at t=50ms, 100ms, 150ms, 200ms
    act(() => {
      vi.advanceTimersByTime(50);
      dom.scroller.scrollTop += 20;
      dom.scroller.dispatchEvent(new Event('scroll'));
    });
    expect(result.current.fastScrolling).toBe(true);

    act(() => {
      vi.advanceTimersByTime(50);
      dom.scroller.scrollTop += 20;
      dom.scroller.dispatchEvent(new Event('scroll'));
    });
    expect(result.current.fastScrolling).toBe(true);

    act(() => {
      vi.advanceTimersByTime(50);
      dom.scroller.scrollTop += 20;
      dom.scroller.dispatchEvent(new Event('scroll'));
    });
    expect(result.current.fastScrolling).toBe(true);

    act(() => {
      vi.advanceTimersByTime(50);
      dom.scroller.scrollTop += 20;
      dom.scroller.dispatchEvent(new Event('scroll'));
    });
    // At t=200ms (>140ms from start, but just triggered at 200ms), hold is STILL active
    expect(result.current.fastScrolling).toBe(true);

    // Advance 100ms (t=300ms, < 140ms since last event at 200ms)
    act(() => {
      vi.advanceTimersByTime(100);
    });
    expect(result.current.fastScrolling).toBe(true);

    // Advance 50ms more (t=350ms, > 140ms since last event at 200ms)
    act(() => {
      vi.advanceTimersByTime(50);
    });
    expect(result.current.fastScrolling).toBe(false);
  });

  it('16. cleans up timers and does not trigger state updates or errors on unmount during hold', () => {
    const clipRows = [[{ id: 'c0' }]];
    const dom = createMockDom({
      scrollerRect: { top: 0, bottom: 100, width: 800, height: 100 },
      rowRects: [{ index: 0, top: 0, bottom: 100, height: 100 }],
    });

    const onResetLayout = vi.fn();

    const { unmount } = renderHook(() =>
      useClipPlaybackWindow({
        scrollerEl: dom.scroller,
        panelActive: true,
        lightweightEnabled: true,
        clipRows,
        requestedCap: 1,
        hardCap: 35,
        marginPx: 0,
        gridCols: 1,
        onResetLayout,
      }),
    );

    act(() => {
      vi.advanceTimersByTime(16);
    });

    // Start fast scroll
    act(() => {
      dom.scroller.scrollTop = 100;
      dom.scroller.dispatchEvent(new Event('scroll'));
      vi.advanceTimersByTime(16);
    });

    // Unmount during hold
    unmount();

    // Verify all timers are cleared on unmount
    expect(vi.getTimerCount()).toBe(0);

    // Advancing timers beyond 140ms produces no calls or delayed measurement/reset callbacks
    act(() => {
      vi.advanceTimersByTime(500);
    });

    expect(onResetLayout).not.toHaveBeenCalled();
  });

  it('17. does not install scroll listeners when lightweightEnabled is false', () => {
    const clipRows = [[{ id: 'c0' }], [{ id: 'c1' }]];
    const dom = createMockDom({
      scrollerRect: { top: 0, bottom: 100, width: 800, height: 100 },
      rowRects: [{ index: 0, top: 0, bottom: 100, height: 100 }],
    });

    const addEventListenerSpy = vi.spyOn(dom.scroller, 'addEventListener');

    const { result } = renderHook(() =>
      useClipPlaybackWindow({
        scrollerEl: dom.scroller,
        panelActive: true,
        lightweightEnabled: false,
        clipRows,
        requestedCap: 2,
        hardCap: 35,
        marginPx: 0,
        gridCols: 1,
      }),
    );

    act(() => {
      vi.advanceTimersByTime(16);
    });

    expect(addEventListenerSpy).not.toHaveBeenCalledWith('scroll', expect.any(Function), expect.anything());
    expect(result.current.grantedClipIds.size).toBe(0);
    expect(result.current.fastScrolling).toBe(false);
  });

  it('18. only measures direct children with valid non-negative integer data-index', () => {
    const clipRows = [[{ id: 'c0' }], [{ id: 'c1' }]];
    const dom = createMockDom({
      scrollerRect: { top: 0, bottom: 200, width: 800, height: 200 },
      rowRects: [
        { index: 0, top: 0, bottom: 100, height: 100 },
      ],
    });

    // Add malformed elements
    const malformed1 = document.createElement('div');
    malformed1.setAttribute('data-index', '2foo');
    dom.list.appendChild(malformed1);

    const malformed2 = document.createElement('div');
    malformed2.setAttribute('data-index', '-1');
    dom.list.appendChild(malformed2);

    const { result } = renderHook(() =>
      useClipPlaybackWindow({
        scrollerEl: dom.scroller,
        panelActive: true,
        lightweightEnabled: true,
        clipRows,
        requestedCap: 2,
        hardCap: 35,
        marginPx: 0,
        gridCols: 1,
      }),
    );

    act(() => {
      vi.advanceTimersByTime(16);
    });

    expect(result.current.grantedClipIds).toEqual(new Set(['c0']));
  });

  it('19. does not install resize observer, zoom listener, or change layout generation when lightweightEnabled is false', () => {
    const clipRows = [[{ id: 'c0' }], [{ id: 'c1' }]];
    const dom = createMockDom({
      scrollerRect: { top: 0, bottom: 100, width: 800, height: 100 },
      rowRects: [{ index: 0, top: 0, bottom: 100, height: 100 }],
    });
    const onResetLayout = vi.fn();

    const windowAddEventListenerSpy = vi.spyOn(window, 'addEventListener');

    const { result } = renderHook(() =>
      useClipPlaybackWindow({
        scrollerEl: dom.scroller,
        panelActive: true,
        lightweightEnabled: false,
        clipRows,
        requestedCap: 1,
        hardCap: 35,
        marginPx: 0,
        gridCols: 1,
        onResetLayout,
      }),
    );

    act(() => {
      vi.advanceTimersByTime(16);
    });

    // UI zoom listener not attached
    expect(windowAddEventListenerSpy).not.toHaveBeenCalledWith(UI_ZOOM_CHANGED_EVENT, expect.any(Function));

    // Simulate width resize
    dom.scroller.getBoundingClientRect = vi.fn(() => ({
      top: 0, bottom: 100, left: 0, right: 500, width: 500, height: 100, x: 0, y: 0, toJSON: () => {},
    }));

    // Advance 300ms
    act(() => {
      vi.advanceTimersByTime(300);
    });

    // Layout generation remains unchanged, onResetLayout never called
    expect(result.current.layoutGeneration).toBe(0);
    expect(onResetLayout).not.toHaveBeenCalled();
  });
});
