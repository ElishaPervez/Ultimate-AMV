# Startup Dependency Verification

## What

Auto-verify installed Python dependencies against the user's chosen mode (CPU/GPU) on every app launch, and auto-install anything missing before showing the main UI.

## Design

### Flow

```
App start
 → read config.json (setup_complete?)
   → false → SetupWizard (existing, unchanged)
   → true  → DependencyVerifier (NEW)
              → read setup_type from config
              → invoke("audio_setup", { mode: setup_type })
                (reuses existing Rust command, no backend changes)
              → listen("audio-setup-progress")
                → "Verifying dependencies…" + spinner (fast path, <1s)
                → if install steps appear → progress/log view
                → on error → "Continue anyway" + "Retry"
              → onVerified() → render App
```

### Files changed

- **New:** `src/DependencyVerifier.tsx` — component, styled like SetupWizard (reuses `.setup-wizard`, `.setup-card`, `.setup-installing`, `.setup-log`, `.setup-error-block` CSS classes)
- **Modified:** `src/main.tsx` — `Root()` adds `depsVerified` state between `setupComplete` check and `<App />`

### What does NOT change

- No new Rust/Tauri commands
- No changes to `audio_cli.py`, `setup.py`, `hardware.py`, or any backend file
- `audio_setup` already: checks needed vs installed, only installs what's missing, returns fast when all good

### Error handling

- Config read fails → fall through to App (don't block)
- `audio_setup` fails → show error with "Continue anyway" (proceed to App) and "Retry"
- No internet during install → error state with same options
