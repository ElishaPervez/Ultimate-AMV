# Scene Grid Viewport Synchronization Design

**Date:** 2026-08-27

**Status:** Ready for user review before implementation

## Outcome

Every scene tile that is visibly inside the scrolling grid receives playback
permission when grid previews are enabled. Once its shared playback source is
ready, it plays without another scroll, hover, or window change. Scrolling deep
into an episode, resizing the window, leaving maximized mode, changing the
window aspect, changing page zoom, or switching the grid column count cannot
leave visible tiles unloaded.

The fix must retain the existing protection against WebView2 failure: the app
must never mount more live video players than the established decoder ceiling,
apart from the existing single hovered-tile allowance.

## Observed failure

The user can see scene cards inside the grid while the cards near the top of
the visible area have no playing preview. The area containing live previews
appears to move away from the area on screen. Changing the window size or
aspect can unload every visible card, and returning to the previous layout can
make them work again.

This is not a failed video decode. A ready video is withheld because the grid
believes a different group of rows occupies the viewport.

## Root cause

The virtual grid and the video-player gate maintain separate versions of the
layout:

1. The virtual grid measures real row positions and caches measurements for
   rows outside the screen.
2. The player gate estimates a row height from the scrolling panel width, then
   divides the saved scroll distance by that estimate to infer which rows are
   visible.
3. The source-preparation window is derived from the virtual grid's rendered
   range, while the live-player window is derived from the separate estimate.

Small measurement differences accumulate as the user scrolls farther down the
episode. A resize is more damaging because every row changes width and height,
while the virtual grid may still hold measurements made under the previous
layout. The player gate immediately applies its newly estimated height to the
entire list. Both calculations remain internally valid, but they refer to
different rows.

The existing resize grace period only prevents a layout-driven scroll jump
from being classified as a fast user fling. It does not synchronize the two
layouts. The existing forced grid reset only runs when the column count
changes. It does not run when the available width or WebView2 page zoom
changes.

## Scope

This change covers only Scene Splitter grid visibility, preview preparation,
and live-player mounting.

It does not change:

- scene detection;
- scene boundary timestamps;
- the inward-padded preview ranges;
- clip export, Smart cut, merging, or frame-accurate seek behavior;
- source proxy encoding or CPU/GPU fallback behavior;
- the maximum live-player safety ceiling;
- the classic animated-image preview path when lightweight previews are off.

## Chosen design

### One measured playback window

The app will stop converting scroll distance into row numbers. Instead, after
the browser lays out the grid, it will inspect the real rectangles of the rows
currently rendered by the virtual grid.

For each rendered row:

- the row is **visible** when its rectangle intersects the scrolling panel's
  rectangle;
- the row is **prewarm eligible** when it intersects the same rectangle
  expanded by the existing 250-pixel margin;
- the row is **outside** when it intersects neither area.

The central selection then grants players in this order:

1. Grant every visible tile first.
2. If capacity remains, grant prewarm tiles nearest the viewport center.
3. Stop at the effective player limit.
4. Never exceed `MAX_GRID_VIDEO_PLAYERS_CEILING`.

The existing live setting remains a prewarm allowance, not permission to drop
visible tiles. The effective limit is therefore the larger of the configured
allowance and the number of visible tiles, clamped to the hard ceiling.

If an abnormal layout physically exposes more tiles than the hard ceiling,
the ceiling wins. Choose the visible tiles nearest the viewport center so the
middle of the screen remains useful. This case must be observable in the
development readout but must not raise the ceiling.

### One consumer set for lightweight previews

The measured, capped set supplies all lightweight-preview decisions:

- which sources receive a playback-plan request;
- which sources may start a shared proxy build;
- which cards report that playback preparation is pending;
- which cards may mount a live video player.

This removes the current condition where source preparation and player
mounting disagree about which cards are active.

When lightweight previews are disabled, the existing virtual-grid range keeps
driving animated-image playback. The new measurement path must not alter the
classic preview behavior.

### Measurement scheduling

Layout reads must be grouped into one animation-frame callback. A single
scheduler coalesces any number of triggers occurring before the next frame.
It measures only the rows currently rendered by the virtual grid, so the work
remains bounded by the existing overscan rather than the total scene count.

Schedule a measurement after:

- a scroll event;
- the virtual grid reports a different rendered range;
- the scrolling panel changes size;
- the WebView2 page zoom changes;
- the grid column count changes;
- lightweight previews turn on;
- the Scene Splitter panel becomes visible again;
- the clip list changes;
- the fast-scroll hold ends;
- the virtual grid is reset after a width change.

Read the scrolling panel rectangle and every rendered row rectangle in one
pass, calculate the granted IDs without changing the document, then publish
one state update only when the granted IDs actually changed.

### Fast scrolling

The existing rule remains: during a genuine fast fling, do not allocate new
video decoders on every frame. Hold the last committed player set while the
fling is active.

When the fling settles, immediately measure the actual row rectangles and
replace the held set. A window resize, page zoom change, column change, or
panel reactivation is not a user fling and must cancel the hold before the new
measurement is committed.

Scroll velocity can stay in refs; it no longer needs to push every sampled
scroll position through React state because visibility no longer depends on
the numeric scroll distance.

### Width and zoom changes

A width change modifies every row height, including rows currently outside
the screen. When a width-change burst starts, preserve the first visible clip
from the last committed pre-resize measurement in a dedicated resize anchor.
Do not replace that anchor while the burst continues. After the width stops
changing for 120 milliseconds:

1. Increment a layout generation included in the virtual grid's React key.
2. Let the fresh grid discard old row measurements.
3. Reopen at the row containing the preserved resize anchor.
4. Measure the new rendered row rectangles and publish the new player set.
5. Clear the resize anchor so the next independent resize captures a fresh one.

Height-only changes do not alter row height. They schedule a new rectangle
measurement but do not reset the virtual grid.

Listen to both the scrolling panel's `ResizeObserver` and
`UI_ZOOM_CHANGED_EVENT`. The explicit zoom event covers WebView2 changes whose
ordering does not produce a dependable DOM resize callback.

Continuous drag-resizing must cause at most one virtual-grid reset after the
last width change. Rectangle measurements may continue during the drag so the
currently visible area remains useful, but those intermediate measurements
must not replace the resize anchor captured at the beginning of the burst.

### Panel visibility

The Scene Splitter stays mounted when another section is open. A hidden panel
has zero-size rectangles and must not overwrite the last valid anchor with an
empty measurement.

When the panel becomes inactive:

- release live video players;
- cancel scheduled measurement and resize-settle callbacks;
- retain the last valid anchor.

When it becomes active:

- wait until the next animation frame;
- measure the restored scrolling panel and rendered rows;
- mount only the newly granted set.

## Component boundaries

### New viewport-selection module

Create `src/features/clips/clipPlaybackWindow.ts` for pure selection logic.
It must not read the DOM or React state.

Input shape:

```ts
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

export function selectClipPlaybackWindow(
  input: ClipPlaybackWindowInput,
): ClipPlaybackWindowResult;
```

Coordinates use viewport-relative CSS pixels from `getBoundingClientRect()`.
Rows with zero height or non-finite coordinates are ignored. An intersection
requires `row.bottom > bandTop && row.top < bandBottom`, so a row touching an
edge without occupying visible pixels is not counted.

### New React measurement hook

Create `src/features/clips/useClipPlaybackWindow.ts` for DOM observation,
animation-frame scheduling, resize settling, fast-scroll holding, and cleanup.

The hook consumes:

- the current scrolling element;
- whether the panel and lightweight previews are active;
- the rendered clip rows;
- requested and hard player limits;
- the existing prewarm margin;
- the current column count;
- a callback that requests a virtual-grid reset while preserving an anchor.

The hook returns:

- the committed granted clip IDs;
- the actually visible clip IDs;
- the first visible row;
- whether a fast-scroll hold is active;
- development-only measurement details.

The hook locates virtual-grid item wrappers under
`[data-testid="virtuoso-item-list"] > [data-index]`. Each wrapper's numeric
`data-index` identifies the corresponding entry in the panel's `clipRows`
array. Missing or invalid indices are skipped.

The selector is pure and receives copied coordinates and clip IDs. DOM reads
must not be embedded inside the selector.

### Scene Splitter integration

Modify `src/features/clips/ClipExtractorPanel.tsx` to:

- replace the estimated row-height and scroll-distance player calculation with
  the new hook;
- use the hook's granted IDs for lightweight source preparation and live-player
  permission;
- keep the existing virtual-grid reported range only for classic animated-image
  previews;
- include the debounced layout generation in the virtual grid key;
- preserve the actual first visible clip across column and width resets;
- delete the retired estimated-geometry state, calculation, and tests after the
  replacement tests pass;
- retain decoder cleanup, hover allowance, playback speed, proxy failure, and
  merge behavior unchanged.

Modify `src/features/clips/ClipPreviewTile.tsx` only if needed to rename the
mount-permission prop for clarity. Its behavior remains: a granted lightweight
tile may mount a player, and one hovered tile may temporarily mount outside the
capped set.

### Development diagnostics

Extend the existing preview development panel rather than adding production
logging. Show:

- scrolling panel width and height;
- first and last actually visible row;
- visible tile count;
- granted player count;
- current hard cap;
- whether fast-scroll hold is active;
- current layout generation;
- whether visible count exceeded the hard cap.

The readout lets a tester see immediately whether the app's player set matches
the cards on screen. It must remain excluded from production UI.

## Alternatives considered

### Reset the virtual grid on resize only

This would likely fix the dramatic orientation failure, but gradual drift would
remain because the player gate would still infer rows from accumulated pixel
math. Rejected as incomplete.

### Adjust the estimated row-height formula

Changing scrollbar, padding, border, or rounding constants could make one
layout match more closely. It would fail again when CSS, WebView2 zoom,
subpixel rounding, or virtual-grid corrections change. Rejected because the
browser already exposes the real positions.

### Restore independent per-tile intersection observers

Independent observers naturally follow the screen but previously allowed too
many players to mount at once. Rejected in that form. The chosen design keeps
one central capped decision while still using actual on-screen geometry.

### Replace the virtual-grid library

Another library could own both grid layout and virtualization, but replacing
the grid introduces unrelated selection, scroll preservation, and rendering
risk. Rejected because the current library already exposes enough rendered DOM
to fix the faulty player calculation.

## Test design

### Pure selection tests

Create `src/features/clips/clipPlaybackWindow.test.ts` with these cases:

1. Every row physically intersecting the viewport is granted before any
   prewarm row.
2. A partially visible row at the top and a partially visible row at the bottom
   are both visible.
3. A row touching an edge without occupying pixels is not visible.
4. Prewarm rows are selected nearest the viewport center until capacity is
   exhausted.
5. The requested cap below the visible count expands to the visible count.
6. The hard cap is never exceeded.
7. When visible tiles exceed the hard cap, the selected visible tiles are the
   ones nearest the viewport center and the overflow flag is true.
8. Invalid and zero-height rectangles are ignored.
9. Sparse rendered row indices map to the supplied clip IDs without assuming
   fixed row heights or contiguous mounted rows.
10. Re-running with the same rectangles produces the same IDs and ordering.

### Hook and integration tests

Create `src/features/clips/useClipPlaybackWindow.test.tsx` and extend the
Scene Splitter tests to prove observable behavior:

1. Scrolling changes the granted set based on mocked row rectangles, even when
   the supplied row heights are deliberately unequal.
2. A viewport height change updates the granted set without a scroll event.
3. A viewport width change schedules one reset after 120 milliseconds and
   preserves the first actually visible clip.
4. Several width changes inside the settle period still produce one reset.
5. `UI_ZOOM_CHANGED_EVENT` schedules a reset and a fresh measurement.
6. A fast fling holds the prior set; the first measurement after settling
   grants every currently visible tile.
7. A resize during a fling cancels the hold and publishes the resized visible
   set.
8. Hiding the panel releases grants without replacing the saved anchor with an
   empty value.
9. Reactivating the panel measures on the next frame and grants the visible
   tiles.
10. Lightweight source preparation receives the same granted IDs used by the
    tile mount permission.
11. Classic previews continue using the existing virtual-grid range and do not
    depend on the new rectangle measurement.
12. Observer, timer, animation-frame, scroll, resize, and zoom listeners are all
    removed on cleanup.

Tests must use fake timers, a controllable `ResizeObserver`, mocked
`getBoundingClientRect()` results, and a controllable animation-frame queue.
They must fail against the current estimated calculation before production
logic is replaced.

### Existing regressions

Run at minimum:

```powershell
npm run test:js -- --run `
  src/features/clips/clipPlaybackWindow.test.ts `
  src/features/clips/useClipPlaybackWindow.test.tsx `
  src/features/clips/ClipExtractorPanel.mount.test.tsx `
  src/features/clips/ClipExtractorPanel.test.tsx `
  src/features/clips/ClipPreviewTile.test.tsx `
  src/features/clips/ClipPreviewScroller.test.tsx
```

Then run:

```powershell
npm run test:js
npm run build
```

The old estimated-geometry test file may be removed or rewritten only after
equivalent decoder-cap, fast-fling, and no-visible-dead-zone coverage exists in
the new tests.

## Real-app verification

Automated DOM tests cannot reproduce WebView2 video decoder behavior or the
virtual grid's complete measurement lifecycle. Verify with a real episode that
produces enough scenes for at least 100 grid rows.

Perform this sequence with lightweight previews enabled:

1. At four columns, scroll from the first row to near the final row slowly.
   Every visible tile plays; the playing area does not move away from the
   viewport.
2. Fling rapidly several times and stop at arbitrary positions. Placeholders
   may remain during the fling, but the development readout grants every
   visible ready-source tile within 250 milliseconds after motion stops, and
   those tiles show moving frames within one second without further input.
3. While stopped halfway down the episode, leave maximized mode and resize to
   a narrow portrait-like window. The same anchor clip remains near the top and
   every visible tile plays after layout settles.
4. Maximize again. The anchor remains stable and visible tiles continue playing.
5. Repeat the aspect change at one, two, three, and four columns.
6. Switch to another app section and return to Scene Splitter. Visible tiles
   resume without scrolling or restoring the old window shape.
7. Change Windows display scaling or move the window between monitors with
   different scaling when available. Visible tiles recover after the zoom
   change without requiring a second resize.
8. Turn lightweight previews off. Classic previews behave exactly as before.
9. Watch the development readout throughout. Granted count never exceeds the
   hard ceiling, and its visible-row range matches the cards actually on screen.

## Acceptance criteria

The work is complete only when all of the following are true:

- No visible scene tile is denied a player while the number of visible tiles is
  at or below the hard decoder ceiling.
- Scrolling through at least 100 rows produces no growing offset between visible
  cards and playing cards.
- Width, orientation, maximize, restore, zoom, column, and panel-visibility
  changes recover without requiring the user to reverse the interaction.
- Fast scrolling allocates no new players during the hold. Every visible
  ready-source tile receives playback permission within 250 milliseconds after
  settling and shows a moving frame within one second without further input.
- The granted live-player count never exceeds
  `MAX_GRID_VIDEO_PLAYERS_CEILING`; the existing single hovered-tile allowance
  remains the only exception.
- Lightweight playback preparation and live mounting use the same granted IDs.
- Classic previews remain unchanged when lightweight previews are disabled.
- The virtual grid preserves the first actually visible clip across width and
  column resets.
- No backend, scene-boundary, preview-range, export, merge, CPU/GPU parity, or
  source-proxy behavior changes.
- New focused tests, the complete frontend test suite, and the production
  frontend build pass.

## Implementation guardrails for Gemini

- Read `AGENTS.md`, `docs/agent/debugging-with-real-data.md`, and the Frontend
  layout plus clip-boundary sections of `docs/agent/CLAUDE-NOTES.md` before
  editing.
- Use test-driven development: add failing rectangle/resize tests before
  replacing the current calculation.
- Do not change the clip-extraction backend or any video engine.
- Do not raise decoder limits to hide missing visible tiles.
- Do not solve only the resize case; the slow-scroll drift is part of the same
  acceptance contract.
- Do not use raw scroll distance divided by an estimated height anywhere in the
  replacement visibility path.
- Do not run source preparation from a different active set than live-player
  mounting.
- Preserve unrelated working-tree changes.
- Commit each focused change locally on `main` and do not push without the
  user's explicit `push` instruction.
- Report back with the exact automated commands run, their pass/fail result,
  the real-app steps completed, and any acceptance step that could not be
  verified. Do not claim the bug is fixed if real-app verification was skipped.
