import { test, expect } from '@playwright/test';

/**
 * E2E tests for heartbeat disconnect/reconnect behavior.
 *
 * Verifies that when the server heartbeat drops, the UI shows a
 * "reconnecting" banner instead of resetting to onboarding, and
 * recovers automatically when the heartbeat returns.
 *
 * Uses Playwright route interception to simulate heartbeat failure
 * without actually killing the backend server.
 */

const BACKEND_URL = process.env.BACKEND_URL ?? 'http://localhost:4747';
const FRONTEND_URL = process.env.FRONTEND_URL ?? 'http://localhost:5173';

test.beforeAll(async () => {
  if (process.env.E2E) return;
  try {
    const [backendRes, frontendRes] = await Promise.allSettled([
      fetch(`${BACKEND_URL}/api/repos`),
      fetch(FRONTEND_URL),
    ]);
    if (
      backendRes.status === 'rejected' ||
      (backendRes.status === 'fulfilled' && !backendRes.value.ok)
    ) {
      test.skip(true, 'gitnexus serve not available');
      return;
    }
    if (
      frontendRes.status === 'rejected' ||
      (frontendRes.status === 'fulfilled' && !frontendRes.value.ok)
    ) {
      test.skip(true, 'Vite dev server not available');
      return;
    }
    if (backendRes.status === 'fulfilled') {
      const repos = await backendRes.value.json();
      if (!repos.length) {
        test.skip(true, 'No indexed repos');
        return;
      }
    }
  } catch {
    test.skip(true, 'servers not available');
  }
});

/** Load the app, select a repo, and wait for the graph to appear. */
async function waitForGraphLoaded(page: import('@playwright/test').Page) {
  await page.goto('/');

  const landingCard = page.locator('[data-testid="landing-repo-card"]').first();
  try {
    await landingCard.waitFor({ state: 'visible', timeout: 15_000 });
    await landingCard.click();
  } catch {
    // Landing screen may not appear (e.g. ?server auto-connect)
  }

  await expect(page.locator('[data-testid="status-ready"]')).toBeVisible({ timeout: 30_000 });
}

test.describe('Heartbeat Reconnect', () => {
  test('shows reconnecting banner when heartbeat fails, not onboarding reset', async ({ page }) => {
    await waitForGraphLoaded(page);

    // Verify we're in the exploring view (graph visible, StatusBar present)
    await expect(page.locator('[data-testid="status-ready"]')).toBeVisible();

    // Block the heartbeat SSE endpoint to simulate server going down
    await page.route('**/api/heartbeat', (route) => route.abort('connectionrefused'));

    // Wait for the reconnecting banner to appear (heartbeat retries after ~1s)
    const banner = page.getByText('Server connection lost');
    await expect(banner).toBeVisible({ timeout: 10_000 });

    // The graph canvas should STILL be visible — not reset to onboarding
    await expect(page.locator('canvas').first()).toBeVisible();

    // The DropZone (onboarding) should NOT be visible
    const dropzone = page.locator('[data-testid="dropzone"]');
    await expect(dropzone).not.toBeVisible();
  });

  test('recovers when heartbeat returns after disconnect', async ({ page }) => {
    await waitForGraphLoaded(page);

    // Block heartbeat
    await page.route('**/api/heartbeat', (route) => route.abort('connectionrefused'));

    // Wait for banner
    const banner = page.getByText('Server connection lost');
    await expect(banner).toBeVisible({ timeout: 10_000 });

    // Unblock heartbeat — the real server is still running
    await page.unroute('**/api/heartbeat');

    // Banner should disappear as heartbeat reconnects
    await expect(banner).not.toBeVisible({ timeout: 20_000 });

    // Graph should still be there
    await expect(page.locator('[data-testid="status-ready"]')).toBeVisible();
  });
});
