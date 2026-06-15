import { expect, test } from '@playwright/test'

/**
 * The allowlist variation, run against the `restricted` server whose allowlist names no one, so the
 * auto-logged `dev-user` is not allowlisted. The frontend hides the play and watch entry points, and a
 * direct start request is rejected by the backend — the enforcement, with the hidden UI as courtesy.
 * This project does not start a session, so it needs no Docker daemon.
 */
test('a non-allowlisted user sees no play entry points', async ({ page }) => {
  await page.goto('/environments/flappy_bird')
  await expect(page.getByText(/limited to allowlisted users/)).toBeVisible()
  await expect(page.getByRole('button', { name: 'Play Yourself' })).toHaveCount(0)
  // The watch list's Watch buttons (built-in Naive agent and any submissions) are hidden too.
  await expect(page.getByRole('button', { name: 'Watch' })).toHaveCount(0)
})

test('a direct start request from a non-allowlisted user is rejected', async ({ request }) => {
  const response = await request.post('/api/sessions', {
    data: { env_id: 'flappy_bird', mode: 'scripted' },
  })
  expect(response.status()).toBe(403)
  expect((await response.json()).code).toBe('not_allowlisted')
})
