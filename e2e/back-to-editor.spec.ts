import { test, expect } from './fixtures';
import { uploadSource, addChapter, runExport } from './helpers';

test('can navigate back to the editor after export completes, and back to the result view again', async ({ page }) => {
  await page.goto('/');
  await uploadSource(page, 'sample.mp4'); // 2s
  await addChapter(page, 'Cold Open');

  const result = await runExport(page);
  expect(result).toBe('done');
  await page.click('.export-modal-close');

  await expect(page.locator('.chapter-ruler')).toHaveCount(0);
  const backButton = page.getByRole('button', { name: 'Back to Editor' });
  await expect(backButton).toBeVisible();

  await backButton.click();
  await expect(page.locator('.chapter-ruler')).toBeVisible();
  await expect(page.locator('.chapter-marker')).toHaveCount(1);

  const viewExportButton = page.getByRole('button', { name: 'View Export' });
  await viewExportButton.click();
  await expect(page.locator('.chapter-ruler')).toHaveCount(0);
  await expect(backButton).toBeVisible();
});

test('editor controls are read-only when viewed back after a completed export', async ({ page }) => {
  await page.goto('/');
  await uploadSource(page, 'sample.mp4');
  await runExport(page);
  await page.click('.export-modal-close');

  await page.getByRole('button', { name: 'Back to Editor' }).click();
  await expect(page.locator('.timeline-toolbar .icon-btn')).toBeDisabled();
});
