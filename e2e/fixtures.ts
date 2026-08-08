import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test as base, type BrowserContext } from '@playwright/test';

// WebKit's OPFS (navigator.storage.getDirectory / createSyncAccessHandle) —
// which the whole app is built on — throws "UnknownError: The operation
// failed for an unknown transient reason (e.g. out of memory)" inside the
// ephemeral, no-real-profile context Playwright Test's built-in `context`
// fixture normally hands out (confirmed empirically: the exact same page
// works fine in a `launchPersistentContext` profile). Real Safari isn't
// ephemeral this way outside actual Private Browsing, so this is a
// Playwright/WebKit test-harness quirk, not a product bug — worth a real
// persistent context here so WebKit runs exercise the app instead of
// tripping over storage before it even loads.
export const test = base.extend<{ context: BrowserContext }>({
  context: async ({ browserName, playwright }, use) => {
    const userDataDir = mkdtempSync(path.join(tmpdir(), `remux-e2e-${browserName}-`));
    const context = await playwright[browserName].launchPersistentContext(userDataDir, {});
    try {
      await use(context);
    } finally {
      await context.close();
      rmSync(userDataDir, { recursive: true, force: true });
    }
  },
});

export { expect } from '@playwright/test';
