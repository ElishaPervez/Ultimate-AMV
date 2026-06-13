/**
 * Tests for TsukyioPanel - the Tsukyio anime-clip vault browser.
 *
 * Covers: API-key gating, category browse (canonical category ids,
 * folder navigation, pagination, failure/retry), grouped per-category
 * search fan-out, the download lifecycle driven by the
 * `tsukyio-download-progress` event channel, the download-cancel path
 * (`tsukyio_cancel_download` invoke + `cancelled` events, including the
 * cancel-vs-rejection race), and thumbnail URL normalization.
 *
 * Out of scope (per panel architecture): dock collapse/expand chrome and
 * TsukyioPlayer playback internals (the player gets its own suite).
 */

import React from "react";
import { render, screen, fireEvent, waitFor, within, act } from "@testing-library/react";
import { mockInvoke, dispatchTauriEvent } from "../../../tests/setup/tauri";
import { TsukyioPanel } from "./TsukyioPanel";
import { REAL_CATEGORIES } from "./categories";
import type { TsukyioItem } from "../../types/tsukyio";

// jsdom's HTMLMediaElement methods are unimplemented stubs that emit
// "Not implemented" jsdomErrors when called. The dock's TsukyioPlayer calls
// load()/play()/pause() on mount and teardown, so replace them with quiet
// no-ops. Nothing in this suite asserts playback.
beforeAll(() => {
  Object.defineProperty(HTMLMediaElement.prototype, "load", {
    configurable: true,
    writable: true,
    value: vi.fn(),
  });
  Object.defineProperty(HTMLMediaElement.prototype, "play", {
    configurable: true,
    writable: true,
    value: vi.fn(async () => undefined),
  });
  Object.defineProperty(HTMLMediaElement.prototype, "pause", {
    configurable: true,
    writable: true,
    value: vi.fn(),
  });
});

const API_KEY = "vault-key";

type BrowseArgs = {
  apiKey: string;
  category: string | null;
  path: string | null;
  limit: number;
  offset: number;
};

type SearchArgs = { apiKey: string; q: string; category: string };

function clip(id: string, name: string, overrides: Partial<TsukyioItem> = {}): TsukyioItem {
  return {
    id,
    name,
    type: "video",
    category: "Raw",
    relPath: `Fights/${name}`,
    size: 24 * 1024 * 1024,
    thumbnail: null,
    ...overrides,
  };
}

function mockConfig(config: Record<string, unknown>): void {
  // get_config returns a raw bridge string; the panel parses the last line.
  mockInvoke("get_config", async () => JSON.stringify(config));
}

/** `/stats/global` payload: counts for two categories, the rest uncounted. */
function statsPayload() {
  return {
    success: true,
    data: {
      vault: {
        totalAssets: 40000,
        categories: [
          { id: "precuts", folder: "Precuts", files: 1234 },
          { id: "green_screen", folder: "Green Screen", files: 56 },
        ],
      },
    },
  };
}

function setupConnectedMocks(): void {
  mockConfig({ tsukyio_api_key: API_KEY, download_path: "C:\\downloads" });
  mockInvoke("tsukyio_set_session_key", async () => undefined);
  mockInvoke("tsukyio_test_connection", async () => statsPayload());
  mockInvoke("frontend_log", async () => undefined);
}

/** Register a browse mock returning `items`; returns the captured call args. */
function mockBrowse(
  items: TsukyioItem[],
  pagination: Partial<{ total: number; hasMore: boolean }> = {},
): BrowseArgs[] {
  const calls: BrowseArgs[] = [];
  mockInvoke("tsukyio_browse", async (args) => {
    calls.push(args as BrowseArgs);
    return {
      success: true,
      data: {
        items,
        pagination: {
          total: pagination.total ?? items.length,
          limit: 24,
          offset: 0,
          hasMore: pagination.hasMore ?? false,
        },
      },
    };
  });
  return calls;
}

/**
 * Register a search mock keyed by canonical category id. Values may be the
 * bare-array OR `{ items }` shape of the vault's `data` field (the panel must
 * handle both). Returns the captured call args.
 */
function mockSearch(byCategory: Record<string, unknown>): SearchArgs[] {
  const calls: SearchArgs[] = [];
  mockInvoke("tsukyio_search", async (args) => {
    const a = args as SearchArgs;
    calls.push(a);
    return { success: true, data: byCategory[a.category] ?? [] };
  });
  return calls;
}

/** Render a connected panel and settle on the discovery home (incl. stats). */
async function renderConnected() {
  const onOpenSettings = vi.fn();
  const result = render(<TsukyioPanel active onOpenSettings={onOpenSettings} />);
  await screen.findByText("Browse the anime asset vault");
  // Wait for the stats fetch to land too, so it can't resolve outside act().
  await screen.findByText("1,234 clips");
  return { ...result, onOpenSettings };
}

/** Click a category chip and wait for the named browse item to render. */
async function openCategory(label: string, expectItem: string) {
  fireEvent.click(screen.getByRole("tab", { name: label }));
  await screen.findByText(expectItem);
}

/** Type a query into the toolbar search box and submit with Enter. */
function submitSearch(query: string) {
  const input = screen.getByLabelText("Search the Tsukyio vault");
  fireEvent.change(input, { target: { value: query } });
  fireEvent.keyDown(input, { key: "Enter" });
}

/** The `.tsukyio-card` root for the clip with the given name. */
function getCard(name: string): HTMLElement {
  const thumb = screen.getByRole("button", { name: `Preview ${name}` });
  const card = thumb.closest(".tsukyio-card");
  if (!card) throw new Error(`no card root for ${name}`);
  return card as HTMLElement;
}

/** Connected render already navigated into the Raw category grid. */
async function renderRawGrid(items: TsukyioItem[]) {
  setupConnectedMocks();
  mockBrowse(items);
  const result = await renderConnected();
  await openCategory("Raw", items[0].name);
  return result;
}

describe("TsukyioPanel", () => {
  describe("API key gating", () => {
    it("shows the connect card and never queries the vault without an API key", async () => {
      mockConfig({});
      const sessionSpy = vi.fn(async () => undefined);
      mockInvoke("tsukyio_set_session_key", sessionSpy);
      const browseSpy = vi.fn(async () => ({ success: true, data: { items: [] } }));
      mockInvoke("tsukyio_browse", browseSpy);
      const searchSpy = vi.fn(async () => ({ success: true, data: [] }));
      mockInvoke("tsukyio_search", searchSpy);
      mockInvoke("frontend_log", async () => undefined);
      const onOpenSettings = vi.fn();

      render(<TsukyioPanel active onOpenSettings={onOpenSettings} />);

      expect(await screen.findByText("Connect the Tsukyio Vault")).toBeInTheDocument();
      // A missing key is pushed as null so the streaming proxy stops authing.
      await waitFor(() => expect(sessionSpy).toHaveBeenCalledWith({ key: null }));
      expect(browseSpy).not.toHaveBeenCalled();
      expect(searchSpy).not.toHaveBeenCalled();

      fireEvent.click(screen.getByRole("button", { name: "Add API key in Settings" }));
      expect(onOpenSettings).toHaveBeenCalledTimes(1);
    });

    it("connects without a remount when the key arrives via tsukyio-config-changed", async () => {
      mockConfig({});
      mockInvoke("tsukyio_set_session_key", async () => undefined);
      mockInvoke("tsukyio_test_connection", async () => statsPayload());
      mockInvoke("frontend_log", async () => undefined);

      render(<TsukyioPanel active onOpenSettings={vi.fn()} />);
      expect(await screen.findByText("Connect the Tsukyio Vault")).toBeInTheDocument();

      // The user saves a key in Settings; the panel re-reads config on the event.
      mockConfig({ tsukyio_api_key: API_KEY, download_path: "" });
      act(() => {
        window.dispatchEvent(new Event("tsukyio-config-changed"));
      });

      expect(await screen.findByText("Browse the anime asset vault")).toBeInTheDocument();
      expect(await screen.findByText("1,234 clips")).toBeInTheDocument();
    });

    it("loads the discovery home with stats (and no browse) when a key is configured", async () => {
      setupConnectedMocks();
      const sessionSpy = vi.fn(async () => undefined);
      mockInvoke("tsukyio_set_session_key", sessionSpy);
      const statsSpy = vi.fn(async () => statsPayload());
      mockInvoke("tsukyio_test_connection", statsSpy);
      const browseCalls = mockBrowse([]);

      await renderConnected();

      await waitFor(() => expect(statsSpy).toHaveBeenCalledWith({ apiKey: API_KEY }));
      expect(sessionSpy).toHaveBeenCalledWith({ key: API_KEY });
      expect(screen.getByText(/40,000 assets across 9 categories/)).toBeInTheDocument();
      // The discovery home renders tiles, not a browse grid: no fetch yet.
      expect(browseCalls).toHaveLength(0);
    });
  });

  describe("Browse", () => {
    it("browses with the canonical category id when a chip is clicked", async () => {
      setupConnectedMocks();
      const browseCalls = mockBrowse([
        clip("g1", "city chase.mp4", { category: "Green Screen", relPath: "Chases/city chase.mp4" }),
        { id: "f1", name: "Characters", type: "folder", relPath: "Characters", category: "green_screen", count: 12 },
      ]);

      await renderConnected();
      await openCategory("Green Screen", "city chase.mp4");

      expect(browseCalls[0]).toMatchObject({
        apiKey: API_KEY,
        category: "green_screen",
        path: null,
        limit: 24,
        offset: 0,
      });
      // Clip card and folder card both render from the browse payload.
      expect(screen.getByRole("button", { name: "Preview city chase.mp4" })).toBeInTheDocument();
      expect(screen.getByText("12 items")).toBeInTheDocument();
      expect(screen.getByText("Folder")).toBeInTheDocument();
    });

    it("opens a folder and re-browses scoped to its relPath", async () => {
      setupConnectedMocks();
      const browseCalls = mockBrowse([
        { id: "f1", name: "Characters", type: "folder", relPath: "Characters", category: "raw", count: 3 },
        clip("r1", "raw pan.mp4"),
      ]);

      await renderConnected();
      await openCategory("Raw", "raw pan.mp4");
      expect(browseCalls).toHaveLength(1);

      fireEvent.click(screen.getByRole("button", { name: /Characters/ }));

      await waitFor(() => expect(browseCalls).toHaveLength(2));
      expect(browseCalls[1]).toMatchObject({ category: "raw", path: "Characters", offset: 0 });
      const breadcrumb = await screen.findByRole("navigation", { name: "Folder path" });
      expect(within(breadcrumb).getByText("Raw")).toBeInTheDocument();
      expect(within(breadcrumb).getByText("Characters")).toBeInTheDocument();
    });

    it("advances the browse offset when paging forward", async () => {
      setupConnectedMocks();
      const browseCalls = mockBrowse([clip("r1", "raw pan.mp4")], { total: 50, hasMore: true });

      await renderConnected();
      await openCategory("Raw", "raw pan.mp4");

      expect(screen.getByText("Showing 1–24 of 50")).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Prev" })).toBeDisabled();

      fireEvent.click(screen.getByRole("button", { name: "Next" }));

      await waitFor(() => expect(browseCalls).toHaveLength(2));
      expect(browseCalls[1]).toMatchObject({ category: "raw", offset: 24 });
      expect(await screen.findByText("Page 2 of 3")).toBeInTheDocument();
      expect(screen.getByText("Showing 25–48 of 50")).toBeInTheDocument();
    });

    it("surfaces a browse failure and recovers via Retry", async () => {
      setupConnectedMocks();
      let fail = true;
      mockInvoke("tsukyio_browse", async () => {
        if (fail) throw new Error("vault offline");
        return {
          success: true,
          data: {
            items: [clip("r1", "raw pan.mp4")],
            pagination: { total: 1, limit: 24, offset: 0, hasMore: false },
          },
        };
      });

      await renderConnected();
      fireEvent.click(screen.getByRole("tab", { name: "Raw" }));

      expect(await screen.findByText("Could not reach Tsukyio")).toBeInTheDocument();
      expect(screen.getByText("vault offline")).toBeInTheDocument();

      fail = false;
      fireEvent.click(screen.getByRole("button", { name: "Retry" }));
      expect(await screen.findByText("raw pan.mp4")).toBeInTheDocument();
      expect(screen.queryByText("Could not reach Tsukyio")).not.toBeInTheDocument();
    });
  });

  describe("Search", () => {
    it("fans out one search per category and renders grouped sections", async () => {
      setupConnectedMocks();
      const searchCalls = mockSearch({
        // Bare-array `data` shape, including a dead "Audio"-tree duplicate.
        raw: [
          clip("v1", "sasuke vs naruto.mp4"),
          clip("dead1", "sasuke chant.mp3", { type: "audio", category: "Audio", relPath: "sasuke chant.mp3" }),
        ],
        // `{ items }` `data` shape.
        green_screen: {
          items: [clip("g1", "sasuke run.mp4", { category: "Green Screen", relPath: "Sasuke Edits/sasuke run.mp4" })],
        },
      });

      await renderConnected();
      submitSearch("sasuke");

      expect(await screen.findByText("sasuke vs naruto.mp4")).toBeInTheDocument();
      // One server call per real category, all carrying the query token.
      await waitFor(() => expect(searchCalls).toHaveLength(REAL_CATEGORIES.length));
      expect(new Set(searchCalls.map((c) => c.category))).toEqual(
        new Set(REAL_CATEGORIES.map((c) => c.id)),
      );
      for (const call of searchCalls) {
        expect(call).toMatchObject({ apiKey: API_KEY, q: "sasuke" });
      }

      // Grouped sections render per category, handling both data shapes.
      expect(screen.getByRole("heading", { name: /^Raw/ })).toBeInTheDocument();
      expect(screen.getByRole("heading", { name: /^Green Screen/ })).toBeInTheDocument();
      expect(screen.getByText("sasuke run.mp4")).toBeInTheDocument();
      // The dead "Audio" duplicate tree never renders.
      expect(screen.queryByText("sasuke chant.mp3")).not.toBeInTheDocument();
      // A matching relPath ancestor becomes a derived folder; the meta line
      // reports both totals.
      expect(screen.getByRole("heading", { name: /^Folders/ })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: /Sasuke Edits/ })).toBeInTheDocument();
      expect(screen.getByText(/2 clips · 1 folder for/)).toBeInTheDocument();
    });

    it("opens a derived search folder with the canonical category id", async () => {
      setupConnectedMocks();
      mockSearch({
        green_screen: {
          items: [clip("g1", "sasuke run.mp4", { category: "Green Screen", relPath: "Sasuke Edits/sasuke run.mp4" })],
        },
      });
      const browseCalls = mockBrowse([
        clip("g1", "sasuke run.mp4", { category: "Green Screen" }),
      ]);

      await renderConnected();
      submitSearch("sasuke");
      fireEvent.click(await screen.findByRole("button", { name: /Sasuke Edits/ }));

      await waitFor(() => expect(browseCalls).toHaveLength(1));
      // The folder carried the clip's DISPLAY category ("Green Screen"); the
      // browse call must use the canonical id instead.
      expect(browseCalls[0]).toMatchObject({
        category: "green_screen",
        path: "Sasuke Edits",
        offset: 0,
      });
      const breadcrumb = await screen.findByRole("navigation", { name: "Folder path" });
      expect(within(breadcrumb).getByText("Sasuke Edits")).toBeInTheDocument();
    });

    it("returns to the discovery home when the search is cleared", async () => {
      setupConnectedMocks();
      mockSearch({ raw: [clip("v1", "sasuke vs naruto.mp4")] });

      await renderConnected();
      submitSearch("sasuke");
      await screen.findByText("sasuke vs naruto.mp4");

      fireEvent.click(screen.getByRole("button", { name: "Clear" }));

      expect(await screen.findByText("Browse the anime asset vault")).toBeInTheDocument();
      expect(screen.queryByText("sasuke vs naruto.mp4")).not.toBeInTheDocument();
    });
  });

  describe("Download lifecycle", () => {
    it("starts a download and tracks progress from the event channel", async () => {
      const item = clip("a1", "akira bike slide.mp4");
      const downloadCalls: unknown[] = [];
      // Keep the invoke in flight forever: progress is driven purely by events.
      mockInvoke("tsukyio_download", (args) => {
        downloadCalls.push(args);
        return new Promise(() => {});
      });
      await renderRawGrid([item]);

      const card = getCard(item.name);
      fireEvent.click(within(card).getByRole("button", { name: "Download" }));

      expect(downloadCalls[0]).toMatchObject({
        apiKey: API_KEY,
        assetId: "a1",
        name: "akira bike slide.mp4",
        category: "Raw",
        pathHint: "Fights/akira bike slide.mp4",
        destDir: "C:\\downloads",
      });
      // The Download button is replaced by a Cancel button while in flight.
      expect(within(card).getByRole("button", { name: "Cancel 0%" })).toBeInTheDocument();

      act(() => {
        dispatchTauriEvent("tsukyio-download-progress", { type: "start", assetId: "a1", totalBytes: 1000 });
      });
      expect(within(card).getByRole("button", { name: "Cancel 0%" })).toBeInTheDocument();

      act(() => {
        dispatchTauriEvent("tsukyio-download-progress", {
          type: "progress",
          assetId: "a1",
          downloadedBytes: 500,
          totalBytes: 1000,
        });
      });
      expect(within(card).getByRole("button", { name: "Cancel 50%" })).toBeInTheDocument();
      expect(card.querySelector(".tsukyio-progress-fill")).toHaveStyle({ width: "50%" });

      // A progress tick with an unknown total keeps the last known percent.
      act(() => {
        dispatchTauriEvent("tsukyio-download-progress", {
          type: "progress",
          assetId: "a1",
          downloadedBytes: 700,
          totalBytes: null,
        });
      });
      expect(within(card).getByRole("button", { name: "Cancel 50%" })).toBeInTheDocument();
    });

    it("shows Reveal file after the done event and reveals the saved path", async () => {
      const item = clip("a1", "akira bike slide.mp4");
      mockInvoke("tsukyio_download", () => new Promise(() => {}));
      const revealSpy = vi.fn(async () => undefined);
      mockInvoke("reveal_in_folder", revealSpy);
      await renderRawGrid([item]);

      const card = getCard(item.name);
      fireEvent.click(within(card).getByRole("button", { name: "Download" }));
      act(() => {
        dispatchTauriEvent("tsukyio-download-progress", {
          type: "done",
          assetId: "a1",
          path: "C:\\downloads\\akira bike slide.mp4",
          downloadedBytes: 1000,
        });
      });

      fireEvent.click(within(card).getByRole("button", { name: "Reveal file" }));
      await waitFor(() =>
        expect(revealSpy).toHaveBeenCalledWith({ path: "C:\\downloads\\akira bike slide.mp4" }),
      );
    });

    it("surfaces an error event as a message with a retry affordance", async () => {
      const item = clip("a1", "akira bike slide.mp4");
      mockInvoke("tsukyio_download", () => new Promise(() => {}));
      await renderRawGrid([item]);

      const card = getCard(item.name);
      fireEvent.click(within(card).getByRole("button", { name: "Download" }));
      act(() => {
        dispatchTauriEvent("tsukyio-download-progress", { type: "error", assetId: "a1", message: "disk full" });
      });

      expect(within(card).getByText("disk full")).toBeInTheDocument();
      expect(within(card).getByRole("button", { name: "Retry download" })).toBeInTheDocument();
      expect(card.querySelector(".tsukyio-progress")).toBeNull();
    });

    it("surfaces a download invoke rejection as an error", async () => {
      const item = clip("a1", "akira bike slide.mp4");
      mockInvoke("tsukyio_download", async () => {
        throw new Error("403 forbidden");
      });
      await renderRawGrid([item]);

      const card = getCard(item.name);
      fireEvent.click(within(card).getByRole("button", { name: "Download" }));

      expect(await within(card).findByRole("button", { name: "Retry download" })).toBeInTheDocument();
      expect(within(card).getByText("403 forbidden")).toBeInTheDocument();
    });
  });

  describe("Download cancel", () => {
    it("Cancel invokes tsukyio_cancel_download and the cancelled event clears the entry", async () => {
      const item = clip("a1", "akira bike slide.mp4");
      mockInvoke("tsukyio_download", () => new Promise(() => {}));
      const cancelSpy = vi.fn(async () => undefined);
      mockInvoke("tsukyio_cancel_download", cancelSpy);
      await renderRawGrid([item]);

      const card = getCard(item.name);
      fireEvent.click(within(card).getByRole("button", { name: "Download" }));
      fireEvent.click(within(card).getByRole("button", { name: "Cancel 0%" }));

      await waitFor(() => expect(cancelSpy).toHaveBeenCalledTimes(1));

      act(() => {
        dispatchTauriEvent("tsukyio-download-progress", { type: "cancelled", assetId: "a1" });
      });

      // A cancelled download leaves no trace: plain Download button, no
      // error, no retry framing, no progress bar.
      expect(within(card).getByRole("button", { name: "Download" })).toBeInTheDocument();
      expect(card.querySelector(".tsukyio-dl-error")).toBeNull();
      expect(card.querySelector(".tsukyio-progress")).toBeNull();
    });

    it("treats the download rejection after a cancel as a cancel, not an error", async () => {
      const item = clip("a1", "akira bike slide.mp4");
      let rejectDownload: ((reason: Error) => void) | undefined;
      mockInvoke(
        "tsukyio_download",
        () =>
          new Promise((_resolve, reject) => {
            rejectDownload = reject;
          }),
      );
      mockInvoke("tsukyio_cancel_download", async () => undefined);
      await renderRawGrid([item]);

      const card = getCard(item.name);
      fireEvent.click(within(card).getByRole("button", { name: "Download" }));
      fireEvent.click(within(card).getByRole("button", { name: "Cancel 0%" }));

      // The Rust side aborts the transfer and the invoke rejects; because the
      // user asked for the cancel, no error may surface.
      await act(async () => {
        rejectDownload?.(new Error("request aborted"));
      });

      expect(await within(card).findByRole("button", { name: "Download" })).toBeInTheDocument();
      expect(card.querySelector(".tsukyio-dl-error")).toBeNull();
      expect(screen.queryByText("request aborted")).not.toBeInTheDocument();
    });

    it("cancelling one download leaves the other in flight", async () => {
      const a = clip("a1", "akira bike slide.mp4");
      const b = clip("a2", "akira explosion.mp4");
      mockInvoke("tsukyio_download", () => new Promise(() => {}));
      mockInvoke("tsukyio_cancel_download", async () => undefined);
      await renderRawGrid([a, b]);

      const cardA = getCard(a.name);
      const cardB = getCard(b.name);
      fireEvent.click(within(cardA).getByRole("button", { name: "Download" }));
      fireEvent.click(within(cardB).getByRole("button", { name: "Download" }));

      fireEvent.click(within(cardA).getByRole("button", { name: "Cancel 0%" }));
      act(() => {
        dispatchTauriEvent("tsukyio-download-progress", { type: "cancelled", assetId: "a1" });
      });

      expect(within(cardA).getByRole("button", { name: "Download" })).toBeInTheDocument();
      expect(within(cardB).getByRole("button", { name: "Cancel 0%" })).toBeInTheDocument();
    });

    it("the dock shows its own Cancel for the previewed clip's download", async () => {
      const item = clip("a1", "akira bike slide.mp4");
      mockInvoke("tsukyio_download", () => new Promise(() => {}));
      const cancelSpy = vi.fn(async () => undefined);
      mockInvoke("tsukyio_cancel_download", cancelSpy);
      await renderRawGrid([item]);

      fireEvent.click(screen.getByRole("button", { name: `Preview ${item.name}` }));

      const dock = screen.getByRole("complementary", { name: "Clip preview" });
      expect(within(dock).getByRole("heading", { name: item.name })).toBeInTheDocument();

      fireEvent.click(within(dock).getByRole("button", { name: "Download" }));
      fireEvent.click(within(dock).getByRole("button", { name: "Cancel 0%" }));
      await waitFor(() => expect(cancelSpy).toHaveBeenCalledTimes(1));

      act(() => {
        dispatchTauriEvent("tsukyio-download-progress", { type: "cancelled", assetId: "a1" });
      });
      expect(within(dock).getByRole("button", { name: "Download" })).toBeInTheDocument();
    });
  });

  describe("Thumbnails", () => {
    it("normalizes vault thumbnail URLs into loadable image sources", async () => {
      setupConnectedMocks();
      mockBrowse([
        clip("t1", "bracketed.mp4", {
          thumbnail: "https://localhost:3133/files/thumbnails/[Tsukyio] Raw Clips (3).jpg",
        }),
        clip("t2", "api-served.mp4", { thumbnail: "/api/v/links/abc def.jpg" }),
        clip("t3", "mal-cdn.mp4", { thumbnail: "https://cdn.myanimelist.net/images/anime/4/19644.jpg" }),
      ]);
      const { container } = await renderConnected();
      await openCategory("Raw", "bracketed.mp4");

      const sources = Array.from(
        container.querySelectorAll<HTMLImageElement>(".tsukyio-thumb img"),
      ).map((img) => img.getAttribute("src"));
      expect(sources).toHaveLength(3);
      // localhost dev-host thumbnails are re-rooted onto the public origin
      // with each path segment percent-encoded, slashes preserved.
      expect(sources[0]).toBe(
        "https://tsukyio.com/files/thumbnails/%5BTsukyio%5D%20Raw%20Clips%20(3).jpg",
      );
      // CORP-blocked /api/ paths route through the local thumb proxy packed
      // as ONE double-encoded segment (scheme varies per platform; the
      // /thumb/ suffix does not).
      expect(sources[1]).toMatch(/\/thumb\/%2Fapi%2Fv%2Flinks%2Fabc%2520def\.jpg$/);
      // Real absolute CDN URLs pass through untouched.
      expect(sources[2]).toBe("https://cdn.myanimelist.net/images/anime/4/19644.jpg");
    });
  });
});
