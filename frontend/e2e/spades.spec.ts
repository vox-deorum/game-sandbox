import { type BrowserContext, expect, type Locator, test } from '@playwright/test'

import { startSession, stopSessionAndAwaitFree } from './support/api.js'
import { SPECTATOR } from './support/names.js'

/**
 * The focused Stage 8 browser journey. A human in player_0 queues one broadcast and one targeted
 * message before taking the first action. Both messages ride the same recorded tick, while the relay
 * sends only the broadcast to a separately attached spectator. Replay then exposes the complete log.
 */

const SPADES_ENV_ID = 'spades'
const BROADCAST = 'good luck everyone'
const TARGETED = 'partner, cover the ace'

/** Click the bid-1 chip in the Spades renderer's fixed 960 by 720 internal coordinate space. */
async function bidOne(canvas: Locator): Promise<void> {
  const box = await canvas.boundingBox()
  expect(box, 'Spades canvas bounding box').not.toBeNull()
  if (box === null) {
    throw new Error('no Spades canvas bounding box')
  }
  await canvas.click({
    position: {
      x: (372 / 960) * box.width,
      y: (330 / 720) * box.height,
    },
  })
}

test('Spades chat is filtered live and complete in replay', async ({ page, browser, request }) => {
  // A live container session plus two browser contexts needs more room than a DOM-only check.
  test.setTimeout(120_000)

  let sessionId: string | null = null
  let spectatorContext: BrowserContext | null = null
  try {
    // Player 0 opens every Spades hand. Making it the human seat keeps the first tick pending until both
    // browsers have attached and the controller has queued the two messages this journey compares.
    sessionId = await startSession(request, 'dev-user', SPADES_ENV_ID, {
      player_0: { kind: 'human' },
      player_1: { kind: 'builtin-agent' },
      player_2: { kind: 'builtin-agent' },
      player_3: { kind: 'builtin-agent' },
    })
    await page.goto(`/sessions/${sessionId}`)
    const canvas = page.locator('canvas.renderer-canvas')
    await expect(canvas).toBeVisible({ timeout: 60_000 })
    const controllerChat = page.getByRole('group', { name: 'Chat', exact: true })
    await expect(controllerChat).toBeVisible()

    // A different browser identity attaches before the first step. It gets the read-only panel, and the
    // relay will later deliver the broadcast while withholding the targeted message from this context.
    spectatorContext = await browser.newContext()
    await spectatorContext.addInitScript((user) => {
      window.localStorage.setItem('sandbox-user', user)
    }, SPECTATOR)
    const spectator = await spectatorContext.newPage()
    await spectator.goto(page.url())
    // The panel shell exists before the socket delivers its header. The mounted renderer proves the
    // spectator attachment completed before the controller advances the first tick.
    await expect(spectator.locator('canvas.renderer-canvas')).toBeVisible({ timeout: 60_000 })
    const spectatorChat = spectator.getByRole('group', { name: 'Chat log' })
    await expect(spectatorChat).toBeVisible()
    await expect(spectatorChat.getByRole('textbox')).toHaveCount(0)

    // Queue one broadcast and one private line for player_2 through the same composer. There is no local
    // echo, so neither appears until bid 1 advances the turn and the harness records both on tick 0.
    const recipient = controllerChat.getByLabel('Recipient')
    const message = controllerChat.getByLabel('Message')
    await recipient.selectOption('')
    await message.fill(BROADCAST)
    await controllerChat.getByRole('button', { name: 'Send' }).click()
    await recipient.selectOption('player_2')
    await message.fill(TARGETED)
    await controllerChat.getByRole('button', { name: 'Send' }).click()
    await expect(controllerChat.getByText(BROADCAST)).toHaveCount(0)
    await expect(controllerChat.getByText(TARGETED)).toHaveCount(0)

    await bidOne(canvas)
    await expect(controllerChat.getByText(BROADCAST)).toBeVisible({ timeout: 30_000 })
    await expect(controllerChat.getByText(TARGETED)).toBeVisible()
    await expect(controllerChat.getByText('from you')).toHaveCount(2)
    await expect(spectatorChat.getByText(BROADCAST)).toBeVisible()
    await expect(spectatorChat.getByText(TARGETED)).toHaveCount(0)
    await spectatorContext.close()
    spectatorContext = null

    // The stopped partial hand preserves tick 0. Unlike the live spectator stream, replay exposes both
    // recorded messages immediately and stays read-only.
    await page.getByRole('button', { name: 'Stop' }).click()
    const openReplay = page.getByRole('link', { name: 'Open replay' })
    await expect(openReplay).toBeVisible({ timeout: 60_000 })
    await openReplay.click()

    const replayChat = page.getByRole('group', { name: 'Chat log' })
    await expect(replayChat.getByText(BROADCAST)).toBeVisible()
    await expect(replayChat.getByText(TARGETED)).toBeVisible()
    await expect(replayChat.getByText('broadcast')).toBeVisible()
    await expect(replayChat.getByText('to Player 2')).toBeVisible()
    await expect(replayChat.getByRole('textbox')).toHaveCount(0)
  } finally {
    // Cleanup is best-effort so a secondary close/delete problem never masks the journey's assertion.
    await spectatorContext?.close().catch(() => {})
    if (sessionId !== null) {
      await stopSessionAndAwaitFree(request, 'dev-user', sessionId).catch(() => {})
    }
  }
})
