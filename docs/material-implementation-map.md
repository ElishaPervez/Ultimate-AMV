# Smoked-Glass Material — Implementation Map

> Read-only deep audit, 2026-06-12. Companion to the visual demo at
> `docs/ui-glass-material-demo.html`. Execute phases in order; each
> Phase-2 step is independently shippable.

All paths relative to repo root. The app shell is: `.desktop` > `.app-bg` (wallpaper) + `.app-shell` > `.sidebar` + `.workspace` > `.canvas` > `.focus-panel.glass` (`src/shell/App.tsx:595`) > `.mode-switcher` + `.panel-body` > `.panel-view` > one page component. **Every page lives inside the single `.focus-panel.glass`**, which fills the entire workspace — so the focus panel must NOT be a material carrier (it would smoke the whole viewport); carriers are the page-level cards/consoles inside it.

## 1. Cascade architecture & where the material lives

`src/styles.css:20` declares `@layer reset, base, theme, user`. Imports: all 11 feature sheets → `layer(base)` (`styles.css:23-33`); `theme.css` → `layer(theme)` (`styles.css:36`); `bright-ink.css` → `layer(user)` (`styles.css:41`). Inline `:root` accent styles from `src/lib/theme.ts:57-63` (`applyAppTheme`) beat all layers — material token names must not collide with `--theme-accent-*`.

**Recommendation:** new file `src/styles/material.css`, imported in `src/styles.css` as `@import "./styles/material.css" layer(theme);` **after** the theme.css import. Rationale:
- In `theme` it beats every base-layer rule (incl. all `:root.has-app-bg` rules in base.css §3 and the per-feature card fills) without `!important` and without specificity wars.
- It stays *below* `user` (bright-ink), preserving the existing contract that the Dark-text toggle wins — which Phase 3/4 then re-scopes.
- Don't put it in theme.css itself: theme.css is the "look" reskin; the material is wallpaper-mode behavior and will carry many `:root.has-app-bg` selectors — keep it separable.
- Material tokens go in a `:root` block inside material.css (theme layer token redefinition is already the established pattern, theme.css:16-35).

Suggested core (one class, opt-in per carrier):

```css
:root {
  --material-blur: 20px;
  --material-tint: rgba(10, 12, 24, 0.30);
  --material-edge: inset 0 1px 0 rgba(255,255,255,0.08), 0 12px 40px -12px rgba(0,0,0,0.5);
}
:root.has-app-bg .u-material {
  background: var(--material-tint);
  backdrop-filter: blur(var(--material-blur)) brightness(0.55) saturate(1.4);
  -webkit-backdrop-filter: blur(var(--material-blur)) brightness(0.55) saturate(1.4);
  box-shadow: var(--material-edge);
  border: 1px solid var(--glass-border);
}
/* no-nesting guard: anything glassy inside a carrier loses its own backdrop snapshot */
:root.has-app-bg .u-material :is(.glass, .glass-strong) {
  backdrop-filter: none; -webkit-backdrop-filter: none;
}
```

Gate on `:root.has-app-bg` so the no-wallpaper look (theme.css indigo gradient, `theme.css:41-48`) is untouched.

## 2. Every `has-app-bg` rule (complete)

All hits: `base.css` §3 (hub), `new-audio.css:336-344`, `theme.css:41-43` (inverse guard, leave), `App.tsx:264` (class writer).

### (a) Surface-transparency rules the material replaces/retires

| Rule | Disposition |
|---|---|
| `base.css:168-172` `:root.has-app-bg, body, #root → transparent` | Keep (wallpaper must show). |
| `base.css:173-177` `.desktop/.app-shell/.workspace → transparent` | Keep. |
| `base.css:178-180` `.focus-panel → transparent` | Keep transparent; focus-panel is NOT a carrier. |
| `base.css:181-183` `.sidebar → rgba(13,16,22,.45)` | Replace: sidebar becomes a material carrier. |
| `base.css:184-188` `.clip-extractor/.downloader-workspace/.anikai-browser → transparent` | Keep (full-bleed containers; carriers live inside them). |
| `base.css:189-192` `.youtube-downloader → accent gradient` | Keep (decorative wash; cards inside become carriers). |
| `new-audio.css:336-344` strips `dash-hero-card`, `dash-side-card`, `dash-stage-main > .extract-vocals-button/.audio-card/.stem-mixer` to fully transparent + `backdrop-filter:none` | **Delete entire block** — the prior "no slabs" pass that the material supersedes; those elements become carriers again. |

### (b) Text-halo / forced-white rules

| Rule (base.css) | Targets | After material |
|---|---|---|
| `:199-209` halo text-shadow | `.settings-toolbar` (bare → **keep**), `.settings-group-header` (inside scrimmed group → retire), `.settings-section-label`, `.setting-row-description`, `.setting-row-label`, `.audio-status-line` (**dead selectors — no TSX usage; delete**), `.extract-hint` (`SelectFileButton.tsx:10`, inside future `dash-stage-main` carrier → retire), `.conversion-kicker` (bare hero → **keep**), `.bg-customizer-hint` (inside solid modal — harmless; delete) |
| `:216-228` forced `#fff` + halo | `.dash-hero-kicker`, `.dash-status-label` (inside hero carrier → retire), `.conversion-kicker` (**keep** — bare), `.conversion-format-card > span`, `.conversion-card small`, `.conversion-field-label`, `.clip-source-card small`, `.clip-cols-label span`, `.video-output-control-head small` (all inside carriers → retire), `.tsukyio-kicker` (bare header → **keep**) |
| `:231-242` soft white + halo | `.dash-hero-desc`, `.dash-tip-text`, `.conversion-card p`, `.video-output-control-head > div > span`, `.tsukyio-home-head p`, `.tsukyio-tile-count`, `.tsukyio-card-sub`, `.youtube-download-head small` (inside carriers → retire); `.conversion-hero p` (bare → **keep**) |
| `:247-250` `:not(.bright-ink) .tsukyio-cat-chip` white | Chips move into the tsukyio console carrier → retire |

**Keep list (text that stays bare on wallpaper):** `.conversion-kicker`, `.conversion-hero h2/p` (audio/video/bgremove heroes), `.tsukyio-kicker` + header h2, `.home-hero-title/.home-hero-sub` (currently *unprotected* — add halo when grid becomes the only carrier), `.mode-switcher` tabs (currently unprotected — see §4 hazards), `.settings-toolbar`.

### (c) `--app-bg-blur` coupling to decouple

- `base.css:258-266`: `.sidebar, .focus-panel, .glass, .glass-strong, .merge-strip, .stem-mixer → backdrop-filter: blur(var(--app-bg-blur, 0px))`. **Delete the whole rule.** The wallpaper blur slider already blurs the wallpaper element itself via inline `filter` (`BackgroundLayer.tsx:82` video, `:93` image), so the slider keeps its meaning with zero CSS coupling.
- `App.tsx:268-272`: the `--app-bg-blur` setProperty writer becomes dead → remove (nothing else reads it; verified).

## 3. Glass/panel surface inventory → carrier / control / untouched

**Token definitions:** `--glass/--glass-border/--panel/--panel-strong` at `base.css:60-64`, redefined `theme.css:25-29`. `.glass` `base.css:112-117` (blur 12), `.glass-strong` `base.css:119-124` (blur 16, **never used in any TSX — dead class**), theme polish `theme.css:78-83`.

| Surface | Where | Decision |
|---|---|---|
| `.focus-panel.glass` | `App.tsx:595`, `shell.css:739`, `base.css:178` | **Untouched/transparent** — opt out of material; lose backdrop-filter under has-app-bg (rule deleted in §2c). Keep class for radius/border. |
| `.sidebar` | `shell.css:1000-1007`, `theme.css:54`, `base.css:181` | **Carrier** (1 element, always visible). |
| `.glass` cards in BgRemovePanel (`:550,570,607,669,1172`), `VideoComparisonCard.tsx:185`, `BgRemoveResultCard.tsx:32` | inline-styled | **Controls inside carriers** — must NOT blur (guard rule). |
| `.clip-import-button.glass`, `.clip-source-card.glass`, `.clip-run-card.glass` | `ClipExtractorPanel.tsx:1622,1629,1823` | Controls inside the rail carrier. |
| `.tsukyio-connect-card.glass` | `TsukyioPanel.tsx:802` | **Carrier** (only surface on the connect screen). |
| `.settings-tab-bar.glass`, `.settings-group.glass` | `SettingsPanel.tsx:260`, EngineSettings/FeatureSettings/AppearanceSettings/UpdateCard, scrim composite `modals.css:133-140` | Settings treatment was **user-accepted** — minimal change. Optional consistency swap of the scrim for the material; if swapped they become carriers and the bright-ink settings block shrinks. Low priority. |
| `var(--glass)` users in tsukyio.css (`:162,229,263,334,343,598,840,1115,1238` — search input, cat chips, crumb-up, cards, dock, reopen, tiles, show-all) | | Controls inside tsukyio carriers (dock itself = carrier, `:590-600`). |
| `--panel/--panel-strong` users: `startup-gate-card` `components.css:527`, `startup-gate-table` `:590`, `tools-gate-row` `:701` | gates | **Untouched** (solid full-screen gates on `#020203`, `components.css:506-515`). |
| `.dash-hero-card` `new-audio.css:57-66`, `.dash-side-card` `:218-224`, `.dash-stage-main > *` wrappers `:303-321`, `.dash-tip-card` `:276` | vocal sep | Hero + stage-main = **carriers**; side column = one carrier (see §4). |
| `.conversion-format-card` (`audio.css:851`), `.conversion-card.source-card/.run-card` (`audio.css:1058-1075` — no background, just padding + border-left divider) | conversion pages | `conversion-grid` / format card become carriers (§4). |
| `.video-output-control` `audio.css:914-924` | own gradient fill | Control inside carrier; keep fill. |
| `.youtube-download-card`, `.download-history-panel` `downloader.css:147-156`, `.youtube-trim` `audio.css:1251-1258`, `.youtube-format-list` buttons `downloader.css:229-241` | youtube tab | Carriers: download card, format list, trim, history (§4). |
| `.download-queue-panel` `downloader.css:27-37` (rgba(8,11,13,.58)) | queue rail | **Carrier** (replace fill with material). |
| `.merge-strip` `clips.css:704-719` (92% dark + blur 10), `.clip-jump-pill` `clips.css:492-511` (blur 12) | floating HUDs over the clip stage | **Untouched** — already self-carrying smoked pills; just remove `.merge-strip` from the deleted coupling rule. |
| `.home-card` `home.css:51-63` | home grid | Controls; `.home-grid` gets the carrier (§4). |
| `.logs-stats` `components.css:28-35`, `.logs-filters` `:216-224`, `.terminal-log` `:296-311` | logs | Console carrier + terminal carrier (§4). |
| `.anikai-browser` children: `provider-toolbar` `downloader.css:369-380` (96% solid), `stream-capture-bar` `:545-555` (98% solid), `provider-webview-frame` `:522` (#0f1418) | embedded browser | **Untouched solid islands.** |
| `.custom-dropdown-menu` `components.css:909-929` (#0d1016 solid) | popups | Untouched solid popup, light ink. |
| Modals (`.bg-customizer` `shell.css:16-27`, `.episode-label-modal` `modals.css:1284-1295`, scene-viewer, clip-export, settings-confirm) | fixed overlays | Untouched solid. |
| `.window-chrome` `shell.css:498-510`, `.update-toast` `shell.css:543-562`, `.clip-export-pill` `modals.css:1782-1798` | fixed chrome | Untouched. |
| Dead theme.css selectors `.new-audio-card,.na-card,.na-panel` `theme.css:103-109` | no TSX usage anywhere | Delete or ignore. |

## 4. Per-page inventory

Pages from `App.tsx` nav (`RAIL_ENTRIES` `App.tsx:86-113`, panel switch `App.tsx:633-668`): home, audio-extraction (Vocal Separation), clip-hunting (Scene Splitter), bg-removal, audio-conversion, video-conversion, downloader (anime + youtube tabs), tsukyio, settings, logs, plus gates.

**Shell-level (all pages):** `.mode-switcher` (`App.tsx:596-632`, `shell.css:755-761`) is a bare pill row on wallpaper at the top of the focus panel — only rendered when a page has >1 tab (downloader, bg-removal). Inactive `.mode-tab` text `#c8d0d7` (`shell.css:763-777`) is unprotected on bright wallpapers. **Give `.mode-switcher` the material (small strip carrier) or halo its tabs.** `.canvas-grid` (`shell.css:728-737`) decorative — leave.

### Home — `HomePanel.tsx:82-114`, `home.css`
- Carrier: `.home-grid` (`home.css:42-49`) — single element behind all 8 cards (per-card = 8 backdrop elements, over budget). No JSX change.
- Bare text: `.home-hero-title/.home-hero-sub` (`home.css:26-40`) — stays bare; **add halo** (currently has none at all).
- Controls: `.home-card` keep 2.5% fills + hover accent.
- Hazards: page scrolls (`home.css:16` overflow-y) — carrier scrolls with content; fine (one element).

### Vocal Separation — `NewAudioExtractionPanel.tsx:330-437`, `new-audio.css`
- Carriers (3): `.dash-hero-card` (`:344`), `.dash-stage-main` (`:385` — becomes the carrier instead of its children so SelectFileButton/ExtractionProgressCard/ResultCard/StemMixerCard swap inside one surface), `.dash-stage-side` (`:390` — one carrier wrapping the 2-5 small side cards).
- Delete `new-audio.css:336-344` (strips these to transparent today) and the `dash-hero-card/dash-side-card` own `backdrop-filter` (`new-audio.css:65,223,309,319`) → replaced by material.
- Text saved by halos today: `.dash-hero-kicker/.dash-status-label/.dash-hero-desc/.dash-tip-text/.extract-hint` (base.css:216-242, :204) → all land inside carriers → retire.
- Hazards: `.stem-mixer` own blur `audio.css:499` must go (child of carrier `dash-stage-main`); waveform canvases (`StemMixerCard.tsx:234,251`, wavesurfer) render inside a carrier — fine. Drop-zone overlay blur(6) (`new-audio.css:19-35`) transient — leave.

### Audio Conversion — `MediaToAudioPanel.tsx:118-168`, `audio.css` §24
- Carriers (2): `.conversion-grid` (`audio.css:1050-1056` — currently zero background; source + run columns share it, divided by `run-card`'s border-left `audio.css:1073`) and `.conversion-format-card` in the hero (`MediaToAudioPanel.tsx:133` — the WAV/MP3 segment floats bare).
- Bare text kept: `.conversion-kicker` + `h2` + hero `p` (display text; keep base.css halos).
- Currently halo/white-dependent inside future carriers: `.conversion-card small/p`, segment labels → retire.

### Video Conversion — `VideoToVideoPanel.tsx:261-343`
- Same as audio conversion: carriers `.conversion-format-card.wide` (`:276` — compat note + presets + `VideoOutputControl`) and `.conversion-grid` (`:316`).
- `.video-output-control` keeps its own gradient fill as a control.

### Scene Splitter — `ClipExtractorPanel.tsx:1611-2050`, `clips.css`
- Carrier (1): `.clip-extractor-rail` (`clips.css:13-30`) — wraps import button, source card, tool stack, cols control, export dropdown, run card, format note, primary action.
- Stage `.clip-extractor-stage` (`clips.css:440-447`) stays **bare** — content is solid 16:9 video tiles.
- Floating HUDs untouched: `.merge-strip` (sticky, `ClipExtractorPanel.tsx:1992`), `.clip-jump-pill`.
- Hazards: **(i)** rail is a scroller (`clips.css:27` overflow-y) — carrier + scroll on the same element is one snapshot, fine; test scroll perf over video wallpaper. **(ii)** react-virtuoso virtualized grid (`ClipExtractorPanel.tsx:1879`, custom scroller `ClipPreviewScroller.tsx:25`) — do not put material anywhere inside the virtualized subtree. **(iii)** `.clip-corner-select` has `backdrop-filter: blur(4px)` **per tile** (`clips.css:629`) — up to ~20-30 live backdrop elements; see §7. **(iv)** Dropdown menu opens inside rail carrier — stays solid popup.

### Downloader / Anime tab — `DownloaderPanel.tsx:201-211`, `AnikaiBrowser.tsx:763+`
- Carrier (1): `.download-queue-panel` (`downloader.css:27-37`) — swap its 58% fill for material.
- Untouched solid islands: entire `.anikai-browser` column (provider-toolbar / webview frame / stream-capture-bar — all ≥96% solid; webview is an OS child window anyway). bright-ink already keep-lights it (`bright-ink.css:123-133`) — those exceptions stay until Phase 4.
- Hazard: the webview is a native child — material must never overlap it (it doesn't; queue panel is a sibling column).

### Downloader / YouTube tab — `YoutubeDownloaderPanel.tsx:200-296`, `downloader.css` §13, `audio.css` §35
- Carriers (≤4): `.youtube-download-card` (`:201`), `.youtube-format-list` (`:224` — bare scrolling button list today, this is its console), `.youtube-trim` (`YoutubeTrimEditor`, `audio.css:1251`), `.download-history-panel` (`:281`).
- `.youtube-actions` row (`:272`) is one bare button — fold into the trim/download card region or accept halo; minor JSX grouping candidate.
- Bare-text-today: `.youtube-download-head small` (base.css:239) → inside carrier → retire.
- Hazards: format list + history are scrollers; trim editor embeds a video stage (`audio.css:1324-1342`) — solid stage inside carrier is fine. Plus queue panel carrier = total ~5 visible. OK.

### Tsukyio Vault — `TsukyioPanel.tsx:789-1255`, `tsukyio.css`
- Connect state: carrier = `.tsukyio-connect-card.glass` (`:802`).
- Browse state carriers (3): **(i)** new console wrapping `.tsukyio-toolbar` + `.tsukyio-categories` + `.tsukyio-breadcrumb` + `.tsukyio-results-meta` (`TsukyioPanel.tsx:853-916`) — these controls float fully bare today (JSX edit, e.g. `.tsukyio-console`); **(ii)** `.tsukyio-grid-scroll` / `.tsukyio-results-col` (`:934,943`) — one carrier behind home tiles, sections, grid cards, pagination (per-card is dozens of elements — forbidden); **(iii)** `.tsukyio-dock` (`tsukyio.css:590-600`).
- Bare text kept: `.tsukyio-kicker` + header h2 (`:839-849`) — keep base.css:225 white+halo.
- Retire once inside carriers: `.tsukyio-home-head p`, `.tsukyio-tile-count`, `.tsukyio-card-sub`, cat-chip white (base.css:236-250).
- Hazards: grid scroller = carrier element (test scroll over video wallpaper); `.tsukyio-player-stage` solid `#000` (`tsukyio.css:679-694`) inside dock carrier — solid island, fine; bright-ink keep-light for the stage (`bright-ink.css:124`) becomes redundant later.

### BG Remover — `BgRemovePanel.tsx:512-909` (×2 mounted instances, `App.tsx:646-647`)
- THE structural page. Right form column `.conversion-card.run-card` (`:715`) has **no surface at all** — `conversion-field-label`s, two Dropdowns, GPU/CPU segment, action buttons float bare. Left column is an anonymous inline-styled `<div>` (`:538`).
- Carriers (2 per instance, only one visible): right `.conversion-card.run-card`, left column — **JSX edit:** give `:538`'s div a class (e.g. `bgremove-col`) and drop the inline style.
- Controls inside: the inline `.glass` cards (`:550,570,607,669`), `PreviewComparisonCard` (`:1172`), `VideoComparisonCard`, `BgRemoveResultCard`, `BgRemoveProgressCard` — keep fills, kill their `.glass` blur via the guard.
- Bare text kept: hero (`:524-534`).
- Hazards: hidden duplicate instance is `display:none` (`:510`) — no extra backdrop cost; comparison cards contain images/canvas — fine inside carrier; Dropdown popups stay solid.

### Logs — `LogsPanel.tsx:285-430`
- Carriers (2): a console wrapping `.logs-stats` + `.logs-toolbar` + `.logs-filters` + `.logs-results-info` (`:287-383` — toolbar/search float bare today; JSX wrap, e.g. `.logs-console`), and `.terminal-log` (`components.css:296-311` — replace 55% fill with material).
- Hazards: terminal-log is a large scroller with frequent reflow (live log lines) — carrier on the scroller is still one snapshot; verify with video wallpaper while logs stream.

### Settings — `SettingsPanel.tsx:254-344`
- **Leave the accepted treatment.** `.settings-tab-bar.glass`/`.settings-group.glass` keep their scrim (`modals.css:133-140`); optionally swap scrim → material for visual consistency (then base.css:199-203 halos and bright-ink.css:175-203 opt-out shrink). `.settings-toolbar` text stays bare → keep its halo (base.css:199).
- `CustomColorPicker` popover (`CustomColorPicker.tsx:267+`, inline-styled solid) and confirm modal — untouched.

### Gates / wizard
`.startup-gate` (`Root.tsx:159-269`, `components.css:506-515`), `SetupWizard` (`SetupWizard.tsx:116`, `modals.css:890-901`), `ToolsGate` — fixed full-screen on `#020203`. **Untouched.**

## 5. Nesting hazards — de-nesting decision list

| Nesting | Decision (who carries) |
|---|---|
| `.focus-panel.glass` ⊃ everything | Focus panel **opts out** (transparent, no filter). This single decision resolves most nesting. |
| `.focus-panel.glass` ⊃ `.tsukyio-connect-card.glass` (nested filters **today**) | Connect card carries. |
| `.clip-extractor-rail` (carrier) ⊃ `.clip-import-button.glass`, `.clip-source-card.glass`, `.clip-run-card.glass` | Rail carries; `.glass` children de-blurred by guard rule. |
| `.dash-stage-main` (carrier) ⊃ `.stem-mixer` (own blur `audio.css:499`) | Stage carries; remove stem-mixer blur (also in deleted base.css:263). |
| `.dash-stage-side` (carrier) ⊃ `.dash-side-card` (own blur `new-audio.css:223`) | Side column carries; remove card blur. |
| bgremove columns (carriers) ⊃ inline `.glass` cards | Columns carry; guard de-blurs cards. |
| `.tsukyio-results-col` (carrier) + `.tsukyio-dock` | Dock is a **sibling** (`tsukyio.css:568-600`) — both carry, no nesting. Cards/tiles inside column keep `var(--glass)` fills, no filter (they never had one). |
| `.settings-group.glass` ⊃ nothing glassy | No conflict; settings stays scrimmed. |
| Carriers ⊃ `.drop-zone-overlay` (blur 6, `components.css:790-815`) | Overlay only paints during drag; acceptable transient nesting — or drop its blur. Low stakes. |
| `.clip-extractor-stage` (no material) ⊃ merge-strip/jump-pill/corner-selects (own blurs) | Stage carries nothing → not nested; fine. |

## 6. bright-ink.css conflict map

Active under `html.bright-ink` (`App.tsx:267`, toggle in `BackgroundCustomizer.tsx:885-892`). With material guaranteeing dark backdrops inside carriers, dark ink becomes unreadable exactly where the sweeps currently hit hardest:

- **Sweeps that will hit inside-material text (conflict):** `bright-ink.css:23-31` (var flip on `.workspace`), `:50-64` (headings/p/small/bare spans), `:71-93` (class-substring sweeps), `:106-116` (ghost buttons, conversion-pick-btn/segments). Nearly all matched elements end up inside carriers after Phases 1-2.
- **Sweeps still valid for bare-on-wallpaper text:** the same selectors *as scoped to* heroes (`.conversion-hero`, `.home-hero`, tsukyio header, `.mode-switcher`, `.settings-toolbar`) and `.canvas-grid` flip (`:41-45`).
- **Keep-light exceptions that become redundant** once the flip is rescoped: `:123-133` (anikai/stream/stages), `:143-152` (dropdown menus), `:157-166` (install-btn/settings pills), `:175-203` (entire settings opt-out incl. the toolbar chip hack `:199-203`). The text-shadow killer `:36-38` shrinks to the bare-text scope.

**Recommended end-state:** the toggle becomes **wallpaper-bare-text-only**. Rewrite bright-ink.css to flip only: hero kickers/titles/subtitles (`.conversion-hero`, `.home-hero`, `.tsukyio-header`, `.settings-toolbar`), inactive `.mode-tab`s, and `.canvas-grid`. Everything else (now inside material) keeps light ink unconditionally, so all keep-light exception blocks are deleted. No auto-ink mode for now — the toggle's UI (`shell.css:284-343`, bright-suggest banner `shell.css:347-405`) stays as-is, its blast radius just shrinks. If after visual QA bare heroes read fine with halos on white wallpapers, the toggle could be fully retired later — product decision, don't bundle it.

## 7. Every existing `backdrop-filter` in src/styles

| Location | Element | Disposition |
|---|---|---|
| `base.css:114-115` | `.glass` blur(12) | Becomes inert under has-app-bg (guard + coupling removal); unchanged without wallpaper. |
| `base.css:121-122` | `.glass-strong` blur(16) | Dead class (no TSX usage) — leave or delete. |
| `base.css:264-265` | has-app-bg coupling blur(var(--app-bg-blur)) | **Delete** (§2c). |
| `shell.css:13-14` | `.bg-customizer-backdrop` blur(6) | Fixed modal backdrop — leave. |
| `modals.css:1276-1277` | `.episode-label-backdrop` blur(6) (shared by scene-viewer/clip-export/settings-confirm) | Leave. |
| `modals.css:1795-1796` | `.clip-export-pill` blur(10) | Floating HUD — leave. |
| `components.css:802-803` | `.drop-zone-overlay` blur(6) | Transient drag overlay — leave. |
| `new-audio.css:65,223,309,319` | dash hero/side/stage wrappers blur(10-12) | **Replace** with material on carriers (delete originals). |
| `new-audio.css:343` | has-app-bg `backdrop-filter:none` strip | Delete with its block. |
| `audio.css:499` | `.stem-mixer` blur(10) | **Remove** (nested in carrier). |
| `clips.css:503-504` | `.clip-jump-pill` blur(12) saturate(140%) | Floating HUD — leave. |
| `clips.css:629` | `.clip-corner-select` blur(4) — **per-tile, the one real perf violator** (≈20-30 live snapshots on a 4-col grid) | **Remove blur**; bump fill from `rgba(15,20,24,0.55)` to ~0.78 — it sits over video thumbs, not wallpaper. |
| `clips.css:713` | `.merge-strip` blur(10) | Leave. |

**Post-change per-page material-element estimate** (sidebar +1 everywhere; mode-switcher +1 on tabbed pages): Home 2 · Vocal sep 4 · Audio conv 3 · Video conv 3 · Clips 2 (+2 transient HUDs) · Downloader-anime 3 · Downloader-youtube ~6 steady-state 5 (**watch this page**) · Tsukyio 4-5 · BG remove 4 · Logs 3 · Settings 5-6 if scrim→material swap is done (otherwise 1). No page exceeds ~6-8 visible.

## 8. Tokens & theme.css interactions

- Base tokens: `base.css:58-64`; theme overrides: `theme.css:16-35`. `--panel/--panel-strong` are used only by gates (`components.css:527,590,701`) — don't repurpose them.
- Inline accent system (`theme.ts:57-63`) writes `--theme-accent-*` inline on `:root` — material tokens must use fresh names.
- **Proposed token set** (defined in `material.css`, theme layer, on `:root`): `--material-blur: 20px` (fixed; never reads `--app-bg-blur`), `--material-tint: rgba(10,12,24,0.30)`, `--material-brightness: 0.55`, `--material-saturate: 1.4`, `--material-edge` (see §1).
- No `has-app-bg` token overrides needed — the rules themselves are gated on `:root.has-app-bg`; without wallpaper, carriers keep their existing theme fills untouched.

## 9. TSX touchpoints

| File | Change |
|---|---|
| `src/shell/App.tsx:268-272` | Delete the `--app-bg-blur` root-style writer (consumers removed). Keep `has-app-bg`/`bright-ink` toggles (`:264-267`). |
| `src/shell/App.tsx:595-632` | Optionally add carrier class to `.mode-switcher` (or pure CSS). |
| `src/features/bgremove/BgRemovePanel.tsx:538` | Replace anonymous inline-styled left-column `<div>` with a classed column (`bgremove-col`) — carrier. |
| `src/features/tsukyio/TsukyioPanel.tsx:853-916` | Wrap toolbar + categories + breadcrumb + results-meta in one `.tsukyio-console` carrier div. |
| `src/features/logs/LogsPanel.tsx:287-383` | Wrap stats/toolbar/filters/results-info in `.logs-console` carrier div. |
| `src/features/downloader/YoutubeDownloaderPanel.tsx:272-279` | Fold the bare `.youtube-actions` row into a carried region. |
| `src/features/home/HomePanel.tsx` | None (carrier on existing `.home-grid`); hero halo is CSS. |
| `src/features/settings/BackgroundLayer.tsx` | **None** — slider semantics unchanged. |
| `src/features/settings/BackgroundCustomizer.tsx` | None in Phases 1-2. Phase 4: update toggle copy (`:34, :885-918`) to describe "dark headline text" only. |

## 10. Ordered implementation plan

**Phase 0 — prep (no behavior change).** Create `src/styles/material.css`; add import to `src/styles.css` (theme layer). Tokens + `.u-material` + nesting guard. Risk: none.

**Phase 1 — core decoupling.** Delete `base.css:258-266`; delete `App.tsx:268-272` writer; sidebar becomes carrier (replace `base.css:181-183` body); remove `clips.css:629` corner-select blur + bump its fill; mode-switcher carrier/halo. Files: base.css, clips.css, material.css, App.tsx. Risk: low-medium (every page's blur behavior changes at once). Verify: bright/white wallpaper at blur=0 and blur=max — sidebar reads, wallpaper sharpness in gaps tracks only the slider; video wallpaper — no FPS regression.

**Phase 2 — per-page console grouping, severity order:**
1. **BG remover**: BgRemovePanel.tsx col class + material on `.run-card`/`bgremove-col`; guard de-blurs inner `.glass`.
2. **Audio + video conversion**: material on `.conversion-grid` + `.conversion-format-card`.
3. **Vocal separation**: delete `new-audio.css:336-344` and own blurs (`:65,223,309,319`, `audio.css:499`); material on hero/stage-main/stage-side.
4. **Tsukyio**: console wrap (TsukyioPanel.tsx) + material on results column, dock, connect card.
5. **YouTube tab**: material on download card / format list / trim / history; fold actions row.
6. **Logs**: console wrap + terminal material.
7. **Clips**: material on `.clip-extractor-rail`.
8. **Downloader queue**: material on `.download-queue-panel`.
9. **Home**: material on `.home-grid`; hero halo.
Each step independently shippable; risk per step: low. Verify each page on bright, dark, and video wallpapers; count live backdrop elements ≤8.

**Phase 3 — halo & forced-white retirement.** Prune `base.css:199-250` down to the keep list (§2b); delete dead selectors (`setting-row-label`, `setting-row-description`, `settings-section-label`, `audio-status-line`). Add `.home-hero-*` halo. Risk: low; regressions visible immediately on a white-wallpaper sweep of every page.

**Phase 4 — bright-ink rescope.** Rewrite `bright-ink.css` to the bare-text-only scope (§6); delete keep-light exception blocks and the settings opt-out; update BackgroundCustomizer toggle copy. Risk: medium (user-visible toggle semantics) — verify both toggle states on white + dark + video wallpapers across all pages, especially Settings (must look unchanged) and dropdown popups (must stay light-ink solid).

**Verification recipe (all phases):** Test matrix: pure-white image, busy bright anime image, near-black image, looping video; blur slider at 0 and max; dim 0; Dark-text toggle on/off. Live UI check: CDP + fresh WebView2 profile (see project memory). Performance gate: video wallpaper + Scene Splitter grid playing previews + rail material — no dropped frames vs. main.

**Taste compliance:** no full-viewport slabs (focus-panel stays transparent; carriers are page regions with sharp wallpaper in gaps); Settings accepted treatment preserved; solid popups/dropdowns/modals keep light ink; compact controls untouched (material is carrier-level only).
