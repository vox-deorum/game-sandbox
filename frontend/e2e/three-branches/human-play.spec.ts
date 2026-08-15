import type { BrowserContext, Locator, Page } from '@playwright/test'

import { getSession, startSession, stopSessionAndAwaitFree } from '../support/api.js'
import { authenticateBrowser } from '../support/auth.js'
import { expect, test } from '../support/fixtures.js'
import { SPECTATOR } from '../support/names.js'
import { controlCentre, ENV_ID } from './support.js'

/**
 * The step 6 human-play journey. One live cast_5 session with the visitor seat in human hands
 * covers, in order: keyboard locomotion against the action and position probes, the expression
 * palette by hotkey and by plate click, the use preview out of reach at spawn and in reach at the
 * village bell, a broadcast echoing back into the visitor's transcript, a direct line to an NPC
 * hunted down live (NPC motion is not seed-deterministic), a spectator seeing the complete
 * delivered transcript with no input surfaces, and the stopped session's replay carrying the same
 * complete thread with no input surfaces.
 *
 * The walking targets below are layout facts of seed 0, computed offline against
 * environments/three_branches (build_village(0)). The layout is fully seed-determined, so they are
 * stable across runs.
 */

const SEED = 0

/**
 * A standing point 0.8 m short of the village bell, the prop nearest the seed-0 spawn (3.5, 55.5).
 * The bell is a circle of radius 0.5 at (16.5, 64.5), the straight walk from the spawn crosses
 * only passable road and open ground, and every point within the 0.35 m arrival tolerance still
 * selects the bell under the environment's 1.5 m reach-plus-unblocked-line rule.
 */
const BELL_STOP = { x: 15.43, y: 63.76 }
const BELL_ID = 'bell_0'

/**
 * Under cast_5, npc_i starts inside home_i. Walls block hearing, so while an NPC is indoors the
 * chase steers for the open spot just outside that home's doorway instead of the NPC itself. Each
 * home paints an 8 by 7 footprint anchored at `rect`; `door` is 1.2 m outside its doorway centre.
 */
const HOMES = [
  { rect: { x: 72, y: 2 }, door: { x: 80.7, y: 5 } },
  { rect: { x: 87, y: 74 }, door: { x: 86.3, y: 77 } },
  { rect: { x: 3, y: 18 }, door: { x: 11.7, y: 21 } },
  { rect: { x: 16, y: 39 }, door: { x: 15.3, y: 42 } },
  { rect: { x: 29, y: 79 }, door: { x: 33, y: 78.3 } },
] as const
const HOME_SIZE = { width: 8, height: 7 }

/** Ignore an axis this close to the target so the walker does not oscillate across it. */
const AXIS_DEADBAND = 0.25

const BROADCAST_TEXT = 'good morning three branches'

interface Point {
  x: number
  y: number
}

/** The visitor's latest landed position in village metres, from the renderer's probe. */
async function visitorPosition(host: Locator): Promise<Point> {
  const probe = await host.getAttribute('data-three-branches-visitor')
  const match = /^(-?\d+),(-?\d+)$/.exec(probe ?? '')
  if (match === null) throw new Error(`Three Branches visitor probe is not a position: ${probe}`)
  return { x: Number(match[1]) / 100, y: Number(match[2]) / 100 }
}

/**
 * Held movement keys, adjusted toward a target direction each beat. W is due north, which is +y in
 * the village frame, and diagonal directions hold two keys at once. Every steer re-presses the
 * keys it wants even when they are already down: the renderer drops all held keys on a window
 * blur, and the repeat keydown a re-press dispatches re-enters the renderer's held set, so a
 * stray blur costs at most one beat of movement instead of the rest of the walk.
 */
class KeyboardWalk {
  private readonly held = new Set<string>()

  constructor(private readonly page: Page) {}

  async steer(dx: number, dy: number): Promise<void> {
    const want = new Set<string>()
    if (dy > AXIS_DEADBAND) want.add('KeyW')
    if (dy < -AXIS_DEADBAND) want.add('KeyS')
    if (dx > AXIS_DEADBAND) want.add('KeyD')
    if (dx < -AXIS_DEADBAND) want.add('KeyA')
    for (const code of [...this.held]) {
      if (!want.has(code)) {
        await this.page.keyboard.up(code)
        this.held.delete(code)
      }
    }
    for (const code of want) {
      await this.page.keyboard.down(code)
      this.held.add(code)
    }
  }

  async stop(): Promise<void> {
    for (const code of [...this.held]) {
      await this.page.keyboard.up(code)
    }
    this.held.clear()
  }
}

interface WalkDiagnostics {
  states: number
  windows: number
  blurs: number
  elapsedMs: number
  visibility: string
  focused: boolean
}

/** Start counting landed states, sent windows, and window blurs for one walk. */
async function startWalkDiagnostics(page: Page): Promise<void> {
  await page.evaluate(() => {
    const host = document.querySelector<HTMLElement>('.renderer-host')
    if (host === null) throw new Error('Three Branches renderer host is missing')
    const probe = globalThis as typeof globalThis & {
      tbWalkDiag?: { states: number; windows: number; blurs: number; startedMs: number }
      tbWalkObserver?: MutationObserver
      tbWalkBlur?: () => void
    }
    probe.tbWalkObserver?.disconnect()
    if (probe.tbWalkBlur !== undefined) window.removeEventListener('blur', probe.tbWalkBlur)
    const diag = { states: 0, windows: 0, blurs: 0, startedMs: performance.now() }
    probe.tbWalkDiag = diag
    probe.tbWalkObserver = new MutationObserver((records) => {
      for (const record of records) {
        if (record.attributeName === 'data-three-branches-visitor') diag.states += 1
        if (record.attributeName === 'data-three-branches-last-action') diag.windows += 1
      }
    })
    probe.tbWalkObserver.observe(host, {
      attributes: true,
      attributeFilter: ['data-three-branches-visitor', 'data-three-branches-last-action'],
    })
    probe.tbWalkBlur = () => {
      diag.blurs += 1
    }
    window.addEventListener('blur', probe.tbWalkBlur)
  })
}

/** Stop the walk counters and report them, so a failed walk names its cause. */
async function collectWalkDiagnostics(page: Page): Promise<WalkDiagnostics> {
  return page.evaluate(() => {
    const probe = globalThis as typeof globalThis & {
      tbWalkDiag?: { states: number; windows: number; blurs: number; startedMs: number }
      tbWalkObserver?: MutationObserver
      tbWalkBlur?: () => void
    }
    probe.tbWalkObserver?.disconnect()
    if (probe.tbWalkBlur !== undefined) window.removeEventListener('blur', probe.tbWalkBlur)
    const diag = probe.tbWalkDiag ?? {
      states: 0,
      windows: 0,
      blurs: 0,
      startedMs: performance.now(),
    }
    return {
      states: diag.states,
      windows: diag.windows,
      blurs: diag.blurs,
      elapsedMs: performance.now() - diag.startedMs,
      visibility: document.visibilityState,
      focused: document.hasFocus(),
    }
  })
}

/**
 * Walk the visitor to a fixed village point. The straight approach can pin against a wall or a
 * wandering NPC body (a head-on contact between characters stalls both while the steering keeps
 * pushing straight at the target), so progress is watched over a rolling window: advancing less
 * than 0.3 m across 2 seconds walks a detour roughly 75 degrees off the target bearing for about
 * a second, alternating sides on repeated stalls, then resumes the straight aim. Everything stays
 * inside the one deadline, and a timeout reports the observed state, send, and blur rates so a
 * cadence problem and a physical block read differently.
 */
async function walkTo(
  page: Page,
  host: Locator,
  walk: KeyboardWalk,
  target: Point,
  toleranceM: number,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  await startWalkDiagnostics(page)
  let windowStart = await visitorPosition(host)
  let windowStartedAt = Date.now()
  let detourSide = 1
  for (;;) {
    const position = await visitorPosition(host)
    const dx = target.x - position.x
    const dy = target.y - position.y
    if (Math.hypot(dx, dy) <= toleranceM) {
      await walk.stop()
      await collectWalkDiagnostics(page)
      return
    }
    if (Date.now() > deadline) {
      await walk.stop()
      const diag = await collectWalkDiagnostics(page)
      throw new Error(
        `the visitor did not reach (${target.x}, ${target.y}); it stands at ` +
          `(${position.x}, ${position.y}) after ${Math.round(diag.elapsedMs)}ms with ` +
          `${diag.states} landed states, ${diag.windows} sent windows, ${diag.blurs} blurs, ` +
          `visibility ${diag.visibility}, focused ${diag.focused}`,
      )
    }
    if (Date.now() - windowStartedAt >= 2_000) {
      const advanced = Math.hypot(position.x - windowStart.x, position.y - windowStart.y)
      if (advanced < 0.3) {
        const angle = (detourSide * 75 * Math.PI) / 180
        detourSide = -detourSide
        await walk.steer(
          dx * Math.cos(angle) - dy * Math.sin(angle),
          dx * Math.sin(angle) + dy * Math.cos(angle),
        )
        await page.waitForTimeout(1_000)
      }
      windowStart = await visitorPosition(host)
      windowStartedAt = Date.now()
      continue
    }
    await walk.steer(dx, dy)
    await page.waitForTimeout(250)
  }
}

/**
 * Track every character's latest landed position straight from the state frames the session socket
 * delivers. The overlay carries all of them, while the renderer probes only the visitor, and the
 * direct-line hunt needs to know where the NPCs are. Must be wired before the page navigates.
 */
function trackCharacters(page: Page): () => ReadonlyMap<string, Point> {
  const latest = new Map<string, Point>()
  page.on('websocket', (socket) => {
    socket.on('framereceived', ({ payload }) => {
      if (typeof payload !== 'string') return
      try {
        const frame = JSON.parse(payload) as {
          overlay?: { characters?: { id?: unknown; x?: unknown; y?: unknown }[] }
        }
        for (const character of frame.overlay?.characters ?? []) {
          if (
            typeof character.id === 'string' &&
            typeof character.x === 'number' &&
            typeof character.y === 'number'
          ) {
            latest.set(character.id, { x: character.x, y: character.y })
          }
        }
      } catch {
        // Status envelopes and other non-state frames are not tracked.
      }
    })
  })
  return () => latest
}

/** Where to walk to get within hearing of one NPC right now: it, or its home's doorway. */
function nearestNpcGoal(characters: ReadonlyMap<string, Point>, visitor: Point): Point | null {
  let best: Point | null = null
  let bestDistance = Number.POSITIVE_INFINITY
  for (const [id, at] of characters) {
    if (!id.startsWith('npc_')) continue
    const home = HOMES[Number(id.slice(4))]
    const indoors =
      home !== undefined &&
      at.x >= home.rect.x &&
      at.x <= home.rect.x + HOME_SIZE.width &&
      at.y >= home.rect.y &&
      at.y <= home.rect.y + HOME_SIZE.height
    const goal = indoors && home !== undefined ? home.door : at
    const distance = Math.hypot(goal.x - visitor.x, goal.y - visitor.y)
    if (distance < bestDistance) {
      bestDistance = distance
      best = goal
    }
  }
  return best
}

/** The non-Everyone addressees the recipient select currently offers. */
async function recipientOptions(recipient: Locator): Promise<{ value: string; label: string }[]> {
  return recipient.evaluate((element) =>
    Array.from((element as HTMLSelectElement).options)
      .filter((option) => option.value !== '')
      .map((option) => ({ value: option.value, label: (option.textContent ?? '').trim() })),
  )
}

/** Drop focus from the chat controls so movement keys reach the renderer again. */
async function blurActive(page: Page): Promise<void> {
  await page.evaluate(() => {
    const active = document.activeElement
    if (active instanceof HTMLElement) active.blur()
  })
}

/**
 * Record every value the queued-expression probe takes, with attribute old values, so a press that
 * queues and drains within one 250 ms window is still observed.
 */
async function watchQueuedProbe(page: Page): Promise<void> {
  await page.evaluate(() => {
    const host = document.querySelector<HTMLElement>('.renderer-host')
    if (host === null) throw new Error('Three Branches renderer host is missing')
    const probe = globalThis as typeof globalThis & {
      tbQueuedObserver?: MutationObserver
      tbQueuedSamples?: string[]
    }
    probe.tbQueuedObserver?.disconnect()
    probe.tbQueuedSamples = [host.dataset.threeBranchesQueued ?? 'missing']
    probe.tbQueuedObserver = new MutationObserver((records) => {
      for (const record of records) {
        probe.tbQueuedSamples?.push(record.oldValue ?? 'missing')
      }
      probe.tbQueuedSamples?.push(host.dataset.threeBranchesQueued ?? 'missing')
    })
    probe.tbQueuedObserver.observe(host, {
      attributes: true,
      attributeFilter: ['data-three-branches-queued'],
      attributeOldValue: true,
    })
  })
}

async function queuedProbeSamples(page: Page): Promise<string[]> {
  return page.evaluate(async () => {
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
    )
    const probe = globalThis as typeof globalThis & {
      tbQueuedObserver?: MutationObserver
      tbQueuedSamples?: string[]
    }
    probe.tbQueuedObserver?.disconnect()
    return probe.tbQueuedSamples ?? []
  })
}

/**
 * Queue one expression and prove the next composed window sent its action id. The queued probe is
 * sampled through a mutation observer because the queue can drain within one send window, faster
 * than a polled attribute read can catch.
 */
async function sendExpression(
  page: Page,
  host: Locator,
  token: string,
  actionId: number,
  trigger: () => Promise<void>,
): Promise<void> {
  await watchQueuedProbe(page)
  await trigger()
  await expect
    .poll(async () => host.getAttribute('data-three-branches-last-action'), { timeout: 10_000 })
    .toMatch(new RegExp(`,${actionId}$`))
  const samples = await queuedProbeSamples(page)
  expect(samples, `the ${token} press should surface on the queued probe`).toContain(token)
  expect(samples.at(-1), 'the queue should drain after the send window').toBe('none')
}

test('a human visitor walks, emotes, previews a use, and chats across watcher and replay', async ({
  page,
  browser,
  admin,
  as,
}) => {
  // A live container, two browser contexts, a bounded NPC hunt, and a replay revisit all in one
  // journey. The hunt alone may take a minute or two, since NPC motion is not seed-deterministic.
  test.setTimeout(300_000)

  const characters = trackCharacters(page)
  const sessionId = await startSession(
    admin,
    ENV_ID,
    {
      seat_0: { kind: 'builtin-agent', name: 'naive' },
      seat_1: { kind: 'human' },
    },
    // The hunt's HOMES table and the doorway points below are cast_5 seed-0 facts, so pin the plan
    // explicitly rather than inheriting the season defaults.
    { seed: SEED, parameters: { seat_plan: 'cast_5', daynight: false } },
  )
  let spectatorContext: BrowserContext | null = null

  try {
    await authenticateBrowser(page.context(), admin)
    await page.goto(`/sessions/${sessionId}`)
    const canvas = page.locator('canvas.renderer-canvas')
    const host = page.locator('.renderer-host')
    await expect(canvas).toBeVisible({ timeout: 60_000 })
    await expect(host).toHaveAttribute('data-three-branches-input', 'ready')
    await expect(host).toHaveAttribute('data-three-branches-joystick', /^\d+,\d+$/)
    await expect(host).toHaveAttribute('data-three-branches-camera', /^\d+(?:\.\d+)?@-?\d+,-?\d+$/)
    await expect(host).toHaveAttribute('data-three-branches-visitor', /^-?\d+,-?\d+$/)
    // The palette publishes its geometry probes only while this screen controls the visitor.
    await expect(host).toHaveAttribute('data-three-branches-use-button', /^\d+,\d+,\d+,\d+$/)
    // Layout can still settle after mount (panels arriving beside the stage), so every pointer
    // interaction reads the canvas bounds fresh instead of trusting one early snapshot.
    const canvasBounds = async () => {
      const box = await canvas.boundingBox()
      if (box === null) throw new Error('Three Branches canvas has no browser bounds')
      return box
    }

    // A spectator attaches before any message is sent, so its live panel accumulates the whole
    // exchange. It gets the same renderer with no input: no controls probe beyond the inert 'none'
    // marker, no palette geometry, and a read-only chat log.
    spectatorContext = await browser.newContext()
    await authenticateBrowser(spectatorContext, await as(SPECTATOR))
    const spectator = await spectatorContext.newPage()
    await spectator.goto(page.url())
    await expect(spectator.locator('canvas.renderer-canvas')).toBeVisible({ timeout: 60_000 })
    const spectatorHost = spectator.locator('.renderer-host')
    await expect(spectatorHost).toHaveAttribute('data-three-branches-input', 'none')
    await expect(spectatorHost).not.toHaveAttribute('data-three-branches-use-button')
    await expect(spectatorHost).not.toHaveAttribute('data-three-branches-emote-wave')
    await expect(spectatorHost).not.toHaveAttribute('data-three-branches-queued')
    const spectatorChat = spectator.getByRole('group', { name: 'Chat log' })
    await expect(spectatorChat).toBeVisible()
    await expect(spectatorChat.getByRole('textbox')).toHaveCount(0)

    // Opening the spectator page pushed the controller page to the background, where Chromium
    // throttles the renderer's 250 ms send loop to about one window a second and walking crawls.
    // A real player's tab is foreground, so restore that before driving input. The spectator's
    // chat log needs no timers: entries append as socket states arrive, which a background page
    // still receives.
    await page.bringToFront()

    // Keyboard locomotion. W composes due north at full speed, and the landed position probe
    // follows. Released keys compose the environment default, which the window deliberately does
    // not send, so the stale action probe keeps its last value and the position probe is the stop
    // signal.
    const walk = new KeyboardWalk(page)
    const start = await visitorPosition(host)
    const startingCamera = await host.getAttribute('data-three-branches-camera')
    // Each poll re-presses W: a stray window blur makes the renderer drop every held key, and the
    // repeat keydown of a re-press restores it (see KeyboardWalk).
    await page.keyboard.down('KeyW')
    await expect
      .poll(async () => {
        await page.keyboard.down('KeyW')
        return host.getAttribute('data-three-branches-last-action')
      })
      .toBe('90,1,0')
    await expect
      .poll(
        async () => {
          await page.keyboard.down('KeyW')
          return (await visitorPosition(host)).y
        },
        { timeout: 10_000 },
      )
      .toBeGreaterThan(start.y + 0.5)
    await expect
      .poll(async () => host.getAttribute('data-three-branches-camera'))
      .not.toBe(startingCamera)
    await page.keyboard.up('KeyW')
    await page.waitForTimeout(750)
    const rest = await visitorPosition(host)
    await page.waitForTimeout(600)
    const still = await visitorPosition(host)
    expect(Math.hypot(still.x - rest.x, still.y - rest.y)).toBeLessThan(0.05)

    // The expression palette, once by hotkey and once by plate click. Wave is action id 2 and
    // shake_head id 4, in ruleset order after use.
    await sendExpression(page, host, 'wave', 2, () => page.keyboard.press('Digit1'))
    await sendExpression(page, host, 'shake_head', 4, async () => {
      const plate = await controlCentre(
        host,
        'data-three-branches-emote-shake-head',
        await canvasBounds(),
      )
      await page.mouse.click(plate.x, plate.y)
    })

    // The use preview. At the spawn no prop is within the 1.5 m reach, so a held hover answers
    // none. The hover then stays put while the keyboard walks the visitor to the bell, and the
    // preview re-answers on each landed frame until it names the bell.
    const useBox = await canvasBounds()
    const usePlate = await controlCentre(host, 'data-three-branches-use-button', useBox)
    await page.mouse.move(usePlate.x, usePlate.y)
    await page.waitForTimeout(600)
    await expect(host).toHaveAttribute('data-three-branches-use-preview', 'none')
    await walkTo(page, host, walk, BELL_STOP, 0.35, 60_000)
    await expect
      .poll(async () => host.getAttribute('data-three-branches-use-preview'))
      .toBe(BELL_ID)
    // Leaving the plate clears the preview and its highlight.
    await page.mouse.move(useBox.x + useBox.width / 2, useBox.y + useBox.height / 2)
    await expect(host).toHaveAttribute('data-three-branches-use-preview', 'none')

    // A broadcast echoes back into the visitor's own transcript from the recorded line: there is
    // no local echo, so the row appearing proves the round trip through the relay. The village
    // display names ride the row and its badge.
    const controllerChat = page.getByRole('group', { name: 'Chat', exact: true })
    await expect(controllerChat).toBeVisible()
    const message = controllerChat.getByLabel('Message')
    const recipient = controllerChat.getByLabel('Recipient')
    const sendButton = controllerChat.getByRole('button', { name: 'Send' })
    await recipient.selectOption('')
    await message.fill(BROADCAST_TEXT)
    await sendButton.click()
    const broadcastRow = controllerChat.locator('.chat-entry', { hasText: BROADCAST_TEXT })
    await expect(broadcastRow).toBeVisible({ timeout: 30_000 })
    await expect(broadcastRow).toContainText('visitor')
    await expect(broadcastRow).toContainText('from you')
    await blurActive(page)

    // The direct line. An addressee is offered only while an NPC stands within 6 m hearing with an
    // unblocked line, and the naive NPCs wander on fresh entropy, so the visitor hunts: steer for
    // the most reachable NPC (or the doorway of its home while it is indoors), and try to send the
    // moment the recipient select offers anyone. A policy change can reset the select to Everyone
    // mid-send and a stale addressee is dropped by the relay, so every attempt is verified on the
    // spectator, who sees every delivered line, and retried with fresh text otherwise.
    let direct: { text: string; label: string } | null = null
    let attempts = 0
    let sawOption = false
    const searchDeadline = Date.now() + 120_000
    while (direct === null) {
      if (Date.now() > searchDeadline) {
        await walk.stop()
        const roster = [...characters().entries()]
          .filter(([id]) => id.startsWith('npc_'))
          .map(([id, at]) => `${id}@${at.x.toFixed(1)},${at.y.toFixed(1)}`)
          .join(' ')
        throw new Error(
          `no direct line landed within the bounded hunt (attempts=${attempts}, ` +
            `sawAddressee=${sawOption}, npcs: ${roster})`,
        )
      }
      const options = await recipientOptions(recipient)
      const choice = options[0]
      if (choice === undefined) {
        const visitor = await visitorPosition(host)
        const goal = nearestNpcGoal(characters(), visitor)
        if (goal === null) {
          await page.waitForTimeout(300)
          continue
        }
        await walk.steer(goal.x - visitor.x, goal.y - visitor.y)
        await page.waitForTimeout(300)
        continue
      }
      sawOption = true
      await walk.stop()
      attempts += 1
      const text = `a word for ${choice.label}, take ${attempts}`
      await message.fill(text)
      try {
        await recipient.selectOption(choice.value, { timeout: 2_000 })
      } catch {
        // The addressee left the policy before it could be picked. Hunt on.
        await blurActive(page)
        continue
      }
      await sendButton.click()
      await blurActive(page)
      const spectatorRow = spectatorChat.locator('.chat-entry', { hasText: text })
      try {
        await expect(spectatorRow).toBeVisible({ timeout: 6_000 })
      } catch {
        continue // Dropped at the boundary. Hunt on.
      }
      if ((await spectatorRow.getByText(`to ${choice.label}`).count()) > 0) {
        direct = { text, label: choice.label }
      }
      // A row that arrived as a broadcast lost the recipient to a policy reset. Hunt on.
    }
    // The visitor's own panel carries its direct send too.
    const directRow = controllerChat.locator('.chat-entry', { hasText: direct.text })
    await expect(directRow).toBeVisible()
    await expect(directRow).toContainText('from you')

    // Watcher completeness: the spectator's live log holds the broadcast and the direct line with
    // its village-named to-badge. The direct row was already matched during the hunt.
    const spectatorBroadcast = spectatorChat.locator('.chat-entry', { hasText: BROADCAST_TEXT })
    await expect(spectatorBroadcast).toBeVisible()
    await expect(spectatorBroadcast).toContainText('broadcast')
    const spectatorDirect = spectatorChat.locator('.chat-entry', { hasText: direct.text })
    await expect(spectatorDirect).toContainText(`to ${direct.label}`)
    await spectatorContext.close()
    spectatorContext = null

    // Stop, then replay. The merged game thread reveals messages up to the transport position, so
    // the journey seeks the end before asserting the complete transcript.
    await page.getByRole('button', { name: 'Stop' }).click()
    const openReplay = page.getByRole('link', { name: 'Open replay' })
    await expect(openReplay).toBeVisible({ timeout: 60_000 })
    const ended = await getSession(admin, sessionId)
    if (ended?.recording_id === null || ended?.recording_id === undefined) {
      throw new Error('Three Branches session ended without a recording')
    }
    await openReplay.click()
    await expect(page).toHaveURL(`/replays/${ended.recording_id}`)
    const replayHost = page.locator('.renderer-host')
    await expect(page.locator('canvas.renderer-canvas')).toBeVisible({ timeout: 60_000 })
    await expect(replayHost).toHaveAttribute('data-three-branches-ground', 'ready')
    // A replay viewer has no input: the inert marker and no palette geometry.
    await expect(replayHost).toHaveAttribute('data-three-branches-input', 'none')
    await expect(replayHost).not.toHaveAttribute('data-three-branches-use-button')
    await expect(replayHost).not.toHaveAttribute('data-three-branches-emote-wave')

    const slider = page.getByRole('slider', { name: 'Replay position' })
    await expect(slider).toBeVisible()
    await slider.focus()
    await slider.press('End')
    const replayThread = page.getByRole('group', { name: 'Game thread' })
    const threadBroadcast = replayThread.locator('.thread-item--message', {
      hasText: BROADCAST_TEXT,
    })
    await expect(threadBroadcast).toBeVisible()
    await expect(threadBroadcast).toContainText('broadcast')
    const threadDirect = replayThread.locator('.thread-item--message', { hasText: direct.text })
    await expect(threadDirect).toBeVisible()
    await expect(threadDirect).toContainText(`to ${direct.label}`)
    await expect(replayThread.getByRole('textbox')).toHaveCount(0)
  } finally {
    await spectatorContext?.close().catch(() => {})
    await stopSessionAndAwaitFree(admin, sessionId).catch(() => {})
  }
})
