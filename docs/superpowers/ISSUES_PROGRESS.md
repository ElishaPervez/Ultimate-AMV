# Issues Progress

## Done
- **#1** Default clip extraction mode GPU when no GPU — `config.py` default → `"cpu"`, `SetupWizard.tsx` saves `clip_extraction_mode: "cpu"` on CPU finish
- **#9** `npm run desktop` error 183 — added `predesktop` script to `package.json` to clean stale build dirs
- **#5** Status badge respects `force_cpu` — `currentMode` now derived from both `setup_type` AND `force_cpu` in `main.tsx`

## Done
- **#3** Console windows flash — added `cmd()` helper with `CREATE_NO_WINDOW` (0x0800_0000), replaced all 9 `Command::new` call sites in `lib.rs`
- **#6** Open extracted vocals — `ResultCard` now accepts `outputDir` prop; "Open folder" button calls new `open_path` Tauri command (opens Explorer); output paths stored from `audio_extract` result
- **#7** Cancel buttons — `cancel_audio` / `cancel_clip` Tauri commands added (taskkill /F /T /PID); Cancel button in `ExtractionProgressCard` (audio) and `clip-cancel-action` button (clip); `cancellingRef` suppresses false error on cancel
- **#8** Process cleanup on close — `on_window_event(CloseRequested)` handler kills both child PIDs via `kill_child_pid`; PID stored after spawn, cleared after `child.wait()`

## Still to fix
- **#2** Quality detection slow in AniKai — `inspect_stream_formats` is synchronous, needs async piped stdout or parallelize
- **#4** Clips do not play after extraction — `convertFileSrc` is used, needs deeper investigation (check if `#t=` fragment works in WebView2, check if source files exist)
- **#10** Panels unclickable — inspect CSS for `pointer-events: none` on overlays, check app shell grid `overflow: hidden` clipping
