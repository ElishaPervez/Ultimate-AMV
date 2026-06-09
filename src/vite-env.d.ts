/// <reference types="vite/client" />

/**
 * App version injected at build time from package.json via the `define`
 * blocks in vite.config.ts and vitest.config.ts (kept in lockstep with
 * tauri.conf.json / Cargo.toml by the release flow).
 */
declare const __APP_VERSION__: string;
