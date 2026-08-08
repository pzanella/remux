import { defineConfig, devices } from '@playwright/test';

// Real end-to-end coverage against both rendering engines the app targets
// (see README's "Needs Chrome or Edge 108+" note) — Chromium for the
// primary supported path, WebKit because Safari-class bugs (structured
// clone, MediaSource/Shaka interop) only ever show up there, never in
// Chromium, and have twice now turned out to be real product bugs rather
// than "Safari just doesn't support this" dead ends. See git history on
// src/hooks/useTranscoder.ts and src/components/Player.tsx for the two
// this suite is meant to catch a regression of.
export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  // Each spec drives real WebCodecs/WASM/FFmpeg work in-browser; running
  // several at once on a shared CI runner risks resource contention
  // flaking a scenario that works fine in isolation.
  workers: process.env.CI ? 1 : undefined,
  // The HTML report only costs anything to generate on a failure (see the
  // "Upload Playwright report" CI step) — 'github' alone annotates the run
  // but leaves nothing to download and actually inspect a trace from.
  reporter: process.env.CI ? [['github'], ['html', { open: 'never' }]] : 'list',
  timeout: 60_000,
  use: {
    baseURL: 'http://localhost:4173',
    trace: 'retain-on-failure',
  },
  webServer: {
    command: 'npm run dev -- --port 4173 --strictPort',
    url: 'http://localhost:4173',
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    { name: 'webkit', use: { ...devices['Desktop Safari'] } },
  ],
});
