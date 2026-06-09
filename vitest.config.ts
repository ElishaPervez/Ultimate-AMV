import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import pkg from './package.json'

export default defineConfig({
  plugins: [react()],
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
  test: {
    // jsdom provides window, document, localStorage, etc.
    environment: 'jsdom',

    // Run setup mocks before every test file
    setupFiles: ['./tests/setup/index.ts'],

    // Expose describe/it/expect/vi as globals so test files don't need imports.
    // A2-A10: use globals directly — no need to import from 'vitest'.
    globals: true,

    // Collect tests from both src/ (collocated) and tests/ (infra/shared)
    include: [
      'src/**/*.test.{ts,tsx}',
      'tests/**/*.test.{ts,tsx}',
    ],

    // Exclude node_modules and Tauri/Rust artifacts.
    exclude: [
      'node_modules/**',
      'src-tauri/**',
    ],

    // Coverage via V8 (optional — run with: vitest run --coverage)
    coverage: {
      provider: 'v8',
      include: ['src/**/*.{ts,tsx}'],
      exclude: ['src/**/*.test.{ts,tsx}', 'src/main.tsx'],
    },

    // Make test output easier to read in CI
    reporter: process.env.CI ? 'verbose' : 'default',
  },
})
