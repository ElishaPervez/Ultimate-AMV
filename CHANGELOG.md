# Changelog

All notable changes to Ultimate AMV are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.13.0] : 2026-06-15

### Added
- Integrated the Tsukyio asset vault. Browse, preview, and pull editing assets straight into your project.
- Background remover. Automatically cut characters out of videos and images with a clean transparent background.
- Featherlight previews for lighter, faster scene previews.

### Changed
- Significantly improved GUI, with a new home screen, grouped sidebar, custom color picker, and better readability over wallpapers.
- Faster, more reliable clip extraction, merging, and previews.
- Smarter downloads, with real quality labels and a steady speed readout.

### Fixed
- Fixed first-time setup so the app installs and launches reliably for everyone.

## [0.12.0] : 2026-05-22

### Added
- **AnimeSuge replaces AniKai as the default downloader provider.**
  AniKai's servers shut down so the provider was retired. AnimeSuge
  (`https://animesuge.cz`) takes its place with full identity
  detection: the URL extractor reads `/anime/<slug>/ep-N` and the
  HTML `<title>` parser splits on the LAST occurrence of "episode"
  so titles that themselves contain the word still parse correctly.
- **Per-site Referer detection for the Custom URL downloader.** The
  in-app browser now sniffs the player iframe's origin (paths with
  `/stream/`, `/embed/`, `/player/`, `/play/`, `/watch/` on a non-page,
  non-telemetry host) and attaches it to the captured stream so yt-dlp
  passes the CDN's hot-link check. Fixes the 403 Forbidden wall that
  was hitting mewstream, megaplay, and other CDNs.
- **yt-dlp impersonation on the anime path.** Anime-flow yt-dlp calls
  (stream inspection + download) now pass `--impersonate
  Chrome-116:Windows-10` so they clear Cloudflare's anti-bot wall.
  The YouTube path is unchanged.
- **Confirm-download modal opens on every Download click.** Detected
  anime title, episode number, and save directory are pre-filled and
  editable. Previously the modal only opened when detection missed;
  now you get to review or correct the values for every download. The
  default save path is always shown so it's clear where the file will
  land if you don't pick a custom folder.
- **Pre-flight legibility warning in the background customizer.** When
  you open the Customize background modal, a red banner appears at the
  top reading "Bright wallpapers can wash out fine text and buttons.
  If the UI gets hard to read, raise the Dim slider, add some Blur,
  or pick a darker image." The text types in over ~5 seconds; on the
  right, a lock pill counts down 10s → 1s and then morphs into an
  enabled checkmark you click to dismiss. Controls under the warning
  are dimmed and locked until you acknowledge it.
- **Clip select controls.** PR #6 from moongetsu landed real
  keyboard/mouse selection: ctrl+click toggles a clip's selection.
  The earlier double-click-to-select trigger and 250 ms click delay
  were removed, so the grid feels immediate. Selected clips off
  screen get a Jump pill that scrolls them into view, and hover
  autoplayers stop running when the tile leaves the viewport so a
  long episode no longer spins the CPU on previews you can't see.
- **Content-fingerprint scene cache.** The clip extractor's scene
  cache is now keyed by a content fingerprint instead of the file
  path, so renaming or moving a video keeps the cached scene cuts
  intact instead of forcing a re-scan.
- **Discord invite button** in Settings → Theme & Social.
- **Themed FPS Dropdown** in the background customizer's Live
  wallpaper tab, replacing the native `<select>` so the picker
  matches the rest of the app's UI instead of looking like a debug
  element.
- **Diagnostic firehose log** (`browser.media.request.full`) records
  every WebView2 request seen by the sniffer. The log is written on
  a background thread with a 5000-URL dedup set so the WebView2
  callback never blocks on disk I/O. Used for site-specific debugging
  on Custom URL downloads.

### Changed
- **Background customizer zoom/pan rewritten to use CSS translate.**
  Big images pan smoothly instead of jittering as the browser
  reflowed `background-position`. Action-bar buttons (Replace,
  Remove, Reset, Cancel, Apply) were also made uniform in size and
  style.
- **Conversion panel layout tightened.** The action info (kicker +
  description) was merged into the source card, and the run card on
  the right shrunk to just its title block and the Start/Cancel
  button so the layout doesn't feel front-heavy.
- **Sniffer media-kind detection tightened.** A telemetry-host
  blocklist (`jwpltx.com`, `googletagmanager.com`, etc.) plus a
  static-asset extension filter (`.gif`, `.css`, `.js`, with
  `.html`/`.htm` exempted as embed documents) means JWPlayer
  `ping.gif` pings whose URLs embed `.m3u8` in a query parameter no
  longer leak through as fake "Captured playback stream" candidates.
  This was the bug that started the whole investigation.
- **Default wallpaper Blur is now 5px.** Out of the box a freshly
  applied wallpaper looks softer and is easier to read text on,
  without dimming.
- **Muted labels get a text-shadow halo under `has-app-bg`.** Section
  kickers, breadcrumbs, helper copy, and other low-contrast text get
  a subtle dark drop-shadow when a wallpaper is active. Invisible on
  dark wallpapers; rescues legibility on bright ones with no impact
  on layout.

### Fixed
- **Clip extractor click feedback feels snappy** instead of laggy
  thanks to the removed 250 ms click delay (see Added above).
- **AnimeSuge URLs detect the anime title** instead of returning
  the literal word "Anime". `inferAnikaiTitle` now recognises both
  `/watch/` (AniKai/AniWaves) and `/anime/` (AnimeSuge) URL
  segments and rejects generic keyword fallbacks like "anime",
  "watch", "browse", "search", "home".
- **AnimeSuge identity requests scoped correctly.**
  `is_anikai_identity_request` now requires BOTH `/anime/` and
  (`/ep-` or `/ep/`) for AnimeSuge URLs, so unrelated requests with
  `/ep-` in the path don't get misclassified as identity probes.

### Removed
- **AniKai default preset.** Servers shut down; replaced by
  AnimeSuge (see Added above).
- **Per-widget scrim layers** behind downloader mode tabs, queue
  panel, clip extractor rail, settings cards, and conversion cards
  (the three commits 694e1e2, 5ff8fe7, 7901397). They solved
  legibility on bright wallpapers at the cost of covering the
  wallpaper itself. Replaced by the pre-flight legibility warning
  (see Added) plus the existing text-shadow halo, which keep the
  wallpaper visible and let the user decide how much Dim/Blur to
  apply.
- **Forced Dim=10 / Blur=5 slider floors** and the mid-cycle
  auto-luminance recommendation. Both were experimented with and
  reverted; the only floor left is the new Blur default of 5px,
  which the user can still drag to 0.

## [0.11.0] : 2026-05-20

### Added
- **Live wallpaper.** Background customizer in Settings can now
  take a video file (mp4 / webm / mkv) instead of just an image,
  and the app will loop it as the desktop wallpaper layer behind
  every panel. The video is muted, plays at low priority, and
  pauses when the app window is minimized so it does not chew
  battery in the background.
- **Hover-to-play clip previews.** Hovering a clip tile in the
  Clip Hunting grid now plays the scene's audio-less preview
  inline without opening the modal, so you can scan a long
  episode without clicking each tile. Off by default : opt in
  from Settings → Clip Hunting. Setting persists across restarts.
- **Settings tabs.** The Settings panel got reorganized into
  per-feature tabs (Appearance, Background, Clip Hunting, Vocal
  Extraction, Downloader, Discord, Updates) so it stops being a
  single scrolling page. A single Save button at the bottom
  commits every change at once : no per-section saves, no
  immediate-save toggles.
- **Confirmation modals for destructive actions.** Clearing the
  clip preview cache, wiping the download history, and the new
  "wipe everything" full-cache reset all prompt for confirmation
  before running, with a one-line summary of what is about to be
  deleted.
- **Logs tab rebuild.** The Logs page now has a stats bar at the
  top with counts for Info / Warn / Error (click any of them to
  filter), a search bar, a category dropdown (clip, audio,
  downloader, etc.), and an Export button that opens a native
  Save As dialog and writes the currently-filtered lines to a
  .txt file with an auto-generated filename like
  `[Ultimate AMV] Error Logs (2026-05-20 19-20-15).txt`.
  Individual log lines with details are collapsible.
- **Floating pill for export progress.** The clip export modal
  can now minimize to a small floating pill in the corner of the
  window so the app stays usable while a long export runs.
  Clicking the pill restores the full modal.
- **AniWaves provider + Custom URL option.** The anime browser
  provider selector got reworked into a styled dropdown with
  AniWaves as an additional source and a "Custom URL" entry that
  unlocks the address bar so you can point it at an arbitrary
  site.
- **Custom dropdown component** used by the new anime provider
  selector, the Settings selectors, and the new Logs category
  filter. Keyboard navigation, search inside the menu, and
  accessibility roles match the rest of the app.

### Changed
- **Scene preview modal opens in ~500ms instead of 5 to 10
  seconds.** Three stacked changes : ffmpeg now seeks with a
  coarse pre-input `-ss` (keyframe jump) plus a precise
  post-input `-ss` (frame-accurate cut), instead of walking the
  whole file from t=0; ffmpeg gets warmed up on app launch so
  the first click of every session no longer pays a 1 to 2
  second cold-start tax; and the animated WebP thumbnail is
  shown as a darkened poster behind the spinner while the mp4
  renders, so the click feels instant even on slow paths.
- **Custom app-wide scrollbar.** Replaces the default Windows
  scrollbar that used to bleed through the dark theme. Matches
  the accent color and tucks out of the way when not hovered.
- **Mode-switcher auto-collapses with a single tab.** Tools that
  only have one mode (no CPU/GPU switcher, no second tab) no
  longer render an empty tab strip above the panel.
- **CSS split into per-feature files.** The 6800-line
  `styles.css` was broken up into eight files (base, shell,
  components, modals, audio, clips, downloader, anime) which
  cuts dev-tool load time and stops large diffs from touching
  unrelated styling.
- **Rust backend split into per-feature modules.** `lib.rs` was
  decomposed into `clips.rs`, `downloads.rs`, `preview.rs`,
  `video_cmds.rs`, `tools.rs`, etc. No user-visible behavior
  change : same commands, same logs, just easier to navigate
  and fewer merge conflicts when multiple changes land at once.

### Fixed
- **Non-ASCII filenames no longer crash the Python backend.**
  Files with Japanese characters, full-width brackets `【】`,
  curly quotes, em-dashes in titles, and similar would crash
  clip extraction and audio extraction with `UnicodeDecodeError`
  on Windows. The Rust shell now sets `PYTHONUTF8=1` and
  `PYTHONIOENCODING=utf-8` on every Python sidecar it spawns,
  and `audio_cli.py` / `clip_cli.py` reconfigure stdin/stdout/
  stderr to UTF-8 at startup as a belt-and-suspenders.
- **Hover-to-play preview defaults to off.** The first build
  that shipped hover-to-play had it on by default and the
  scrubbing motion across a grid of clips was distracting on
  long episodes. New default is off; existing users with it
  explicitly enabled keep their setting.
- **Cancel flow shows a clearer message.** Cancelling a clip
  extraction mid-run used to leave the panel sitting on
  "Working..." with no acknowledgement that anything happened.
  It now shows "Cancelled : N clips kept" so you know the
  partial results are preserved.
- **Static clip thumbnails as an alternative.** The animated
  WebP grid is great for skimming but expensive to render on
  long episodes; a Settings toggle now switches the grid to
  static first-frame thumbnails for lower CPU on weak machines.
- **Full cache wipe.** A new "Clear all caches" button in
  Settings → Updates wipes scene clip cache, WebP previews, and
  yt-dlp download fragments in one shot, for when partial
  clears do not get a system back to a clean state.
- **Thumbnail layering during transitions.** Clip thumbnails
  briefly stacked on top of each other while the grid
  re-rendered after a filter change; they now cross-fade
  cleanly.

[0.13.0]: https://github.com/ElishaPervez/Ultimate-AMV/releases/tag/v0.13.0
[0.12.0]: https://github.com/ElishaPervez/Ultimate-AMV/releases/tag/v0.12.0
[0.11.0]: https://github.com/ElishaPervez/Ultimate-AMV/releases/tag/v0.11.0

## [0.10.0] : 2026-05-19

### Added
- **Scene preview viewer.** Click any clip tile in Clip Hunting to
  open a full-size player for that scene with audio. The viewer
  uses a custom playback bar that matches the app theme : play /
  pause from the on-screen button or with the spacebar, draggable
  scrub bar with a hover-grow effect, mute toggle, and fullscreen.
  Playback loops automatically so you can watch a clip on repeat
  while deciding to keep it. Mute preference persists across clips
  and across app restarts : if you mute one scene the next opens
  muted, and unmuting one opens the next unmuted.

### Changed
- **Scene viewer renders previews at 720p with the fastest available
  encoder.** First-view latency on CPU mode dropped from ~3 s to
  ~1-1.5 s for a 3-second clip. NVENC users get the same speed boost
  via `h264_nvenc -preset p1`; libx264 `-preset ultrafast` is the
  software fallback. Subsequent views of the same scene are instant
  (cached).
- **Universal hardware-accelerated decode for the scene viewer.**
  Uses `-hwaccel auto` so any GPU vendor (NVIDIA, Intel, AMD) gets
  hardware decode without being explicitly selected, with a clean
  software fallback on machines without a usable decoder. Cuts
  500-1000 ms off HEVC source render times without being
  NVIDIA-gated.

### Fixed
- **Scene viewer no longer shows the previous scene's last frames
  at the start of a clip.** Two stacked causes : the scene
  detector's boundary timestamp lands on the *last* frame of the
  previous scene rather than the first frame of the new one (the
  viewer now uses the same inward-padded range the WebP grid
  already uses), and ffmpeg's input-side seek was including
  B-frames between the nearest keyframe and the cut point (the
  slice render now uses output-side `-ss` plus
  `-avoid_negative_ts make_zero` to drop them at both the decoder
  and the muxer).
- **WebP grid previews and progress bars no longer drift apart
  after you close the scene viewer.** They used to run
  independently in the background the whole time the modal was
  open and would show desynced on close. Now they pause while the
  modal is up and re-key together on close, matching the existing
  tab-switch reset behavior.

[0.10.0]: https://github.com/ElishaPervez/Ultimate-AMV/releases/tag/v0.10.0

## [0.9.0] : 2026-05-18

### Added
- **Stem mixer preview.** After vocal extraction, the giant
  "Extraction complete" placeholder is replaced with a live stem
  player. Two stacked waveforms (Music in green, Vocal in purple)
  share a single transport with play/pause, click-to-seek, and
  drag-to-scrub. Two horizontal volume sliders let you blend the
  stems in real time : both at 100 recreates the original mix,
  Vocal at 0 gives the pure instrumental, Music at 0 gives the
  pure vocals. Spacebar toggles play/pause anywhere on the panel.
  The per-file success line still lives at the bottom as the
  status indicator.
- **Selectable WAV / MP3 output for vocal extraction.** Settings
  → Vocal Extraction has a new "Stem output format" selector.
  WAV (the default) is lossless; MP3 is roughly one-tenth the
  size for casual previews.

### Fixed
- **Vocal stems use the correct audio extension.** Extracting
  from a video file (e.g. `.mp4`, `.mkv`) used to write stems
  with the input's container extension even though the bytes
  inside were WAV : `song [vocals].mp4` containing WAV data,
  which broke some players and confused anything that trusted
  the extension. Stems now carry the actual audio format
  (`.wav` or `.mp3` depending on the new output-format setting).
  The "(original)" backup of the source file keeps the source's
  own extension as before.

[0.9.0]: https://github.com/ElishaPervez/Ultimate-AMV/releases/tag/v0.9.0

## [0.8.0] : 2026-05-16

### Added
- **Discord Rich Presence.** Optional integration that displays
  "Playing Ultimate AMV" on your Discord profile, along with the
  current panel (Clip Hunting, Downloader, Vocal Extraction, etc.)
  and any running job (Extracting clips, Converting clips, Vocal
  separation, Downloading). Toggle it on/off from
  Settings → Discord Rich Presence. Requires the Discord desktop
  app to be running; the integration is silent when Discord is
  closed.
- **Settings toggle switch.** The Discord toggle is a real
  iOS-style switch with a sliding knob, an accent gradient track,
  and a smooth spring animation : not a bare button labeled
  "Disabled / Click to enable".

### Changed
- **Polished Settings action buttons.** "Choose background" and
  "Clear cache" are now proper pill-shaped controls with subtle
  hover lift, accent glow, and (for "Clear cache") a rose-tinted
  danger state to signal the destructive action. The flat
  underline style they had previously made them look like floating
  text rather than buttons. When a background image is set, the
  pill shows a wider thumbnail of the current image in place of
  the icon.

### Fixed
- **Theme color state survives panel unmount.** Picking a new
  gradient color no longer reverts to the on-disk value when you
  navigate away from Settings and back. Theme state is now owned
  by the shell so a still-in-flight `set_config` write can't race
  the Settings panel's refresh.
- **Installed-mode drift auto-heals on read.** If the stored
  config's `setup_type` / `force_cpu` / `clip_extraction_mode`
  drift from the actually-installed torch wheel (e.g. a crashed
  install left "CPU configured" on top of a +cu wheel), the
  backend silently rewrites the config to match on next
  `show_config()`. The Settings UI no longer shows
  "GPU installed : CPU configured" and the downloader's
  post-download clip-server warmup uses the right mode.

[0.8.0]: https://github.com/ElishaPervez/Ultimate-AMV/releases/tag/v0.8.0

## [0.7.4] : 2026-05-16

### Changed
- Throwaway version to validate the 0.7.3 startup toast in action.

[0.7.4]: https://github.com/ElishaPervez/Ultimate-AMV/releases/tag/v0.7.4

## [0.7.3] : 2026-05-16

### Added
- **Startup update check + top-right toast.** The app now silently pings
  the release feed on every launch. If a newer version is available, a
  small toast appears in the top-right corner with the new version and
  a single "Download and install" button. Dismiss the toast or click
  the button to download, install, and auto-restart in one go. Nothing
  appears if the app is already on the latest version.

### Changed
- **Update card collapses to a single button.** "Download" and "Restart
  to apply update" merged into one "Download and install update"
  action. Click it once and the app downloads the new installer,
  silently applies it, and restarts on its own : no second prompt.

[0.7.3]: https://github.com/ElishaPervez/Ultimate-AMV/releases/tag/v0.7.3
[0.7.2]: https://github.com/ElishaPervez/Ultimate-AMV/releases/tag/v0.7.2

## [0.7.0] : 2026-05-16

### Added
- **Silent in-app auto-updater.** Settings now has an "App Updates" card
  at the top showing the current version and a "Check for updates"
  button that polls the GitHub release feed. When a newer version is
  found, the release notes are previewed inline and a single click
  downloads the new installer in the background : keep the app open and
  use it normally while it downloads. When ready, the button changes to
  "Restart to apply update": clicking it quits the app, runs the new
  installer silently (no wizard, no prompts), and relaunches the new
  version. The whole sequence takes 3–6 seconds of visible downtime
  with no user-installed packages disturbed (your GPU/CPU torch wheel,
  audio-separator, nelux, etc. all survive the additive overlay
  install). Releases are cryptographically signed with a minisign
  keypair; the updater verifies the signature before installing, so a
  tampered or substituted installer is rejected. The CI workflow is
  the only thing with the private key.
- **First-launch tools-download gate.** Replaces the old approach of
  bundling FFmpeg / ffprobe / yt-dlp / the shared FFmpeg DLLs nelux
  needs inside the installer. On first launch a "Setting up media
  tools" gate downloads them (about 200 MB total) into a per-user
  cache at `%LOCALAPPDATA%\com.elishapervez.ultimateamv\tools\` and
  verifies every binary against a pinned SHA256 from `tools.json`.
  This is a one-time cost : subsequent auto-updates only ship the app
  code and apply in seconds. The cache lives outside the install
  directory, so reinstalls and uninstalls don't disturb it.
- **`tools_status`, `tools_install`, `tools_cancel` Tauri commands**
  for the new gate. `tools-progress` events stream per-binary
  download + verify + install state with byte-level granularity.
- **`ULTIMATE_AMV_TOOLS_DIR` environment variable** is set on every
  Python sidecar spawn (audio bridge, clip bridge, clip server, and
  the nelux importability probe in `_nelux_importable()`).
  `clip_cli.py` and `audio_cli.py` consult it to locate
  ffmpeg/ffprobe/yt-dlp and to register the ffmpeg-shared DLL
  directory with `os.add_dll_directory` for nelux's C extension.
- **`prepare_for_update` Tauri command** runs before the updater's
  `install()` to kill Python sidecars synchronously (so they don't
  hold `_bz2.pyd` / `python.exe` open during the file replace) and
  to clear `KILL_ON_JOB_CLOSE` from the Windows Job Object (so the
  installer survives our exit instead of being killed alongside the
  main process).

### Changed
- **Installer is now ~30 MB instead of ~185 MB.** FFmpeg, ffprobe,
  yt-dlp, and the shared FFmpeg DLLs no longer ship inside the NSIS
  installer : see the tools-download gate above.
- **Tool versions are pinned in `tools.json` at the repo root.**
  Bumping a binary is a manifest change + matching SHA256 update.
  Current pins: yt-dlp 2026.03.17, FFmpeg static
  `autobuild-2026-05-15-13-34` (master, GPL), FFmpeg shared DLLs
  `autobuild-2026-05-15-13-34` (n8.1 branch : the avcodec-62 ABI
  nelux is built against).
- **CI no longer downloads FFmpeg / yt-dlp** during the release
  build. `.github/workflows/release.yml` drops three binary-fetch
  steps and ships `tools.json` as a Tauri resource, so the installer
  artifact is purely app code + Python runtime.
- **`core:app:default` capability granted** so the frontend can read
  the bundled app version at runtime.

[0.7.0]: https://github.com/ElishaPervez/Ultimate-AMV/releases/tag/v0.7.0

## [0.6.0] : 2026-05-16

### Added
- **Custom URL provider for anime downloads.** The provider dropdown in
  the Anime Download panel now has a third option, "Custom URL", that
  unlocks the address bar so you can point the built-in browser at any
  anime site : not just AniKai or AniWaves. Enter a URL and press Enter
  (or click Go) to load it. Host-restricted navigation is disabled in
  custom mode, so the page can navigate freely within whatever site
  you pointed it at. The stream sniffer still works the same : open an
  episode, hit play, and the captured stream lands in the queue.
- **Provider selection persists across sessions.** The selected
  provider (preset or custom URL) is saved to config and restored on
  next launch, so you don't have to reselect every time you open the
  app.

### Fixed
- **"Confirm episode" modal no longer hides behind the video player.**
  When the sniffer couldn't auto-detect the anime title or episode
  number (which is the default case on custom URLs and miruro-style
  sites), clicking Download would open a labeling modal that was
  completely invisible because the native child WebView rendered on
  top of the HTML overlay. The WebView now temporarily moves off-screen
  while the modal is open and snaps back in place when it closes.
- **Browser page no longer disappears after confirming the modal.** A
  follow-on regression where the WebView would stay parked off-screen
  after the modal dismissed : Tauri's child WebView needs a multi-attempt
  position/size sync plus a one-pixel resize nudge to reliably redraw
  after being moved. The lifecycle effect now fires that exact sequence
  on modal close, so the page restores the moment you confirm the
  episode.

## [0.5.0] : 2026-05-14

### Added
- **Unsupported-codec auto-convert for the GPU clip extractor.** Dropping a
  video that uses a codec the GPU path can't decode (most commonly
  ProRes / DNxHR / DNxHD inside `.mov`, or VP9 in unusual containers) now
  surfaces a friendly modal instead of silently freezing. One click on
  "Convert to compatible format" transcodes the source to H.264 mp4
  (CRF 20, AAC audio) into a per-app cache directory, then re-runs the
  extraction on the converted copy automatically. The original file is
  never touched. A small "Using converted copy of <name>" badge appears
  on the source card so the substitution is visible, and the cached copy
  is keyed by source path + size + mtime so re-extracting the same file
  is instant on subsequent runs.
- **"Stuck? Convert to compatible format" escape hatch** under the
  Cancel button during extraction, for the rare case a hang slips past
  the preflight check. Kills the running job and opens the convert
  modal pre-loaded with the active file.

### Fixed
- **GPU clip extraction no longer hangs forever on unsupported codecs.**
  The clip extractor's GPU path calls `nelux.VideoReader(...,
  decode_accelerator="nvdec")`, which only supports H.264 / HEVC / AV1
  in hardware. On anything else (ProRes, DNxHR, VP9, exotic MKV
  builds), nelux would hang inside native C++ code without ever raising
  a Python exception or emitting an error event : leaving the UI stuck
  at "Decoding at 8000+ FPS with Nelux Ultimate..." at 1% with no way
  to recover short of killing the app. The frontend now runs a
  ~50 ms ffprobe codec check before dispatching to the GPU path; if
  the codec isn't in the supported whitelist (sourced from
  `cuvid_decoder()` in `backend/clip_cli.py`), the convert modal opens
  immediately with the codec named in plain language. CPU mode skips
  this check entirely : PySceneDetect pipes through ffmpeg directly
  and handles every codec ffmpeg knows.
- **Cancel actually cancels GPU clip extractions now.** The previous
  `cancel_clip` only killed the one-shot child process; the persistent
  clip server (which runs nelux's native code) was a separate
  AsyncChild that the cancel never touched, so a hung server would
  stay hung and the next extraction would dispatch to the same wedged
  stdin. Cancel now stops both : the one-shot PID and the persistent
  `CLIP_SERVER` AsyncChild : and emits a synthetic `stopped` event so
  the warmup automatically respawns a fresh server for the next run.
  The Cancel button on the frontend also breaks out of the awaited
  `clip-server-event` listener via an abort ref, which previously
  waited indefinitely for a `done`/`error` event that never came after
  a cancel.

## [0.4.1] : 2026-05-14

### Fixed
- **Updates no longer fail with "Error opening file for writing" when
  the app is running.** Installing an update on top of a running copy
  used to leave orphaned Python sidecars (clip server, audio worker)
  holding `_bz2.pyd` / FFmpeg DLLs open, blocking the file copy. The
  main process now pins itself to a Windows Job Object with
  `KILL_ON_JOB_CLOSE` so sidecars die automatically the moment the
  main exe exits : for any reason, including the installer's hard
  terminate. A new NSIS pre-install hook also runs
  `taskkill /F /T` on the whole tree as a belt-and-suspenders pass.
  Result: closing the app first is no longer required to update.
- **"GPU Engine Needs Setup" modal no longer fires on every launch of
  a healthy install.** Three bugs combined to trip the repair gate
  even on working installs: the bundler was flattening
  `tools/ffmpeg-shared/` (where nelux's FFmpeg DLLs live) into
  `tools/`; the planner's nelux-importability probe spawned a fresh
  subprocess that did not re-add the FFmpeg directory to Windows' DLL
  search path; and the same probe did not `import torch` before
  `import nelux` (nelux 0.10+ raises `ImportError: PyTorch must be
  imported before Nelux.` otherwise). Reverted the bundler form to
  preserve directory structure, and the probe now mirrors the
  runtime's `os.add_dll_directory` + torch pre-import before the
  nelux import. The modal previously claimed "Missing DLLs
  (reinstall)" even though the DLLs were correct and Repair could
  never fix the underlying issue.
- **Clip extractor warmup no longer fails with the nelux FFmpeg DLL
  load error.** Same root cause as above : with the bundler fix in
  place, `tools/ffmpeg-shared/*.dll` end up at the path nelux expects.
- **Engine Repair never leaves the install worse than it found it on
  network failure.** Torch is now swapped via a single
  `pip install --upgrade --force-reinstall` which downloads the
  replacement wheel before removing the existing one. Previously a
  failed download mid-Repair would leave the user with no torch at
  all and Settings reporting packages as "missing".
- **Clip extractor no longer breaks audio extraction on first launch in
  CPU mode.** The clip server's warmup used to run its own dependency
  reinstall in the background; if it raced with another tool's pip
  call (or got killed mid-uninstall by a setup flow), the install
  ended up with mismatched torch/torchvision wheels and a cryptic
  `operator torchvision::nms does not exist` error from the next
  separation. The auto-repair on warmup is gone : dependencies are
  installed once during the setup wizard / Repair, and the clip
  server now trusts that they're correct.
- **Clip preview progress bar no longer drifts out of sync with the
  looping clip.** The bar's CSS animation duration is now sourced from
  the actual sum of per-frame delays encoded into the WebP (parsed
  from its ANMF chunks), rather than the requested clip duration.
  ffmpeg truncates per-frame delays to integer milliseconds (e.g.
  83 ms instead of 83.33 ms at fps=12), which caused the bar to drift
  ~5–10 ms per loop and visibly lap the WebP after a minute.
- **Clip preview bar and WebP no longer desync after switching tabs and
  coming back.** Returning to the Clip Hunting tab re-mounts every
  visible tile so both the progress bar and the WebP restart from frame
  0 in lockstep. The bar (a fresh DOM element) already restarted
  cleanly, but Chromium was serving the WebP from its decoded image
  cache and the animation continued mid-cycle : bar at 0%, WebP at
  frame ~50. The img src now cache-busts on each activation so the
  browser re-decodes from scratch.

### Changed
- **PyTorch CPU/GPU mode is detected from the wheel's local tag
  (`+cu128` / `+cpu`) rather than a subprocess `torch.cuda.is_available()`
  probe at startup.** The probe was flaky on cold boots : driver not
  fully resident yet, first-import past the 10s timeout : and would
  silently demote a working `+cu` install to "cpu", which itself
  tripped the repair gate. `nvidia-smi` still gates whether GPU setup
  is offered, so a `+cu` wheel on a CPU-only host is caught by the
  right signal.

## [0.4.0] : 2026-05-11

### Added
- **Drag-and-drop files anywhere they're accepted.** Drop video or
  audio onto Vocal Extraction, Any To Audio, Clip Hunting, or Video To
  Video and they'll load just like the picker. Drop an image onto the
  background cropper in Settings to set or replace it. Hovering with
  files shows a clear drop target so you know it'll catch.
- **Custom save folder per AniKai download.** When the sniffer catches
  a stream we couldn't auto-name, a labeling prompt asks for the anime
  title and episode number : with autocomplete over folders you've
  already used : and lets you optionally save into any folder on disk
  instead of the default `<downloads>/<anime>` layout.

### Changed
- **Frontend refactored from a 6,616-line `main.tsx` to a 30-line
  entry mount.** Every panel, card, helper, and type now lives in a
  feature folder (`src/shell/`, `src/features/{audio,clips,downloader,
  logs,settings,video}/`, `src/lib/`, `src/types/`). One component per
  file, no barrel files, shared helpers consolidated into `src/lib/`.
  Behavior is identical : this is purely a maintainability upgrade
  that makes future features cheaper to add and easier to review.
- **Background cropper can be opened by clicking it.** The empty frame
  is now a click-or-Enter target in addition to the "Pick an image"
  button : matches the new drop behavior.

### Removed
- **Dead `AnimeBrowser` panel** and the 5 unused helpers + 2 unused
  types + 6 stale lucide imports that came with it. Nothing was
  rendering it; confirmed dead before deleting.

## [0.3.0] : 2026-05-10

### Added
- **Setup wizard now picks a download folder.** A new "Folder" step sits
  between Engine and Install (Hardware → Engine → **Folder** → Install →
  Done). The choice is persisted via `set_config(download_path)` so future
  downloads land where you told them to instead of the default
  `Videos\Ultimate AMV\anime downloads`. You can change it later from
  Settings.
- **Animated logo banner** at the top of the README (10 fps, palette-
  optimized GIF).

### Removed
- **"Use player" buttons in the YouTube trim editor.** The timecode inputs
  plus seek buttons already cover the same flow, so the extra buttons were
  just noise.

## [0.2.0] : 2026-05-09

### Added
- **Custom background image** with a built-in cropper : drag to position,
  scroll to zoom, dim and blur sliders. The image bleeds through every
  workspace area without hurting text legibility.
- **Custom theme colors.** Two-color accent gradient with five presets
  (cyan, mint, violet, rose, amber) plus full hex pickers for both stops.
- **YouTube trim editor.** Pick a start/end range before downloading
  instead of grabbing the full video; format inspection and source preview
  included.
- **Discord community button** in the README.

### Fixed
- **Engine setup integrity.** `setup_type` is now only persisted after
  `audio_setup` actually succeeds, so a crash mid-install no longer leaves
  config claiming GPU while CPU PyTorch is on disk.
- **Engine status reflects reality.** Settings derives the Active mode and
  READY badge from the installed PyTorch build (`+cu` / `+cpu`) rather
  than config alone, surfacing any mismatch with a one-click Switch to
  reconcile.

## [0.1.0] : 2026-05-09

### Added
- Initial release.
- Built-in browser with automatic episode and series detection on anime
  streaming sites.
- Audio separation (vocals / instrumentals) using ML models, with CPU and
  NVIDIA GPU (CUDA) support.
- Frame-accurate clip extraction and export via ffmpeg, with GPU-
  accelerated decoding where available.
- Download manager backed by a bundled yt-dlp.
- Self-contained first-run setup wizard that installs PyTorch, audio-
  separator, and ONNX Runtime into a bundled Python environment.

[0.6.2]: https://github.com/ElishaPervez/Ultimate-AMV/releases/tag/v0.6.2
[0.6.1]: https://github.com/ElishaPervez/Ultimate-AMV/releases/tag/v0.6.1
[0.6.0]: https://github.com/ElishaPervez/Ultimate-AMV/releases/tag/v0.6.0
[0.5.0]: https://github.com/ElishaPervez/Ultimate-AMV/releases/tag/v0.5.0
[0.4.1]: https://github.com/ElishaPervez/Ultimate-AMV/releases/tag/v0.4.1
[0.4.0]: https://github.com/ElishaPervez/Ultimate-AMV/releases/tag/v0.4.0
[0.3.0]: https://github.com/ElishaPervez/Ultimate-AMV/releases/tag/v0.3.0
[0.2.0]: https://github.com/ElishaPervez/Ultimate-AMV/releases/tag/v0.2.0
[0.1.0]: https://github.com/ElishaPervez/Ultimate-AMV/releases/tag/v0.1.0
