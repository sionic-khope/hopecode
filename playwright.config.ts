import { defineConfig } from '@playwright/test';

// Electron e2e (plan 9.3). Specs launch `out/main/index.js` via `_electron` with HOPECODE_FIXTURES=1 and a
// temp HOPECODE_HOME per launch; run `npm run build` first (test:e2e does not build).
export default defineConfig({
  testDir: './tests/e2e',
  testMatch: '**/*.spec.ts',
  fullyParallel: false,
  workers: 1,
  timeout: 90_000,
  expect: { timeout: 15_000 },
  retries: 0,
  reporter: [['list']],
});
