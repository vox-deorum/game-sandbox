import { Container, Text } from 'pixi.js'
import { describe, expect, it } from 'vitest'
import { THREE_BRANCHES_PRESENTATION } from '../core/presentation.js'
import { fixtureRecording, openingState, testText } from '../core/test-helpers.js'
import type { FrameScene } from '../core/types.js'
import { buildStaticScene, computeScene } from '../map/scene.js'
import {
  bellText,
  COLLISION_TOGGLE_RECT,
  collisionText,
  createChrome,
  RECENTER_RECT,
  statusText,
} from './chrome.js'
import { expectedCharacterIds, readStatic } from './overlay.js'

const { header, states } = fixtureRecording()
const village = readStatic(header)
const staticScene = buildStaticScene(village)
const roster = expectedCharacterIds(header)

const openingScene = computeScene(openingState(), staticScene, roster)
const frameScene = computeScene(states[0] as (typeof states)[number], staticScene, roster)
const terminalScene = computeScene(states.at(-1) as (typeof states)[number], staticScene, roster)

const bellProp = village.props.find((prop) => prop.type === 'bell')
if (bellProp === undefined) throw new Error('the fixture village has no bell to exercise.')
const bellPropId: string = bellProp.id

// The bell's recorded state is set here rather than read off the fixture, so a recording that
// never happens to ring the bell cannot quietly leave the ringing case asserting nothing.
function withBellState(scene: FrameScene, state: string): FrameScene {
  if (scene.dynamic === null) throw new Error('cannot set a bell state before a frame lands.')
  return {
    ...scene,
    dynamic: { ...scene.dynamic, props: { ...scene.dynamic.props, [bellPropId]: state } },
  }
}

const staticSceneWithoutBell = buildStaticScene({
  ...village,
  props: village.props.filter((prop) => prop.type !== 'bell'),
})
const sceneWithoutBell = computeScene(
  states[0] as (typeof states)[number],
  staticSceneWithoutBell,
  roster,
)

describe('Three Branches chrome strip', () => {
  describe('statusText', () => {
    it('reads the opening fallback before any frame lands', () => {
      expect(statusText(openingScene, 7)).toBe('Opening · Tick 7')
    })

    it('reads phase and tick for an ordinary frame', () => {
      const dynamic = frameScene.dynamic
      if (dynamic === null)
        throw new Error('the fixture should carry an overlay on its first frame.')
      expect(dynamic.terminal).toBe(false)
      const dayScene = { ...frameScene, dynamic: { ...dynamic, phase: 'day' } }
      expect(statusText(dayScene, 999)).toBe(`Day · Tick ${dynamic.tick}`)
    })

    it('appends Complete on the terminal frame', () => {
      const dynamic = terminalScene.dynamic
      if (dynamic === null) throw new Error('the fixture should end on a terminal overlay frame.')
      expect(dynamic.terminal).toBe(true)
      expect(statusText(terminalScene, 999)).toBe(
        `${dynamic.phase.charAt(0).toUpperCase()}${dynamic.phase.slice(1)} · Tick ${dynamic.tick} · Complete`,
      )
    })
  })

  describe('bellText', () => {
    it('returns the ringing word while the bell rings', () => {
      expect(bellText(withBellState(frameScene, 'ringing'))).toBe('rings')
    })

    it('returns the silent word while the bell is silent', () => {
      expect(bellText(withBellState(frameScene, 'silent'))).toBe('silent')
    })

    it('tolerates an unrecognized state by reading it as silent', () => {
      expect(bellText(withBellState(frameScene, 'shattered'))).toBe('silent')
    })

    it('returns null when the static village has no bell', () => {
      expect(bellText(sceneWithoutBell)).toBeNull()
    })

    it('returns null before any dynamic frame lands', () => {
      expect(bellText(openingScene)).toBeNull()
    })
  })

  describe('collisionText', () => {
    it('labels the on state', () => {
      expect(collisionText(true)).toBe('Collision: On')
    })

    it('labels the off state', () => {
      expect(collisionText(false)).toBe('Collision: Off')
    })
  })

  describe('control rects', () => {
    it('sit inside the strip', () => {
      for (const rect of [RECENTER_RECT, COLLISION_TOGGLE_RECT]) {
        expect(rect.y).toBeGreaterThanOrEqual(0)
        expect(rect.y + rect.height).toBeLessThanOrEqual(THREE_BRANCHES_PRESENTATION.chromeHeight)
        expect(rect.x + rect.width).toBeLessThanOrEqual(
          THREE_BRANCHES_PRESENTATION.internalSize.width,
        )
      }
    })

    it('do not overlap each other', () => {
      const separated =
        RECENTER_RECT.x + RECENTER_RECT.width <= COLLISION_TOGGLE_RECT.x ||
        COLLISION_TOGGLE_RECT.x + COLLISION_TOGGLE_RECT.width <= RECENTER_RECT.x
      expect(separated).toBe(true)
    })
  })

  it('builds the retained strip and updates it across frames without throwing', () => {
    const layer = new Container()
    const chrome = createChrome(layer, testText)
    expect(() => chrome.update(openingScene, 3, false, 1)).not.toThrow()
    expect(() => chrome.update(withBellState(frameScene, 'ringing'), 5, true, 2)).not.toThrow()
    expect(() => chrome.update(sceneWithoutBell, 6, false, 1)).not.toThrow()
    expect(() => chrome.update(terminalScene, 7, true, 1)).not.toThrow()
    const labels = layer.children.filter((child): child is Text => child instanceof Text)
    expect(labels).toHaveLength(4)
    expect(labels.every((label) => label.resolution === 1)).toBe(true)
    expect(labels.every((label) => label.style.fontSize === 20)).toBe(true)
  })
})
