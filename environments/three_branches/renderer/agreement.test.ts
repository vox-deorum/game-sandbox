import { describe, expect, it } from 'vitest'

import sidecarRaw from '../../../frontend/test/fixtures/three-branches-decoded.json?raw'
import { buildingWallSegments } from './geometry.js'
import { type DynamicOverlay, decodeDynamic, decodeStatic } from './overlay.js'
import { header, states } from './test-helpers.js'

const sidecar = JSON.parse(sidecarRaw) as {
  version: number
  static: { version: number; village: unknown }
  walls: Record<string, unknown>
  opening: { overlay: unknown; decoded: Record<string, unknown> }
  frames: Array<{ frame_index: number } & Record<string, unknown>>
}

function withoutVillage(value: DynamicOverlay): Record<string, unknown> {
  const { village: _village, ...dynamic } = value
  return dynamic
}

describe('Three Branches Python and TypeScript overlay agreement', () => {
  const staticOverlay = decodeStatic(header.overlay_static)

  it('matches the Python static decode and engine wall segments', () => {
    expect({ version: staticOverlay.version, village: staticOverlay.village }).toEqual(
      sidecar.static,
    )
    for (const building of staticOverlay.village.buildings) {
      expect(buildingWallSegments(building).map(({ start, end }) => [start, end])).toEqual(
        sidecar.walls[building.id],
      )
    }
  })

  it('matches the captured live opening frame', () => {
    expect(withoutVillage(decodeDynamic(sidecar.opening.overlay, staticOverlay))).toEqual(
      sidecar.opening.decoded,
    )
  })

  it('matches every selected recorded frame by its exact recording index', () => {
    for (const frame of sidecar.frames) {
      const state = states[frame.frame_index]
      expect(state).toBeDefined()
      const { frame_index: _frameIndex, ...expected } = frame
      expect(withoutVillage(decodeDynamic(state, staticOverlay))).toEqual(expected)
    }
  })

  it('records every Naive cast member walking and at least one collision stall', () => {
    const decoded = states.map((state) => decodeDynamic(state, staticOverlay))
    const castIds = decoded[0]?.characters
      .filter((character) => character.id !== 'visitor')
      .map((character) => character.id)

    expect(castIds).toHaveLength(staticOverlay.castSize)
    for (const id of castIds ?? []) {
      const positions = new Set(
        decoded.map((frame) => {
          const character = frame.characters.find((candidate) => candidate.id === id)
          return `${character?.position.x},${character?.position.y}`
        }),
      )
      expect(positions.size).toBeGreaterThan(1)
    }
    expect(
      decoded.some((frame) =>
        frame.characters.some((character) => character.id !== 'visitor' && character.moved === 0),
      ),
    ).toBe(true)
  })
})
