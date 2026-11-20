import { expect, regionHeading, test } from './fixtures';

test('the landing page shows a real section and opens the atlas on the hippocampus', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Find any region of the mouse brain');
  const hero = page.getByRole('img', { name: /Coronal section of the mouse brain/ });
  await expect(hero).toBeVisible();
  // Decoded, not just in the page.
  await expect.poll(() => hero.evaluate((img: HTMLImageElement) => img.naturalWidth)).toBeGreaterThan(0);

  await page.getByRole('link', { name: 'Try the hippocampus' }).click();
  await expect(page).toHaveURL(/\/app\?/);
  await expect(regionHeading(page)).toHaveText(/Hippocampal formation/);
});

test('links from the old /next preview open the same view at /app', async ({ page }) => {
  await page.goto('/next?group=Hippocampal%20formation');
  await expect(page).toHaveURL(/\/app\?/);
  await expect(regionHeading(page)).toHaveText(/Hippocampal formation/);
});

test('"Open the atlas" opens the atlas', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('link', { name: 'Open the atlas' }).click();
  await expect(page.getByRole('main', { name: 'Atlas views' })).toBeVisible();
});
