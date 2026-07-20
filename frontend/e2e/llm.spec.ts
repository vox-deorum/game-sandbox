import { rmSync } from 'node:fs'
import type { APIRequestContext } from '@playwright/test'

import {
  activeWindows,
  closePlay,
  closeSubmissions,
  declareSeason,
  finishedSeatedSession,
  openPlay,
  openSubmissions,
  setLlmOverride,
  submitReadyAgent,
} from './support/api.js'
import { authenticateBrowser, userIdOf } from './support/auth.js'
import { expect, test } from './support/fixtures.js'
import { HEARTS_ENV_ID, LLM_PERSONAS, LLM_SEASON } from './support/names.js'
import { stageExampleAgent } from './support/stage-example-agent.js'

const builtinSeats = {
  player_1: { kind: 'builtin-agent' as const },
  player_2: { kind: 'builtin-agent' as const },
  player_3: { kind: 'builtin-agent' as const },
}

async function developmentCompletion(actor: APIRequestContext, key: string): Promise<void> {
  const response = await actor.post('/api/llm/v1/chat/completions', {
    headers: { authorization: `Bearer ${key}` },
    data: {
      model: 'small',
      messages: [{ role: 'user', content: '[stub:success] Return one useful sentence.' }],
      max_completion_tokens: 4,
    },
  })
  expect(response.status(), await response.text()).toBe(200)
}

test('LLM development access, private telemetry, and replay inspection work end to end', async ({
  page,
  browser,
  baseURL,
  request,
  admin,
  as,
}) => {
  test.setTimeout(360_000)
  const original = await activeWindows(admin, HEARTS_ENV_ID)
  const owner = await as(LLM_PERSONAS.owner)
  const other = await as(LLM_PERSONAS.other)
  const ownerId = await userIdOf(owner)
  const oracle = stageExampleAgent('hearts', 'oracle')
  let seasonId: string | null = null

  try {
    if (original.submissionSeasonId !== null)
      await closeSubmissions(admin, original.submissionSeasonId)
    if (original.playSeasonId !== null) await closePlay(admin, original.playSeasonId)

    const season = await declareSeason(admin, LLM_SEASON, HEARTS_ENV_ID)
    seasonId = season.id
    await setLlmOverride(admin, season.id, {
      enabled: true,
      models: ['small'],
      official: { token_budget: 10_000, rate_limit_rpm: 60 },
      development: { token_budget: 10_000, rate_limit_rpm: 60 },
    })
    await openSubmissions(admin, season.id)
    await openPlay(admin, season.id)

    // The current-season My Agents row is the first key surface. Its secret is read once from the
    // real dialog and then used against the public OpenAI-compatible route.
    await authenticateBrowser(page.context(), owner)
    await page.goto('/my/agents')
    await expect(page.getByRole('meter', { name: 'Development usage' })).toBeVisible()
    await page.getByRole('button', { name: 'Create development key' }).click()
    const credential = page.getByRole('dialog', { name: 'Development credential' })
    await expect(credential.getByRole('textbox', { name: 'OPENAI_BASE_URL', exact: true })).toBeVisible()
    const firstKey = await credential
      .getByRole('textbox', { name: 'OPENAI_API_KEY', exact: true })
      .inputValue()
    await credential.getByRole('button', { name: 'Copy OPENAI_BASE_URL' }).click()
    await credential.getByRole('button', { name: 'Copy OPENAI_API_KEY' }).click()
    await credential.getByRole('button', { name: 'Copy .env' }).click()
    await credential.getByRole('button', { name: 'Done' }).click()
    await expect(credential).toHaveCount(0)

    // Spend against the first key before rotation so the later history assertion proves rotation
    // preserves the participant-season meter instead of merely invalidating an unused credential.
    await developmentCompletion(owner, firstKey)

    // Rotation confirms invalidation before showing the replacement. Closing the second dialog clears
    // the plaintext from the component; the old credential is rejected by the proxy.
    await page.getByRole('button', { name: 'Rotate development key' }).click()
    const confirmation = page.getByRole('dialog', { name: 'Rotate development key?' })
    await expect(confirmation.getByText('will stop working immediately')).toBeVisible()
    await confirmation.getByRole('button', { name: 'Rotate development key' }).click()
    await expect(credential).toBeVisible()
    const key = await credential
      .getByRole('textbox', { name: 'OPENAI_API_KEY', exact: true })
      .inputValue()
    await credential.getByRole('button', { name: 'Done' }).click()
    const oldKeyResponse = await owner.post('/api/llm/v1/chat/completions', {
      headers: { authorization: `Bearer ${firstKey}` },
      data: { model: 'small', messages: [{ role: 'user', content: 'old key' }] },
    })
    expect(oldKeyResponse.status()).toBe(401)

    const retainedCalls = await owner.get(`/api/seasons/${season.id}/llm-development/calls`)
    expect(retainedCalls.status(), await retainedCalls.text()).toBe(200)
    expect(((await retainedCalls.json()) as { calls: unknown[] }).calls).toHaveLength(1)

    await developmentCompletion(owner, key)
    const ownCalls = await owner.get(`/api/seasons/${season.id}/llm-development/calls`)
    expect(ownCalls.status(), await ownCalls.text()).toBe(200)
    expect(((await ownCalls.json()) as { calls: unknown[] }).calls).toHaveLength(2)
    const otherCalls = await other.get(`/api/seasons/${season.id}/llm-development/calls`)
    expect(otherCalls.status(), await otherCalls.text()).toBe(200)
    expect(((await otherCalls.json()) as { calls: unknown[] }).calls).toHaveLength(0)

    // Once submissions close, the existing key stops authorizing completions but successful history
    // remains reachable from the owner's expanded historical submission row.
    const historicalSubmissionId = await submitReadyAgent(owner, oracle, HEARTS_ENV_ID)
    await closeSubmissions(admin, season.id)
    const closedKeyResponse = await owner.post('/api/llm/v1/chat/completions', {
      headers: { authorization: `Bearer ${key}` },
      data: {
        model: 'small',
        messages: [{ role: 'user', content: '[stub:success] This call must stay blocked.' }],
      },
    })
    expect(closedKeyResponse.status()).toBe(403)
    expect((await closedKeyResponse.json()) as { error: { code?: string } }).toMatchObject({
      error: { code: 'development_closed' },
    })
    await page.goto(`/environments/${HEARTS_ENV_ID}/agents/${ownerId}`)
    await expect(page.getByRole('heading', { name: 'Development access' })).toHaveCount(0)
    const historicalRow = page.locator(`#submission-${historicalSubmissionId}`)
    const historicalHistory = historicalRow.getByRole('button', { name: 'View call history' })
    if (!(await historicalHistory.isVisible())) {
      await historicalRow.locator('.submission-summary').click()
    }
    await historicalHistory.click()
    const historicalDialog = page.getByRole('dialog', { name: 'Development call history' })
    await expect(historicalDialog.getByText('small')).toBeVisible()
    await historicalDialog.getByRole('button', { name: 'Close' }).click()
    await openSubmissions(admin, season.id)

    // Operators receive the compact participant table and can open the shared detail dialog.
    await authenticateBrowser(page.context(), admin)
    await page.goto(`/environments/${HEARTS_ENV_ID}/admin`)
    await page.getByRole('button', { name: new RegExp(LLM_SEASON) }).click()
    const usage = page.locator('section.admin-section', { hasText: 'Development usage' })
    await expect(usage.getByRole('button', { name: ownerId })).toBeVisible()
    await usage.getByRole('button', { name: ownerId }).click()
    await expect(page.getByRole('dialog', { name: `${ownerId} call history` })).toBeVisible()
    await page.getByRole('button', { name: 'Close' }).click()

    // The owner-facing profile resolves prices and totals, then shows the same private call history.
    await authenticateBrowser(page.context(), owner)
    await page.goto(`/environments/${HEARTS_ENV_ID}/agents/${ownerId}`)
    const development = page.locator('.development-section')
    await expect(development.getByText('Allowed model aliases')).toBeVisible()
    await expect(development.getByText(/small × 2/)).toBeVisible()
    await development.getByRole('button', { name: 'View call history' }).click()
    const history = page.getByRole('dialog', { name: 'Development call history' })
    await expect(history.getByText('small')).toBeVisible()
    await history.getByRole('button', { name: /small/ }).click()
    await expect(history.getByRole('heading', { name: 'Request' })).toBeVisible()
    await expect(history.getByRole('heading', { name: 'Response' })).toBeVisible()
    await history.getByRole('button', { name: 'Close' }).click()

    // A submitted Oracle makes genuine official calls through the internal relay. Its owner gets
    // request bodies, while a logged-out caller receives public cost metadata only.
    const submissionId = await submitReadyAgent(owner, oracle, HEARTS_ENV_ID)
    const recordingId = await finishedSeatedSession(
      admin,
      HEARTS_ENV_ID,
      { player_0: { kind: 'submission', submission_id: submissionId }, ...builtinSeats },
      { seed: 0 },
    )
    const ownerTelemetry = await owner.get(`/api/recordings/${recordingId}/llm`)
    expect(ownerTelemetry.status(), await ownerTelemetry.text()).toBe(200)
    const ownerBody = (await ownerTelemetry.json()) as {
      calls: Array<{ request?: unknown; completion?: unknown }>
      total_budget_cost_units: number
    }
    expect(ownerBody.calls.length).toBeGreaterThan(0)
    expect(ownerBody.calls[0]).toHaveProperty('request')
    expect(ownerBody.calls[0]).toHaveProperty('completion')
    const publicTelemetry = await request.get(`/api/recordings/${recordingId}/llm`)
    expect(publicTelemetry.status(), await publicTelemetry.text()).toBe(200)
    const publicBody = (await publicTelemetry.json()) as {
      calls: Array<{
        tick: number | null
        model: string
        input_tokens: number
        reasoning_tokens: number
        output_tokens: number
        cost_weight: number
        budget_cost_units: number
        request?: unknown
        completion?: unknown
      }>
      total_budget_cost_units: number
    }
    expect(publicBody.calls.length).toBeGreaterThan(0)
    expect(publicBody.total_budget_cost_units).toBe(ownerBody.total_budget_cost_units)
    expect(publicBody.calls[0]).not.toHaveProperty('request')
    expect(publicBody.calls[0]).not.toHaveProperty('completion')

    await page.goto(`/replays/${recordingId}`)
    const log = page.locator('.decision-log')
    await expect(log.getByRole('columnheader', { name: 'LLM cost' })).toBeVisible()
    const recordingTotal = page.getByRole('button', {
      name: 'Show whole-recording LLM cost details',
    })
    await expect(recordingTotal).toContainText(
      `${ownerBody.total_budget_cost_units.toLocaleString()} units`,
    )
    const inspect = log.getByRole('button', { name: 'Inspect request and response' }).first()
    await inspect.click()
    const inspector = page.getByRole('dialog', { name: 'Inspect request and response' })
    await expect(inspector.getByRole('heading', { name: 'Request' })).toBeVisible()
    await expect(inspector.getByRole('heading', { name: 'Response' })).toBeVisible()
    await inspector.getByRole('button', { name: 'Close' }).click()

    // Operators retain the same body inspection capability on the replay UI.
    await authenticateBrowser(page.context(), admin)
    await page.goto(`/replays/${recordingId}`)
    await page
      .locator('.decision-log')
      .getByRole('button', { name: 'Inspect request and response' })
      .first()
      .click()
    const operatorInspector = page.getByRole('dialog', { name: 'Inspect request and response' })
    await expect(operatorInspector.getByRole('heading', { name: 'Request' })).toBeVisible()
    await expect(operatorInspector.getByRole('heading', { name: 'Response' })).toBeVisible()
    await operatorInspector.getByRole('button', { name: 'Close' }).click()

    // A genuinely logged-out replay reader retains costs but gets no inspection action. The tooltip
    // is programmatically associated, works from keyboard focus and Escape, and stays usable narrow.
    await page.context().clearCookies()
    await page.setViewportSize({ width: 480, height: 900 })
    await page.goto(`/replays/${recordingId}`)
    const publicLog = page.locator('.decision-log')
    await expect(
      publicLog.getByRole('button', { name: 'Inspect request and response' }),
    ).toHaveCount(0)
    const details = publicLog.getByRole('button', { name: 'LLM cost details' }).first()
    await details.focus()
    const describedBy = await details.getAttribute('aria-describedby')
    expect(describedBy).not.toBeNull()
    const tooltip = page.locator(`#${describedBy as string}`)
    await expect(tooltip).toHaveAttribute('role', 'tooltip')
    await expect(tooltip).toContainText('successful call')
    const displayedCall = publicBody.calls.find((call) => call.tick !== null)
    expect(displayedCall).toBeDefined()
    if (displayedCall === undefined) throw new Error('recording had no tick-attributed LLM call')
    await expect(tooltip).toContainText(displayedCall.model)
    await expect(tooltip).toContainText(`${displayedCall.cost_weight} units/token`)
    await expect(tooltip).toContainText(
      `${displayedCall.input_tokens.toLocaleString()} input + ${displayedCall.output_tokens.toLocaleString()} output tokens`,
    )
    await expect(tooltip).toContainText(
      `${displayedCall.reasoning_tokens.toLocaleString()} reasoning tokens within output`,
    )
    await expect(tooltip).toContainText(`${displayedCall.budget_cost_units.toLocaleString()} units`)
    await page.keyboard.press('Escape')
    await expect(tooltip).toHaveCount(0)
    await expect(details).toBeFocused()
    await details.hover()
    await expect(tooltip).toBeVisible()
    await tooltip.hover()
    // Outwait the tooltip's 150 ms close timer while moving between trigger and tooltip.
    await page.waitForTimeout(200)
    await expect(tooltip).toBeVisible()

    // Exercise the same disclosure with a real touch-enabled browser context.
    const touchContext = await browser.newContext({
      baseURL: baseURL as string,
      hasTouch: true,
      viewport: { width: 480, height: 900 },
    })
    try {
      const touchPage = await touchContext.newPage()
      await touchPage.goto(`/replays/${recordingId}`)
      const touchDetails = touchPage
        .locator('.decision-log')
        .getByRole('button', { name: 'LLM cost details' })
        .first()
      await touchDetails.tap()
      await expect(touchPage.getByRole('tooltip')).toContainText('successful call')
    } finally {
      await touchContext.close()
    }
  } finally {
    rmSync(oracle, { recursive: true, force: true })
    if (seasonId !== null) {
      await closeSubmissions(admin, seasonId).catch(() => {})
      await closePlay(admin, seasonId).catch(() => {})
    }
    if (original.submissionSeasonId !== null) {
      await openSubmissions(admin, original.submissionSeasonId).catch(() => {})
    }
    if (original.playSeasonId !== null) {
      await openPlay(admin, original.playSeasonId).catch(() => {})
    }
  }
})
