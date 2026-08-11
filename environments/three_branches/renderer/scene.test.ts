import { describe, expect, it } from 'vitest'

import propsData from '../props.json'
import rulesData from '../rules.json'
import { decodeDynamic, decodeStatic, type StaticOverlay } from './overlay.js'
import { computeScene, layoutKeyFor, PALETTE } from './scene.js'
import { header, states } from './test-helpers.js'

describe('Three Branches pure scene', () => {
  const staticOverlay = decodeStatic(header.overlay_static)

  it('reuses static drawables by decoded static reference and remains seek deterministic', () => {
    const first = computeScene(decodeDynamic(states[0], staticOverlay), staticOverlay)
    let revisit = first
    for (const state of states)
      revisit = computeScene(decodeDynamic(state, staticOverlay), staticOverlay)
    const repeated = computeScene(decodeDynamic(states[0], staticOverlay), staticOverlay)
    expect(repeated.static).toBe(first.static)
    expect(repeated.dynamic).toEqual(first.dynamic)
    expect(revisit.static).toBe(first.static)
  })

  it('uses the shared ground and prop labels', () => {
    expect(Object.keys(PALETTE.ground)).toEqual(rulesData.ground.map((item) => item.code))
    const scene = computeScene(decodeDynamic(states[0], staticOverlay), staticOverlay)
    expect(scene.static.tileRows).toHaveLength(100)
    for (const propType of propsData.props) {
      expect(scene.static.props.find((prop) => prop.type === propType.token)?.title).toBe(
        propType.title,
      )
    }
    expect(scene.dynamic.props).toHaveLength(staticOverlay.village.props.length)
  })

  it('retains exact open-building geometry for split lower and upper art layers', () => {
    const scene = computeScene(decodeDynamic(states[0], staticOverlay), staticOverlay)
    for (const building of scene.static.buildings) {
      expect(building.width).toBeGreaterThan(0)
      expect(building.depth).toBeGreaterThan(0)
      expect(building.doorway.width).toBe(1.2 * 16)
      expect(building.walls).toHaveLength(5)
    }
  })

  it('includes every decoded static-layout family in the dressing key', () => {
    const original = layoutKeyFor(staticOverlay)
    const variants = [
      changedStatic(staticOverlay, (overlay) => {
        const point = overlay.village.footpaths[0]?.points[0]
        if (point !== undefined) point.x += 0.01
      }),
      changedStatic(staticOverlay, (overlay) => {
        const bridge = overlay.village.bridges[0]
        if (bridge !== undefined) bridge.heading += 0.1
      }),
      changedStatic(staticOverlay, (overlay) => {
        overlay.village.spawn.y += 0.01
      }),
      changedStatic(staticOverlay, (overlay) => replaceGroundToken(overlay, 'field', 'open')),
      changedStatic(staticOverlay, (overlay) => replaceGroundToken(overlay, 'reeds', 'open')),
    ]
    expect(variants.map(layoutKeyFor)).not.toContain(original)
    expect(new Set(variants.map(layoutKeyFor)).size).toBe(variants.length)
  })

  it('labels every rules.json emote and every props.json state vocabulary', () => {
    const frame = clonedFrame()
    for (const [index, emote] of rulesData.emotes.entries()) {
      frame.d.c[0] = `${frame.d.c[0]?.slice(0, 11)}${index + 1}zz`
      expect(
        computeScene(decodeDynamic(frame, staticOverlay), staticOverlay).dynamic.characters[0]
          ?.expressionLabel,
      ).toBe(emote)
    }
    for (const propType of propsData.props) {
      const propIndex = staticOverlay.village.props.findIndex(
        (prop) => prop.type === propType.token,
      )
      expect(propIndex).toBeGreaterThanOrEqual(0)
      for (const [stateIndex, stateLabel] of propType.states.entries()) {
        frame.d.p = replaceCharacter(frame.d.p, propIndex, stateIndex.toString(36))
        const scene = computeScene(decodeDynamic(frame, staticOverlay), staticOverlay)
        expect(scene.dynamic.props[propIndex]?.stateLabel).toBe(stateLabel)
      }
    }
    expect(new Set(propsData.props.map((prop) => prop.transition.kind))).toEqual(
      new Set(['toggle', 'occupancy', 'timed', 'none']),
    )
  })

  it('builds chrome for every daynight phase, both bell states, and terminal frames', () => {
    const daynightHeader = structuredClone(header.overlay_static) as { v: number; s: { a: string } }
    daynightHeader.s.a = '51'
    const daynightStatic = decodeStatic(daynightHeader)
    const frame = clonedFrame()
    frame.d.z = '0'
    const bellIndex = staticOverlay.propIds.indexOf('bell_0')
    for (const phase of rulesData.phases) {
      frame.d.t = phase.start
      expect(
        computeScene(decodeDynamic(frame, daynightStatic), daynightStatic).dynamic.chrome.phase,
      ).toBe(`Phase: ${phase.name}`)
    }
    frame.d.t = rulesData.phases[0]?.start ?? 1
    for (const [stateIndex, state] of ['ringing', 'silent'].entries()) {
      frame.d.p = replaceCharacter(frame.d.p, bellIndex, stateIndex.toString(36))
      expect(
        computeScene(decodeDynamic(frame, daynightStatic), daynightStatic).dynamic.chrome.bell,
      ).toBe(`Bell: ${state}`)
    }
    frame.d.t = 1200
    frame.d.z = '1'
    expect(
      computeScene(decodeDynamic(frame, daynightStatic), daynightStatic).dynamic.chrome.terminal,
    ).toBe('The day is complete')
  })

  it('computes every recorded frame within the scene budget', () => {
    const started = performance.now()
    for (const state of states) computeScene(decodeDynamic(state, staticOverlay), staticOverlay)
    expect(performance.now() - started).toBeLessThan(1_000)
  })
})

function clonedFrame(): { v: number; d: { t: number; c: string[]; p: string; z: string } } {
  return structuredClone(states[0]) as {
    v: number
    d: { t: number; c: string[]; p: string; z: string }
  }
}

function replaceCharacter(value: string, index: number, replacement: string): string {
  return `${value.slice(0, index)}${replacement}${value.slice(index + 1)}`
}

function changedStatic<T>(source: T, change: (overlay: T) => void): T {
  const overlay = structuredClone(source)
  change(overlay)
  return overlay
}

function replaceGroundToken(overlay: StaticOverlay, token: string, replacement: string): void {
  for (const row of overlay.village.ground) {
    const column = row.indexOf(token)
    if (column >= 0) {
      row[column] = replacement
      return
    }
  }
  throw new Error(`fixture has no ${token} ground cell`)
}
