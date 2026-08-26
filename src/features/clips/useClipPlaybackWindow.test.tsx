import React from 'react';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import {
  useClipPlaybackWindow,
  type UseClipPlaybackWindowParams,
} from './useClipPlaybackWindow';
import { UI_ZOOM_CHANGED_EVENT } from '../../lib/uiScale';

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

  it('11. cleans up all observers, event listeners, and timers on unmount', () => {
    const clipRows = [[{ id: 'c0' }]];
    const dom = createMockDom({
      scrollerRect: { top: 0, bottom: 100, width: 800, height: 100 },
      rowRects: [{ index: 0, top: 0, bottom: 100, height: 100 }],
    });

    const removeEventListenerSpy = vi.spyOn(dom.scroller, 'removeEventListener');
    const windowRemoveListenerSpy = vi.spyOn(window, 'removeEventListener');

    const { unmount } = renderHook(() =>
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

    unmount();

    expect(removeEventListenerSpy).toHaveBeenCalledWith('scroll', expect.any(Function));
    expect(windowRemoveListenerSpy).toHaveBeenCalledWith(UI_ZOOM_CHANGED_EVENT, expect.any(Function));
  });
});
