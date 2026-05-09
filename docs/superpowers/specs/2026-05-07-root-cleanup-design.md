# Cleanup Root Directory Design

Move non-essential and Graphify-related files to a separate folder to declutter the root.

## Files to Relocate

The following files and directories will be moved from the root to an `extra/` directory:

### Graphify Related
- `.graphify_ast.json`
- `.graphify_detect.json`
- `.graphify_python`
- `.graphify_uncached.txt`
- `graphify-out/` (directory)

### Extra Files
- `test_fast.webp`
- `test.webp`
- `output_180.mov`
- `output_360.mov`
- `output_700.mov`
- `output_default.mov`
- `output_prores.mov`
- `test_out1.mp4`
- `test_out2.mp4`
- `test_video.mp4`

## Out of Scope
- `temp.txt` (Requested to be excluded)
- `.codex` (Requested to be excluded)
- All other root files (`package.json`, `index.html`, etc.)

## Execution Steps
1. Create `extra/` directory at the project root.
2. Move the listed files and directory into `extra/`.
