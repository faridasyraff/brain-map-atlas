import { expect, test as base, type Page } from '@playwright/test';

/** Every test fails on an uncaught page error or a console error. */
export const test = base.extend<{ failOnPageErrors: void }>({
  failOnPageErrors: [
    async ({ page }, use) => {
      const errors: string[] = [];
      page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
      page.on('console', (m) => {
        // A failed request logs a console error; the tests check those flows themselves.
        if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(`console: ${m.text()}`);
      });
      await use();
      expect(errors).toEqual([]);
    },
    { auto: true },
  ],
});

export { expect };

/** True when testing the real app (E2E_BASE_URL) rather than the mock backend. */
export const realBackend = !!process.env.E2E_BASE_URL;

/** The selected region's name in the desktop inspector. */
export const regionHeading = (page: Page) => page.getByRole('tabpanel', { name: 'Details' }).getByRole('heading', { level: 2 }).first();
