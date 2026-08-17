import { Container, Text } from 'pixi.js'
import { describe, expect, it } from 'vitest'
import { THREE_BRANCHES_PRESENTATION } from '../core/presentation.js'
import { fixtureRecording, testText } from '../core/test-helpers.js'
import type { FrameScene, SpeechLine } from '../core/types.js'
import { buildStaticScene, computeScene } from '../map/scene.js'
import {
  createAnnotationLayer,
  nameplateAlpha,
  speechAlpha,
  speechTag,
  wrapSpeech,
} from './annotations.js'
import { expectedCharacterIds, readStatic } from './overlay.js'

const { nameplateZoomFactor, nameplateFadeFactor, speechHoldMs, speechFadeMs, speechMaxLines } =
  THREE_BRANCHES_PRESENTATION

/** A real recorded frame, so reconcile exercises production-shaped characters rather than a stub. */
function fixtureScene(): FrameScene {
  const { header, states } = fixtureRecording()
  const staticScene = buildStaticScene(readStatic(header))
  const roster = expectedCharacterIds(header)
  return computeScene(states[0] as (typeof states)[number], staticScene, roster)
}

function speechLine(overrides: Partial<SpeechLine> & { key: string; speaker: string }): SpeechLine {
  return { addressee: null, text: 'hello there', ...overrides }
}

/** Every Text node's current string, gathered from anywhere in the layer's display tree. */
function collectText(node: Container): string[] {
  return collectTextNodes(node).map((text) => text.text)
}

function collectTextNodes(node: Container): Text[] {
  const found: Text[] = []
  for (const child of node.children) {
    if (child instanceof Text) found.push(child)
    found.push(...collectTextNodes(child as Container))
  }
  return found
}

describe('nameplateAlpha', () => {
  const fittedZoom = 2

  it('is zero at and below the fade floor', () => {
    const floor = fittedZoom * (nameplateZoomFactor - nameplateFadeFactor)
    expect(nameplateAlpha(floor, fittedZoom)).toBe(0)
    expect(nameplateAlpha(floor - 1, fittedZoom)).toBe(0)
  })

  it('is one at and above the full-plate zoom', () => {
    const full = fittedZoom * nameplateZoomFactor
    expect(nameplateAlpha(full, fittedZoom)).toBe(1)
    expect(nameplateAlpha(full + 5, fittedZoom)).toBe(1)
  })

  it('increases strictly across the fade band', () => {
    const floor = fittedZoom * (nameplateZoomFactor - nameplateFadeFactor)
    const full = fittedZoom * nameplateZoomFactor
    const step = (full - floor) / 4
    const low = nameplateAlpha(floor + step, fittedZoom)
    const mid = nameplateAlpha(floor + step * 2, fittedZoom)
    const high = nameplateAlpha(floor + step * 3, fittedZoom)
    expect(low).toBeGreaterThan(0)
    expect(high).toBeLessThan(1)
    expect(mid).toBeGreaterThan(low)
    expect(high).toBeGreaterThan(mid)
  })
})

describe('wrapSpeech', () => {
  it('keeps a short line on one line', () => {
    expect(wrapSpeech('Fine morning, no?', 24, 4)).toEqual(['Fine morning, no?'])
  })

  it('wraps a long line on whitespace within the budget', () => {
    const wrapped = wrapSpeech('the quick brown fox jumps over', 10, 4)
    expect(wrapped).toEqual(['the quick', 'brown fox', 'jumps over'])
    expect(wrapped.every((line) => line.length <= 10)).toBe(true)
  })

  it('breaks a single word longer than the budget', () => {
    const wrapped = wrapSpeech('abcdefghijklmno', 10, 4)
    expect(wrapped).toEqual(['abcdefghij', 'klmno'])
  })

  it('counts Unicode code points without splitting an emoji', () => {
    const text = `${'a'.repeat(23)}😀`
    expect(wrapSpeech(text, 24, 4)).toEqual([text])
  })

  it('elides overflow past the line budget and marks the last kept line', () => {
    const wrapped = wrapSpeech('one two three four five six seven eight nine', 5, 2)
    expect(wrapped).toHaveLength(2)
    expect(wrapped.at(-1)).toMatch(/…$/)
    expect(wrapped.join(' ')).not.toContain('seven')
  })

  it('elides at a Unicode code-point boundary', () => {
    expect(wrapSpeech('ab😀x next', 4, 1)).toEqual(['ab😀…'])
  })
})

describe('speechAlpha', () => {
  it('is full through the hold', () => {
    expect(speechAlpha(0)).toBe(1)
    expect(speechAlpha(speechHoldMs)).toBe(1)
  })

  it('is zero at and past hold plus fade', () => {
    expect(speechAlpha(speechHoldMs + speechFadeMs)).toBe(0)
    expect(speechAlpha(speechHoldMs + speechFadeMs + 500)).toBe(0)
  })

  it('decreases strictly across the fade', () => {
    const early = speechAlpha(speechHoldMs + speechFadeMs * 0.25)
    const mid = speechAlpha(speechHoldMs + speechFadeMs * 0.5)
    const late = speechAlpha(speechHoldMs + speechFadeMs * 0.75)
    expect(early).toBeGreaterThan(mid)
    expect(mid).toBeGreaterThan(late)
    expect(late).toBeGreaterThan(0)
  })
})

describe('speechTag', () => {
  it('tags a direct line with its addressee', () => {
    expect(speechTag(speechLine({ key: 'a', speaker: 'player_0', addressee: 'player_3' }))).toBe(
      'to player_3',
    )
  })

  it('leaves a broadcast untagged', () => {
    expect(speechTag(speechLine({ key: 'a', speaker: 'player_0', addressee: null }))).toBeNull()
  })
})

describe('createAnnotationLayer', () => {
  it('reconciles one node per character and removes a node whose character left the frame', () => {
    const layer = new Container()
    const annotations = createAnnotationLayer(layer, testText)
    const scene = fixtureScene()
    annotations.reconcile(scene, 4, 2, 1)
    expect(layer.children).toHaveLength(scene.characters.length)
    expect(collectText(layer)).toContain('player_0')
    expect(collectTextNodes(layer).find((text) => text.text === 'player_0')?.style.fontSize).toBe(
      14,
    )

    const firstCharacter = scene.characters[0]
    if (firstCharacter === undefined) throw new Error('Fixture scene has no characters.')
    const playerTen: FrameScene = {
      ...scene,
      characters: [...scene.characters, { ...firstCharacter, id: 'player_10' }],
    }
    annotations.reconcile(playerTen, 4, 2, 1)
    expect(collectText(layer)).toContain('player_10')

    const trimmed: FrameScene = {
      ...scene,
      characters: scene.characters.filter((character) => character.id !== 'player_0'),
    }
    annotations.reconcile(trimmed, 4, 2, 1)
    expect(layer.children).toHaveLength(trimmed.characters.length)
    expect(collectText(layer)).not.toContain('player_0')
  })

  it('ignores a repeated key, so a second delivery of the same line does not restart its age', () => {
    const layer = new Container()
    const annotations = createAnnotationLayer(layer, testText)
    annotations.deliver([speechLine({ key: 'a', speaker: 'player_0', text: 'first line' })])
    expect(annotations.advance(3000)).toBe(true)
    // Same key again: a naive implementation that restarted the age would still be visible below.
    annotations.deliver([speechLine({ key: 'a', speaker: 'player_0', text: 'first line' })])
    expect(annotations.advance(2000)).toBe(false)
  })

  it('does not restart the final bubble when a multi-line state is delivered again', () => {
    const layer = new Container()
    const annotations = createAnnotationLayer(layer, testText)
    const lines = [
      speechLine({ key: 'a', speaker: 'player_0', text: 'broadcast' }),
      speechLine({ key: 'b', speaker: 'player_0', text: 'direct' }),
    ]
    annotations.deliver(lines)
    expect(annotations.advance(speechHoldMs + speechFadeMs - 1)).toBe(true)
    annotations.deliver(lines)
    expect(annotations.advance(1)).toBe(false)
  })

  it('replaces a speaker’s bubble with a newer line and restarts its age', () => {
    const layer = new Container()
    const annotations = createAnnotationLayer(layer, testText)
    const scene = fixtureScene()
    annotations.deliver([speechLine({ key: 'a', speaker: 'player_0', text: 'first line' })])
    annotations.reconcile(scene, 4, 2, 1)
    expect(collectText(layer)).toContain('first line')

    expect(annotations.advance(speechHoldMs - 1)).toBe(true)
    // A different key from the same speaker: the age must restart, or the next advance would drop it.
    annotations.deliver([speechLine({ key: 'b', speaker: 'player_0', text: 'second line' })])
    expect(annotations.advance(speechHoldMs - 1)).toBe(true)

    annotations.reconcile(scene, 4, 2, 1)
    const texts = collectText(layer)
    expect(texts).toContain('second line')
    expect(texts).not.toContain('first line')
  })

  it('drops every retained line and its remembered keys on clear, so the same key may be delivered again', () => {
    const layer = new Container()
    const annotations = createAnnotationLayer(layer, testText)
    const scene = fixtureScene()
    annotations.deliver([speechLine({ key: 'a', speaker: 'player_0', text: 'first line' })])
    annotations.clear()
    expect(annotations.advance(1)).toBe(false)

    annotations.deliver([speechLine({ key: 'a', speaker: 'player_0', text: 'again' })])
    annotations.reconcile(scene, 4, 2, 1)
    expect(collectText(layer)).toContain('again')
  })

  it('returns false from advance once every retained bubble has fully faded', () => {
    const layer = new Container()
    const annotations = createAnnotationLayer(layer, testText)
    annotations.deliver([speechLine({ key: 'a', speaker: 'player_0', text: 'first line' })])
    expect(annotations.advance(speechHoldMs)).toBe(true)
    expect(annotations.advance(speechFadeMs)).toBe(false)
  })

  it('keeps a bubble retained and aging even while its speaker is absent from the frame', () => {
    const layer = new Container()
    const annotations = createAnnotationLayer(layer, testText)
    const scene = fixtureScene()
    annotations.deliver([speechLine({ key: 'a', speaker: 'a-character-not-in-the-fixture' })])
    // Nothing to draw for the unknown speaker, but reconcile must not throw over it.
    expect(() => annotations.reconcile(scene, 4, 2, 1)).not.toThrow()
    expect(annotations.advance(speechHoldMs + speechFadeMs)).toBe(false)
  })

  it('wraps a delivered line to the configured speech line budget when drawn', () => {
    const layer = new Container()
    const annotations = createAnnotationLayer(layer, testText)
    const scene = fixtureScene()
    const longText = Array.from({ length: 20 }, (_, index) => `word${index}`).join(' ')
    annotations.deliver([speechLine({ key: 'a', speaker: 'player_0', text: longText })])
    annotations.reconcile(scene, 4, 2, 1)
    const bubbleText = collectText(layer).find((text) => text.includes('word0'))
    expect(bubbleText?.split('\n')).toHaveLength(speechMaxLines)
  })
})
