import { expect, test } from './fixtures';

test.beforeEach(async ({ page }) => {
  await page.goto('/app');
  await expect(page.getByRole('img', { name: 'Coronal slice 660' })).toBeVisible();
});

test('one view at a time, nothing wider than the screen', async ({ page }) => {
  await expect(page.getByRole('tab')).toHaveText(['Sagittal', 'Coronal', 'Transverse', '3D']);
  await expect(page.getByRole('tab', { name: 'Coronal' })).toHaveAttribute('aria-selected', 'true');
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBe(0);

  await page.getByRole('tab', { name: 'Sagittal' }).tap();
  await expect(page.getByRole('img', { name: /^Sagittal slice/ })).toBeVisible();
  await expect(page.getByRole('img', { name: 'Coronal slice 660' })).toBeHidden();
});

test('tap a slice to identify the region; the sheet shows it', async ({ page }) => {
  const sheet = page.getByRole('region', { name: 'Selected region' });
  await expect(sheet.getByRole('heading')).toHaveText('No region selected');
  const box = (await page.getByTestId('coronal-viewport').boundingBox())!;
  await page.touchscreen.tap(box.x + box.width * 0.4, box.y + box.height * 0.45);
  await expect(sheet.getByRole('heading')).not.toHaveText('No region selected');
  await expect(page).toHaveURL(/region=\d+/);
  for (const name of ['Save', 'Copy link', 'Ask']) await expect(sheet.getByRole('button', { name })).toBeVisible();

  await sheet.getByRole('button', { name: 'Show region details' }).last().tap();
  await expect(page.getByRole('dialog', { name: 'Region details' }).getByRole('tab', { name: 'Inspector' })).toBeVisible();
});

test('step through slices with − and +', async ({ page }) => {
  const number = page.getByRole('status', { name: 'Coronal slice number' });
  await expect(number).toHaveText('660');
  await page.getByRole('button', { name: 'Next coronal slice' }).tap();
  await expect(number).toHaveText('661');
  await expect(page.getByRole('img', { name: 'Coronal slice 661' })).toBeVisible();
  await page.getByRole('button', { name: 'Previous coronal slice' }).tap();
  await expect(number).toHaveText('660');
});

test('the 3D tab shows the 3D view', async ({ page }) => {
  await page.getByRole('tab', { name: '3D' }).tap();
  const view = page.getByRole('region', { name: '3D view' });
  await expect(view.getByLabel('3D brain')).toBeVisible();
  await expect(view.getByRole('status')).toContainText('Select a region');
});
