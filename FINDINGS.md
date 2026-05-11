# Findings during the main.tsx split

Things spotted while moving code around. Not fixed in the split commits —
each is left to be addressed separately so the split stays move-only.

## Dead code

- `sourceClipPlaybackRange(clip: ClipPreviewItem): ClipVideoRange` — zero
  callers in the current codebase. Looks like a sibling of
  `previewClipPlaybackRange` that was either replaced or never wired up.
  Safe to delete. Moved during the split into
  `src/features/clips/ClipPreviewTile.tsx` (right next to its sibling) to
  keep the split move-only; the file uses `void sourceClipPlaybackRange;`
  to suppress `noUnusedLocals` until cleanup.
- `formatPreciseClipTime(seconds: number): string` — zero callers. Moved
  into `src/features/clips/ClipExtractorPanel.tsx` during the split with
  a `void` reference to silence the unused warning. Safe to delete.
- `readClipAudioSettings(): ClipAudioSettings` and
  `writeClipAudioSettings(settings: ClipAudioSettings)` — zero callers
  for either. They look like the read/write half of a never-finished
  per-clip audio remembering feature. Moved into
  `src/features/clips/ClipExtractorPanel.tsx` with `void` references.
  If the feature isn't coming back, delete both plus the
  `CLIP_AUDIO_SETTINGS_KEY` constant in `src/lib/constants.ts`.

## Resolved

- `AnimeBrowser` (was `function AnimeBrowser()` in main.tsx) — defined but
  never rendered; replaced by `AnikaiBrowser` per AGENTS.md. **Deleted in
  the split**, along with its dead-only callees: `readJson`, `animeCover`,
  `animeTrailer`, `animeTrailerPage`, `animeTrailerThumb`, the
  `AnimeResult` and `AnimeEpisode` types (and `src/types/anime.ts`), and
  the lucide imports `Search` / `Star` / `Tv` / `CalendarDays` / `Play` /
  `ExternalLink` that no other code referenced.
