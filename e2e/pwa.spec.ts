import { test, expect } from './fixtures';

test('serves a valid web app manifest with real, reachable icon assets', async ({ page }) => {
  await page.goto('/');

  const manifestHref = await page.locator('link[rel="manifest"]').getAttribute('href');
  expect(manifestHref).toBeTruthy();

  const manifestUrl = new URL(manifestHref!, page.url()).toString();
  const manifestResponse = await page.request.get(manifestUrl);
  expect(manifestResponse.ok()).toBe(true);
  const manifest = await manifestResponse.json();

  expect(manifest.name).toBeTruthy();
  expect(manifest.display).toBe('standalone');
  expect(manifest.start_url).toBeTruthy();

  const sizes = manifest.icons.map((i: { sizes: string }) => i.sizes);
  expect(sizes).toContain('192x192');
  expect(sizes).toContain('512x512');
  expect(manifest.icons.some((i: { purpose?: string }) => i.purpose === 'maskable')).toBe(true);

  // A manifest pointing at a 404'd icon is invisible to a test that only
  // checks the JSON shape — fetch every icon it actually references.
  for (const icon of manifest.icons as { src: string }[]) {
    const iconUrl = new URL(icon.src, manifestUrl).toString();
    const res = await page.request.get(iconUrl);
    expect(res.ok(), `icon ${icon.src} should load`).toBe(true);
  }
});

test('passes Chrome\'s own installability check', async ({ page, browserName }) => {
  test.skip(browserName !== 'chromium', 'Page.getInstallabilityErrors is a Chromium-only CDP method.');
  await page.goto('/');

  // The same deterministic check Chrome itself runs to decide whether to
  // offer the install prompt — unlike the `beforeinstallprompt` event
  // itself, this isn't gated behind headless/engagement heuristics that
  // never fire in an automated context.
  const client = await page.context().newCDPSession(page);
  const { installabilityErrors } = await client.send('Page.getInstallabilityErrors');
  expect(installabilityErrors).toEqual([]);
});
