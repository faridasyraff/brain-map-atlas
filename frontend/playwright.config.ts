import { defineConfig, devices } from '@playwright/test';

/**
 * End-to-end tests (e2e/*.spec.ts) in a real browser.
 *
 *   npm run e2e                                   build, then test against the mock backend (as CI does)
 *   E2E_BASE_URL=http://localhost:5000 npm run e2e    test against the real app (Docker) instead
 *
 * The tests only assert what holds for both: real atlas data or the mock's.
 */
const real = process.env.E2E_BASE_URL;
const port = 4173;

export default defineConfig({
  testDir: 'e2e',
  timeout: 45_000,
  expect: { timeout: 15_000 },
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['github'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: real ?? `http://localhost:${port}`,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    // WebGL for the 3D view, in software (CI has no GPU).
    launchOptions: { args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] },
  },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } }, testIgnore: /phone/ },
    { name: 'phone', use: { ...devices['Pixel 7'] }, testMatch: /phone/ },
  ],
  webServer: real
    ? undefined
    : { command: `node e2e/mock-server.mjs ${port}`, url: `http://localhost:${port}/health`, reuseExistingServer: !process.env.CI },
});
