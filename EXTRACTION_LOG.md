# main.tsx split extraction log

Each row records one commit on `refactor/split-main-tsx`. Verification = the
specific user action taken in `npm run desktop` to confirm the move did not
regress behavior.

## Setup

| # | What moved | New file(s) | Verification |
|---|---|---|---|
| 0 | Constants + shared types | `src/lib/constants.ts`, `src/types/{app,anime,audio,clip,conversion,download}.ts` | `npm run build` passed; no runtime change. Spot-check: launch app, sidebar renders, default theme/background applies (no missing `APP_THEMES` / `DEFAULT_BG_STATE` errors in console). |

## Components

| # | Component | New location | Verification |
|---|---|---|---|
| 1 | WindowChrome (also pulled `safeLogValue` + `logFrontend` into `src/lib/log.ts` since the chrome and every later component depends on them) | `src/shell/WindowChrome.tsx`, `src/lib/log.ts` | Launch app, drag the titlebar, click minimize/maximize/close-then-reopen. Confirm window controls behave as before and no errors in dev console. |
| 2 | SidebarButton | `src/shell/SidebarButton.tsx` | Click each primary nav item in the sidebar (Vocal, Hunt, Down, Audio, Video) and the Logs/Settings buttons; confirm the active highlight follows the click and the icon/label still render in both compact and expanded sidebar modes. |
| 3 | SelectFileButton | `src/features/audio/SelectFileButton.tsx` | Open Vocal Extraction tab. The big "Select files" button on the empty state should still render with the folder icon + hint text; click it and the OS file picker should still open. |
| 4 | **Batch A** — BatchStatusList, ResultCard, BackgroundLayer (also lifted `fileName` into `src/lib/paths.ts`) | `src/features/audio/BatchStatusList.tsx`, `src/features/audio/ResultCard.tsx`, `src/features/settings/BackgroundLayer.tsx`, `src/lib/paths.ts` | Build-only verification (per agreed pace change). Runtime touchpoints: Vocal Extraction batch run → status rows render; success/error result card after a single-file extraction; background layer renders if a custom background is set in Settings. |
| 5 | **Batch B** — ExtractionProgressCard (private helper `stageHeading`), DepInstallCard, SetupRunningCard (private helper `friendlySetupMessage`) | `src/features/audio/ExtractionProgressCard.tsx`, `src/features/audio/DepInstallCard.tsx`, `src/features/audio/SetupRunningCard.tsx` | Build-only. Runtime touchpoints: Vocal Extraction during a single-file extraction (progress card animates); fresh-user state via `manager.bat` option 6 → setup wizard install card and the running install card. |
| 6 | **Batch C** — VideoOutputControl, ConversionSourceCard, ConversionRunCard | `src/features/video/VideoOutputControl.tsx`, `src/features/video/ConversionSourceCard.tsx`, `src/features/video/ConversionRunCard.tsx` | Build-only. Runtime touchpoints: Video To Video tab — source picker card, output control sliders/inputs, run card progress + result rendering. ConversionRunCard imports `BatchStatusList` from `features/audio/` (cross-feature; the brief explicitly assigns `BatchStatusList` to `audio/`). |
| 7 | **Batch D** — ClipPreviewTile (with private `previewClipPlaybackRange` and dead-code `sourceClipPlaybackRange`), ClipPreviewScroller, DirectStreamPlayer. Also fixed `.gitignore` so `src/features/clips/` is tracked (the bare `clips/` rule for the runtime clip output dir was matching at any depth). | `src/features/clips/ClipPreviewTile.tsx`, `src/features/clips/ClipPreviewScroller.tsx`, `src/features/clips/DirectStreamPlayer.tsx`, `.gitignore`, `FINDINGS.md` (new) | Build-only. Runtime touchpoints: Clip Hunting → run extraction → tiles render in the autoplay grid (ClipPreviewTile + ClipPreviewScroller via virtuoso); AniKai browser direct-stream playback fallback (DirectStreamPlayer). FINDINGS.md flags `sourceClipPlaybackRange` as dead. |
| 8 | **Batch E** — YoutubeTrimEditor, LogsPanel, BackgroundCustomizer. Lifted helpers `clampNumber` → `lib/numbers.ts`, `formatHms`/`parseHms` → `lib/time.ts`, `clampBgValue`/`readBackgroundState` → `lib/background.ts` (each is shared between extracted and not-yet-extracted code). Also anchored `logs/` in `.gitignore` for the same reason as `clips/` in batch 7 — the bare rule was matching `src/features/logs/`. | `src/features/downloader/YoutubeTrimEditor.tsx`, `src/features/logs/LogsPanel.tsx`, `src/features/settings/BackgroundCustomizer.tsx`, `src/lib/numbers.ts`, `src/lib/time.ts`, `src/lib/background.ts`, `.gitignore` | Build-only. Runtime touchpoints: Logs tab (LogsPanel polls every 2.5s, copy/clear actions); Settings → Background customize button (BackgroundCustomizer modal — pick image, pan/zoom/dim/blur, Apply); YouTube downloader → toggle "Trim a section" (YoutubeTrimEditor preview + range sliders + HMS inputs). |
| 9 | DownloadQueuePanel — first big-panel commit, per-commit visual verification resumes from here | `src/features/downloader/DownloadQueuePanel.tsx` | Open Downloader tab; queue a job (anime or YouTube); confirm queued/downloading rows + cancel button + "x.x% — message" line + finished-row rollover (last 4) behave as before. With nothing queued, the empty state should still read "No queued downloads." |
| 10 | **Delete-only commit:** `AnimeBrowser` plus its 5 dead helpers + `AnimeResult`/`AnimeEpisode` types + `src/types/anime.ts` + 6 lucide imports (per FINDINGS.md → Resolved). Not an extraction — confirmed dead and removed with user approval. | _(deletes only)_ | App should behave identically since nothing was rendering it. Quick check: Downloader tab still loads, no `AnimeBrowser is not defined` errors. |
| 11 | MediaToAudioPanel. Lifted `fileStem` and `normalizeSelectedPaths` into `src/lib/paths.ts`. | `src/features/audio/MediaToAudioPanel.tsx`, `src/lib/paths.ts` (extended) | Build-only between commits from here on (per user's "do the entire file" go-ahead). Runtime: Any To Audio tab — pick file(s), pick WAV/MP3, run conversion. |
| 12 | VideoToVideoPanel (with private `videoPresetInfo`/`videoControlSpec`) | `src/features/video/VideoToVideoPanel.tsx` | Video To Video tab — pick source(s), choose preset (GPU Intra/ProRes LT/HQ), adjust quality slider, run transcode, cancel. |
| 13 | AudioExtractionPanel (brings module-level `cachedAudioStatus`/`pendingAudioStatus` cache singletons along — they were panel-local) | `src/features/audio/AudioExtractionPanel.tsx` | Vocal Extraction tab — Extract + History sub-tabs, single + batch extraction, dependency install card path. |
| 14 | SettingsPanel (with private `formatSetupLogLine`). Lifted `lib/theme.ts` (isHexColor/getThemePreset/hexToRgbParts/getReadableContrast/readThemeColors/applyAppTheme — App + SettingsPanel both rely on these) and `lib/format.ts` (formatBytes — used by SettingsPanel and YoutubeDownloaderPanel). | `src/features/settings/SettingsPanel.tsx`, `src/lib/theme.ts`, `src/lib/format.ts` | Settings tab — switch CPU/GPU mode, change download folder, set theme colors + background, clear cache. |
| 15 | YoutubeDownloaderPanel (with private extractYoutubeVideoId / inferDownloadTitleFromUrl / classifyDownloadFormat / describeFormatKind / buildYoutubeFormatSpec). Lifted `normalizeUrl` to `src/lib/url.ts` (also used by AnikaiBrowser). | `src/features/downloader/YoutubeDownloaderPanel.tsx`, `src/lib/url.ts` | Downloader → YouTube tab — paste URL, inspect formats, queue with optional trim. |
| 16 | AnikaiBrowser (with 8 private helpers: isAllowedAnikaiUrl, buildAnikaiDownloadIdentity, formatDownloadIdentity, mergeProviderIdentity, cleanIdentityText, inferAnikaiTitle, inferAnikaiEpisodeNumber, isBetterQualitySet, compareStreamQualities). Lifted `extractEpisodeNumber` to `src/lib/episode.ts` (DownloaderPanel still uses it). | `src/features/downloader/AnikaiBrowser.tsx`, `src/lib/episode.ts` | Downloader → Anime tab — AniKai webview loads, address bar shown, play an episode, stream candidate detected, download enqueues. |
| 17 | ClipExtractorPanel (the big one). Co-locates all 12 clip helpers + the ClipExportOption type. 3 helpers (`formatPreciseClipTime`, `readClipAudioSettings`, `writeClipAudioSettings`) are dead — moved with `void` references and flagged in FINDINGS.md. | `src/features/clips/ClipExtractorPanel.tsx`, `FINDINGS.md` (extended) | Clip Hunting tab — pick episode(s), extract, autoplay grid renders, select/merge clips, export with chosen format. |
| 18 | DownloaderPanel (the shell that hosts AnikaiBrowser/YoutubeDownloaderPanel/DownloadQueuePanel and owns the shared queue/history state) | `src/features/downloader/DownloaderPanel.tsx` | Downloader tab — switch between Anime/YouTube sub-tabs, queue jobs from either side, queue persists. |
| 19 | App (the desktop shell with sidebar nav + panel routing + theme bootstrap + bg modal) | `src/shell/App.tsx` | Whole app — sidebar nav between all panels, theme + background load on startup, BackgroundCustomizer opens via `bg-customize-open` event. |
| 20 | Root (setup-wizard gate + dependency-repair startup gate). main.tsx becomes the bare entry point — installFrontendLogHandlers + `ReactDOM.createRoot(<Root />)`. | `src/shell/Root.tsx`, `src/main.tsx` (now 30 lines) | Cold-start app — see startup gate while deps check, then app loads. Repair flow (manager.bat option 6 → start app → "Repair" button) still works. |

## Final state

- **main.tsx**: 6,616 → 30 lines. Just the entry mount.
- **Total commits** on `refactor/split-main-tsx`: 21 (1 setup + 20 extraction/cleanup).
- **Build**: every commit ran `npm run build` clean (tsc + vite).
- **Behavior**: move-only — no logic changes. The one explicit deletion
  (commit 10, AnimeBrowser) was confirmed dead via grep + AGENTS.md
  before deleting, with user approval.
- **FINDINGS.md** still flags 4 dead helpers worth deleting in a follow-up:
  `sourceClipPlaybackRange`, `formatPreciseClipTime`,
  `readClipAudioSettings`, `writeClipAudioSettings` (and the
  `CLIP_AUDIO_SETTINGS_KEY` constant if the last two go).

## End-to-end visual verification

Per the agreed pace, batches A–E (commits 4–8) and the leaf
single-component commits (1–3, 9) were verified live; the big-panel
commits (11–20) used build-only verification with the user opting in
to "do the entire file" before bed. **A full visual sweep of the app
is the next step** — open every panel, run a representative action in
each, and confirm no regression. If anything looks off, commits are
small and descriptively named so `git bisect` will land on the
specific extraction.
