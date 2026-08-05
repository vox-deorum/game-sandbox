/**
 * The pure Crane Reach scene builder. The environment records a compact versioned overlay, while
 * this module expands it into ordinary drawable data. No Pixi objects live here: a replay may seek
 * to any recorded state and receive the same scene every time.
 */
import type { StepState } from '@game-sandbox/schema'

export const SCENE_WIDTH = 1200
export const SCENE_HEIGHT = 860

/** Estuary Ink appearance, intentionally kept apart from board geometry and game content. */
export const CRANE_STYLE = {
  backdrop: '#101816',
  mist: '#a9b4ab',
  shadow: '#14201b',
  fog: '#101816',
  board: '#cfc5a9',
  grid: '#6f6757',
  void: '#131c19',
  terrain: {
    grass: '#a9ae8a',
    hill: '#bfa072',
    water: '#5a7680',
    void: '#131c19',
  },
  feature: {
    none: null,
    forest: '#4f6a4b',
    marsh: '#7f8261',
  },
  red: '#b0402e',
  redDeep: '#7e2a1e',
  blue: '#3a5f8f',
  blueDeep: '#27436b',
  activation: '#d9a441',
  zone: '#7d5a7e',
  zoneGlow: '#b98cc0',
  hpLow: '#e6b054',
  danger: '#ffb08e',
  event: '#e8dfc7',
  text: '#efe7d3',
  mutedText: '#b3ab99',
} as const

export interface Point {
  x: number
  y: number
}

export interface HexTile {
  key: string
  q: number
  r: number
  terrain: keyof typeof CRANE_STYLE.terrain
  feature: keyof typeof CRANE_STYLE.feature
  center: Point
  corners: Point[]
}

export interface SceneZone {
  key: string
  center: Point
  tileKeys: string[]
}

export interface SceneUnit {
  playerId: string
  unitId: string
  side: 'red' | 'blue'
  type: 'footman' | 'archer' | 'cavalry'
  hitPoints: number
  position: Point
  tileKey: string
}

export interface SceneActivation {
  playerId: string
  unitId: string
  position: Point
}

export interface SceneEvent {
  actorId: string
  from: Point
  to: Point
  targetId: string | null
  damage: number
  automatic: boolean
  deathId: string | null
  redCapture: number
  blueCapture: number
}

export interface CraneReachScene {
  width: number
  height: number
  battlefieldKey: string
  hexRadius: number
  tiles: HexTile[]
  zones: SceneZone[]
  units: SceneUnit[]
  activation: SceneActivation | null
  event: SceneEvent | null
  hud: {
    round: string
    capture: string
    terminal: string | null
  }
}

export interface SceneConfig {
  /** Reserved for renderer mount-time facts. The spectator view always reveals the full board. */
  controlledPlayers?: readonly string[]
}

interface RosterEntry {
  playerId: string
  unitId: string
  side: 'red' | 'blue'
  type: 'footman' | 'archer' | 'cavalry'
}

interface CompactOverlay {
  plan: 'skirmish' | 'army'
  side: number
  rows: string[]
  zoneRecords: string[]
  round: number
  capture: [number, number, number]
  unitRecords: string[]
  activation: number | null
  event: unknown[] | null
  terminal: boolean
  outcome: [number, number] | null
}

interface BattlefieldScene {
  key: string
  radius: number
  tiles: HexTile[]
  zones: SceneZone[]
  centerFor: (q: number, r: number) => Point
}

const BASE36 = '0123456789abcdefghijklmnopqrstuvwxyz'
const TILE_CODES = {
  g: ['grass', 'none'],
  h: ['hill', 'none'],
  w: ['water', 'none'],
  v: ['void', 'none'],
  f: ['grass', 'forest'],
  m: ['grass', 'marsh'],
} as const
const DIRECTIONS: ReadonlyArray<readonly [number, number]> = [
  [1, -1],
  [1, 0],
  [0, 1],
  [-1, 1],
  [-1, 0],
  [0, -1],
]

const COMPOSITIONS = {
  skirmish: { footman: 1, archer: 1, cavalry: 1 },
  army: { footman: 8, archer: 6, cavalry: 6 },
} as const

// The battlefield does not change within an episode. Retaining the most recent one keeps the
// 6,000-tick army replay cheap without coupling a frame to the renderer's retained Pixi objects
// and without accumulating geometry for every battlefield viewed during the browser session.
let battlefieldCache: BattlefieldScene | null = null

function tileKey(q: number, r: number): string {
  return `${q},${r}`
}

function asRecord(value: unknown, message: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(message)
  }
  return value as Record<string, unknown>
}

function asInteger(value: unknown, message: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new Error(message)
  }
  return value
}

function asString(value: unknown, message: string): string {
  if (typeof value !== 'string') {
    throw new Error(message)
  }
  return value
}

function decodeBase36(value: string, message: string): number {
  if (value.length === 0 || [...value].some((digit) => !BASE36.includes(digit))) {
    throw new Error(message)
  }
  return [...value].reduce((total, digit) => total * 36 + BASE36.indexOf(digit), 0)
}

/** Decode the compact v1 wire overlay into the few values the scene needs. */
export function decodeOverlay(state: StepState): CompactOverlay {
  const overlay = asRecord(state.overlay, 'Crane Reach state has no compact overlay')
  if (asInteger(overlay.k, 'Crane Reach overlay has an invalid version') !== 1) {
    throw new Error('Crane Reach renderer only supports compact overlay version 1')
  }
  const plan = asString(overlay.p, 'Crane Reach overlay has an invalid seat plan')
  if (plan !== 'skirmish' && plan !== 'army') {
    throw new Error('Crane Reach overlay has an unknown seat plan')
  }
  const battlefield = asRecord(overlay.b, 'Crane Reach overlay has no battlefield')
  const side = asInteger(battlefield.s, 'Crane Reach overlay has an invalid battlefield side')
  const rows = battlefield.t
  const zones = battlefield.z
  const capture = overlay.c
  const units = overlay.u
  if (
    side < 1 ||
    side % 2 === 0 ||
    !Array.isArray(rows) ||
    rows.length !== side ||
    !rows.every((row) => typeof row === 'string' && row.length === side) ||
    !Array.isArray(zones) ||
    !zones.every((zone) => typeof zone === 'string' && zone.length === 4) ||
    !Array.isArray(capture) ||
    capture.length !== 3 ||
    !capture.every((value) => typeof value === 'number' && Number.isInteger(value)) ||
    !Array.isArray(units) ||
    !units.every((unit) => typeof unit === 'string' && unit.length === 7)
  ) {
    throw new Error('Crane Reach overlay has malformed battlefield data')
  }
  const activation = overlay.a
  if (
    activation !== null &&
    (typeof activation !== 'number' || !Number.isInteger(activation) || activation < 0)
  ) {
    throw new Error('Crane Reach overlay has an invalid activation')
  }
  const event = overlay.e
  if (event !== null && (!Array.isArray(event) || event.length !== 11)) {
    throw new Error('Crane Reach overlay has an invalid event')
  }
  const terminal = overlay.x
  if (typeof terminal !== 'boolean') {
    throw new Error('Crane Reach overlay has an invalid terminal flag')
  }
  const outcome = overlay.o
  if (
    outcome !== null &&
    (!Array.isArray(outcome) ||
      outcome.length !== 2 ||
      !outcome.every((value) => typeof value === 'number' && Number.isFinite(value)))
  ) {
    throw new Error('Crane Reach overlay has an invalid outcome')
  }
  return {
    plan,
    side,
    rows: rows as string[],
    zoneRecords: zones as string[],
    round: asInteger(overlay.r, 'Crane Reach overlay has an invalid round'),
    capture: capture as [number, number, number],
    unitRecords: units as string[],
    activation: activation as number | null,
    event: event as unknown[] | null,
    terminal,
    outcome: outcome as [number, number] | null,
  }
}

function rosterFor(plan: CompactOverlay['plan']): RosterEntry[] {
  const roster: RosterEntry[] = []
  for (const side of ['red', 'blue'] as const) {
    for (const type of ['footman', 'archer', 'cavalry'] as const) {
      for (let index = 0; index < COMPOSITIONS[plan][type]; index += 1) {
        roster.push({
          playerId: `player_${roster.length}`,
          unitId: `${side}_${type}_${index}`,
          side,
          type,
        })
      }
    }
  }
  return roster
}

function geometry(side: number): { radius: number; centerFor: (q: number, r: number) => Point } {
  const top = 90
  const bottom = 746
  const span = side - 1
  const radius = Math.min(
    (SCENE_WIDTH - 80) / (Math.sqrt(3) * (span * 1.5 + 1)),
    (bottom - top) / (span * 1.5 + 2),
  )
  const width = Math.sqrt(3) * radius * (span * 1.5 + 1)
  const x0 = (SCENE_WIDTH - width) / 2
  return {
    radius,
    centerFor: (q, r) => ({
      x: x0 + Math.sqrt(3) * radius * (q + r / 2 + 0.5),
      y: top + radius * (1 + r * 1.5),
    }),
  }
}

function hexCorners(center: Point, radius: number): Point[] {
  return Array.from({ length: 6 }, (_, index) => {
    const angle = (-90 + index * 60) * (Math.PI / 180)
    return { x: center.x + Math.cos(angle) * radius, y: center.y + Math.sin(angle) * radius }
  })
}

function readTiles(
  overlay: CompactOverlay,
  radius: number,
  centerFor: (q: number, r: number) => Point,
): HexTile[] {
  const tiles: HexTile[] = []
  for (let r = 0; r < overlay.side; r += 1) {
    const row = overlay.rows[r]
    if (row === undefined) throw new Error('Crane Reach overlay has a missing tile row')
    for (let q = 0; q < overlay.side; q += 1) {
      const code = row[q]
      const mapped = code === undefined ? undefined : TILE_CODES[code as keyof typeof TILE_CODES]
      if (mapped === undefined) throw new Error('Crane Reach overlay has an unknown tile code')
      const [terrain, feature] = mapped
      const center = centerFor(q, r)
      tiles.push({
        key: tileKey(q, r),
        q,
        r,
        terrain,
        feature,
        center,
        corners: hexCorners(center, radius),
      })
    }
  }
  return tiles
}

function readZones(
  overlay: CompactOverlay,
  centerFor: (q: number, r: number) => Point,
): SceneZone[] {
  return overlay.zoneRecords.map((record) => {
    const q = decodeBase36(record.slice(0, 2), 'Crane Reach overlay has an invalid zone')
    const r = decodeBase36(record.slice(2), 'Crane Reach overlay has an invalid zone')
    const tileKeys = [tileKey(q, r)]
    for (const [dq, dr] of DIRECTIONS) {
      const nq = q + dq
      const nr = r + dr
      if (nq >= 0 && nq < overlay.side && nr >= 0 && nr < overlay.side) {
        tileKeys.push(tileKey(nq, nr))
      }
    }
    return { key: tileKey(q, r), center: centerFor(q, r), tileKeys }
  })
}

function battlefieldFor(overlay: CompactOverlay): BattlefieldScene {
  const key = `${overlay.side}|${overlay.rows.join('')}|${overlay.zoneRecords.join(',')}`
  if (battlefieldCache !== null && battlefieldCache.key === key) return battlefieldCache
  const { radius, centerFor } = geometry(overlay.side)
  battlefieldCache = {
    key,
    radius,
    tiles: readTiles(overlay, radius, centerFor),
    zones: readZones(overlay, centerFor),
    centerFor,
  }
  return battlefieldCache
}

function readUnits(
  overlay: CompactOverlay,
  roster: RosterEntry[],
  centerFor: (q: number, r: number) => Point,
): SceneUnit[] {
  return overlay.unitRecords.map((record) => {
    const playerIndex = decodeBase36(record.slice(0, 2), 'Crane Reach overlay has an invalid unit')
    const q = decodeBase36(record.slice(2, 4), 'Crane Reach overlay has an invalid unit')
    const r = decodeBase36(record.slice(4, 6), 'Crane Reach overlay has an invalid unit')
    const hitPoints = decodeBase36(record.slice(6), 'Crane Reach overlay has an invalid unit')
    const entry = roster[playerIndex]
    if (entry === undefined || q >= overlay.side || r >= overlay.side || hitPoints < 1) {
      throw new Error('Crane Reach overlay has an out-of-range unit')
    }
    return {
      ...entry,
      hitPoints,
      position: centerFor(q, r),
      tileKey: tileKey(q, r),
    }
  })
}

function pointFromRecord(
  q: unknown,
  r: unknown,
  overlay: CompactOverlay,
  centerFor: (q: number, r: number) => Point,
): Point {
  const qValue = asInteger(q, 'Crane Reach event has an invalid coordinate')
  const rValue = asInteger(r, 'Crane Reach event has an invalid coordinate')
  if (qValue < 0 || qValue >= overlay.side || rValue < 0 || rValue >= overlay.side) {
    throw new Error('Crane Reach event has an out-of-range coordinate')
  }
  return centerFor(qValue, rValue)
}

function readEvent(
  overlay: CompactOverlay,
  roster: RosterEntry[],
  centerFor: (q: number, r: number) => Point,
): SceneEvent | null {
  if (overlay.event === null) return null
  const [actor, fromQ, fromR, toQ, toR, target, damage, automatic, death, redCapture, blueCapture] =
    overlay.event
  const actorIndex = asInteger(actor, 'Crane Reach event has an invalid actor')
  const targetIndex = asInteger(target, 'Crane Reach event has an invalid target')
  const deathIndex = asInteger(death, 'Crane Reach event has an invalid death')
  const actorEntry = roster[actorIndex]
  const targetEntry = targetIndex === -1 ? undefined : roster[targetIndex]
  const deathEntry = deathIndex === -1 ? undefined : roster[deathIndex]
  if (
    actorEntry === undefined ||
    (targetIndex !== -1 && targetEntry === undefined) ||
    (deathIndex !== -1 && deathEntry === undefined)
  ) {
    throw new Error('Crane Reach event refers to an unknown unit')
  }
  if (typeof automatic !== 'boolean')
    throw new Error('Crane Reach event has an invalid automatic flag')
  return {
    actorId: actorEntry.unitId,
    from: pointFromRecord(fromQ, fromR, overlay, centerFor),
    to: pointFromRecord(toQ, toR, overlay, centerFor),
    targetId: targetEntry?.unitId ?? null,
    damage: asInteger(damage, 'Crane Reach event has an invalid damage value'),
    automatic,
    deathId: deathEntry?.unitId ?? null,
    redCapture: asInteger(redCapture, 'Crane Reach event has an invalid red capture change'),
    blueCapture: asInteger(blueCapture, 'Crane Reach event has an invalid blue capture change'),
  }
}

/** Convert one compact recorded state into the complete static Crane Reach frame. */
export function computeScene(state: StepState, _config: SceneConfig = {}): CraneReachScene {
  const overlay = decodeOverlay(state)
  const battlefield = battlefieldFor(overlay)
  const roster = rosterFor(overlay.plan)
  const units = readUnits(overlay, roster, battlefield.centerFor)
  const active = overlay.activation === null ? undefined : roster[overlay.activation]
  if (overlay.activation !== null && active === undefined) {
    throw new Error('Crane Reach overlay has an out-of-range activation')
  }
  const activeUnit =
    active === undefined ? undefined : units.find((unit) => unit.unitId === active.unitId)
  const terminal = overlay.terminal
    ? overlay.outcome === null
      ? 'Battle complete'
      : `Battle complete: Red ${overlay.outcome[0]} · Blue ${overlay.outcome[1]}`
    : null
  return {
    width: SCENE_WIDTH,
    height: SCENE_HEIGHT,
    battlefieldKey: battlefield.key,
    hexRadius: battlefield.radius,
    tiles: battlefield.tiles,
    zones: battlefield.zones,
    units,
    activation:
      activeUnit === undefined
        ? null
        : {
            playerId: activeUnit.playerId,
            unitId: activeUnit.unitId,
            position: activeUnit.position,
          },
    event: readEvent(overlay, roster, battlefield.centerFor),
    hud: {
      round: `Round ${overlay.round}`,
      capture:
        overlay.capture[2] > 0
          ? `Capture  Red ${overlay.capture[0]} · Blue ${overlay.capture[1]} / ${overlay.capture[2]}`
          : `Control  Red ${overlay.capture[0]} · Blue ${overlay.capture[1]}`,
      terminal,
    },
  }
}
