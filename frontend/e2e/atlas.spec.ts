import type { Page } from '@playwright/test';
import { expect, realBackend, regionHeading, test } from './fixtures';

const slider = (page: Page, name: string) => page.getByRole('slider', { name: `${name} slice` });

test.beforeEach(async ({ page }) => {
  await page.goto('/app');
  await expect(page.getByRole('img', { name: 'Coronal slice 660' })).toBeVisible();
});

test('clicking a slice identifies the region and moves the other views to it', async ({ page }) => {
  await expect(regionHeading(page)).toHaveText('No region selected');
  const before = await slider(page, 'Sagittal').getAttribute('aria-valuenow');
  const img = page.getByRole('img', { name: 'Coronal slice 660' });
  const box = (await img.boundingBox())!;
  await page.mouse.click(box.x + box.width * 0.4, box.y + box.height * 0.45);

  await expect(page).toHaveURL(/region=\d+/);
  await expect(regionHeading(page)).not.toHaveText('No region selected');
  await expect(slider(page, 'Sagittal')).not.toHaveAttribute('aria-valuenow', before!);
  await expect(slider(page, 'Coronal')).toHaveAttribute('aria-valuenow', '660'); // the clicked view stays
});

test('a drag pans instead of clicking; the wheel zooms; Reset zoom puts it back', async ({ page }) => {
  const vp = page.getByTestId('sagittal-viewport');
  const b = (await vp.boundingBox())!;
  const zoom = page.getByRole('status', { name: 'Sagittal zoom' });
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
  for (let i = 0; i < 4; i++) await page.mouse.wheel(0, -120);
  await expect(zoom).not.toHaveText('100%');

  let lookups = 0;
  page.on('request', (r) => {
    if (r.url().includes('/api/lookup')) lookups++;
  });
  await page.mouse.down();
  await page.mouse.move(b.x + b.width / 2 + 80, b.y + b.height / 2 + 40, { steps: 5 });
  await page.mouse.up();
  await page.waitForTimeout(500); // a click would have sent its lookup by now
  expect(lookups).toBe(0);

  await page.getByRole('region', { name: 'Sagittal view' }).getByRole('button', { name: 'Reset zoom' }).click();
  await expect(zoom).toHaveText('100%');
});

test('search opens a region, and the link reopens it', async ({ page }) => {
  const search = page.getByRole('combobox', { name: 'Find a region' });
  await search.fill('Caudoputamen');
  await expect(page.getByRole('option').first()).toBeVisible();
  await search.press('Enter');
  await expect(regionHeading(page)).toHaveText(/Caudoputamen/);
  await expect(page).toHaveURL(/(region|group)=/);

  // The 3D view loads the region's own mesh.
  const status3d = page.getByRole('region', { name: '3D view' }).getByRole('status');
  await expect(status3d).toHaveText(/^CP\s*Caudoputamen$/);

  await page.reload();
  await expect(regionHeading(page)).toHaveText(/Caudoputamen/);
});

test('create an account and save a region', async ({ page }) => {
  test.skip(realBackend, 'would create a real account');
  await page.getByRole('button', { name: 'Create account' }).click();
  const dialog = page.getByRole('dialog', { name: 'Create an account' });
  const email = `e2e-${test.info().workerIndex}-${Date.now()}@example.com`; // unique, so a retry can sign up again
  await dialog.getByLabel('Email').fill(email);
  await dialog.getByLabel('Password').fill('correct-horse-battery');
  await dialog.getByRole('button', { name: 'Create account' }).click();
  await expect(page.getByText(email)).toBeVisible();

  const img = page.getByRole('img', { name: 'Coronal slice 660' });
  const box = (await img.boundingBox())!;
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await expect(regionHeading(page)).not.toHaveText('No region selected');
  const name = await regionHeading(page).textContent();
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByRole('button', { name: 'Saved' })).toBeVisible();
  await page.getByRole('tab', { name: 'Saved' }).click();
  await expect(page.getByRole('tabpanel', { name: 'Saved' })).toContainText(name!);
});
