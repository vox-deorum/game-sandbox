/**
 * The pure Crane Reach scene builder. The environment records a compact versioned overlay, while
 * this module expands it into ordinary drawable data. No Pixi objects live here: a replay may seek
 * to any recorded state and receive the same scene every time.
 */
import type { StepState } from '@game-sandbox/schema'

import tileTypes from '../tile_types.json'

import { decodePath } from './paths.js'

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
    waste: '#6b5d72',
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

export type TerrainName = keyof typeof CRANE_STYLE.terrain
export type FeatureName = keyof typeof CRANE_STYLE.feature

export interface HexTile {
  key: string
  q: number
  r: number
  terrain: TerrainName
  feature: FeatureName
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

export interface UnitStats {
  hitPoints: number
  movement: number
  damage: number
  range: number
  vision: number
}

export const UNIT_STATS: Record<SceneUnit['type'], UnitStats> = {
  footman: { hitPoints: 12, movement: 2, damage: 3, range: 1, vision: 4 },
  archer: { hitPoints: 6, movement: 2, damage: 2, range: 6, vision: 6 },
  cavalry: { hitPoints: 10, movement: 4, damage: 3, range: 1, vision: 6 },
}

export interface HudStatField {
  icon: 'iconHp' | 'iconMove' | 'iconAttack' | 'iconRange' | 'iconVision'
  label: 'HP' | 'MOV' | 'ATK' | 'RNG' | 'VIS'
  value: string
}

export interface HudCard {
  title: string
  fields: HudStatField[]
  tile: Pick<HexTile, 'terrain' | 'feature'> | null
  ability: 'shield_wall' | 'charge' | null
}

/** The card specification is pure so display and coverage share the exact icon-led content. */
export function unitCardFor(
  type: SceneUnit['type'],
  currentHitPoints: number | null,
  unitAbilities: boolean,
  tile: Pick<HexTile, 'terrain' | 'feature'> | null = null,
): HudCard {
  const stats = UNIT_STATS[type]
  return {
    title: type.toUpperCase(),
    fields: [
      {
        icon: 'iconHp',
        label: 'HP',
        value:
          currentHitPoints === null
            ? String(stats.hitPoints)
            : `${currentHitPoints}/${stats.hitPoints}`,
      },
      { icon: 'iconMove', label: 'MOV', value: String(stats.movement) },
      { icon: 'iconAttack', label: 'ATK', value: String(stats.damage) },
      { icon: 'iconRange', label: 'RNG', value: String(stats.range) },
      { icon: 'iconVision', label: 'VIS', value: String(stats.vision) },
    ],
    tile,
    ability: unitAbilities
      ? type === 'footman'
        ? 'shield_wall'
        : type === 'cavalry'
          ? 'charge'
          : null
      : null,
  }
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
  /** The actual centers entered by the activation, beginning with its start tile. */
  route: Point[]
  /** Route segments, capped by the game's four-step movement limit. */
  movementTiles: number
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
  /** Every roster slot in player order, alive or not. Both rosters are standing knowledge. */
  roster: SceneRosterEntry[]
  /** The unit ids each living player can see, keyed by player id. A dead player has no entry. */
  visibility: Map<string, Set<string>>
  activation: SceneActivation | null
  event: SceneEvent | null
  hud: {
    round: number
    capture: { red: number; blue: number; target: number } | null
    rosters: Record<'red' | 'blue', Record<SceneUnit['type'], number>>
    terrainEnabled: boolean
    unitAbilities: boolean
    terminal: { winner: 'red' | 'blue' | 'draw'; result: string } | null
  }
}

export interface SceneConfig {
  /** Terrain is a fixed episode parameter, supplied from the recording header rather than overlay v1. */
  terrainEnabled?: boolean
  /** Abilities are a fixed episode parameter, supplied from the recording header rather than overlay v1. */
  unitAbilities?: boolean
}

/**
 * One roster slot, alive or not. Both sides' rosters are standing knowledge in the ruleset, so this
 * is the one part of the scene fog never removes.
 */
export interface SceneRosterEntry {
  playerId: string
  unitId: string
  side: 'red' | 'blue'
  type: 'footman' | 'archer' | 'cavalry'
}

interface CompactOverlay {
  version: 1 | 2
  plan: 'skirmish' | 'army'
  side: number
  rows: string[]
  zoneRecords: string[]
  round: number
  capture: [number, number, number]
  unitRecords: string[]
  activation: number | null
  /** One entry per roster slot in player order: a base-64 bitmask for a living unit, null for a dead one. */
  visibilityRecords: (string | null)[]
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
const BASE64 = `${BASE36}ABCDEFGHIJKLMNOPQRSTUVWXYZ-_`

/**
 * The wire codes come from the same tile-type file the rules engine reads, so the two sides
 * cannot drift. Appearance stays here: every declared name must have a style entry.
 */
function readTileCodes(): Record<string, readonly [TerrainName, FeatureName]> {
  const codes: Record<string, readonly [TerrainName, FeatureName]> = {}
  for (const [terrain, row] of Object.entries(tileTypes.tile_codes)) {
    if (!(terrain in CRANE_STYLE.terrain)) {
      throw new Error(`Crane Reach has no style for terrain ${terrain}`)
    }
    for (const [feature, code] of Object.entries(row)) {
      if (!(feature in CRANE_STYLE.feature)) {
        throw new Error(`Crane Reach has no style for feature ${feature}`)
      }
      codes[code] = [terrain as TerrainName, feature as FeatureName]
    }
  }
  return codes
}

const TILE_CODES = readTileCodes()

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

/**
 * Expand one visibility record into the roster slots it names. The environment writes the mask as a
 * big-endian base-64 number, so each digit carries six bits and the leftmost digit is the highest.
 * Reading it digit by digit keeps a 40-slot army mask out of floating-point arithmetic entirely.
 */
function decodeVisibilityBits(record: string, slots: number): Set<number> {
  const bits = new Set<number>()
  for (let index = 0; index < record.length; index += 1) {
    const digit = BASE64.indexOf(record[index] as string)
    if (digit < 0) throw new Error('Crane Reach overlay has an invalid visibility mask')
    const base = 6 * (record.length - 1 - index)
    for (let offset = 0; offset < 6; offset += 1) {
      if (((digit >> offset) & 1) === 0) continue
      if (base + offset >= slots)
        throw new Error('Crane Reach overlay sees a unit outside the roster')
      bits.add(base + offset)
    }
  }
  return bits
}

function decodeBase36(value: string, message: string): number {
  if (value.length === 0 || [...value].some((digit) => !BASE36.includes(digit))) {
    throw new Error(message)
  }
  return [...value].reduce((total, digit) => total * 36 + BASE36.indexOf(digit), 0)
}

/** Decode compact v1 and v2 overlays into the few values the scene needs. */
export function decodeOverlay(state: StepState): CompactOverlay {
  const overlay = asRecord(state.overlay, 'Crane Reach state has no compact overlay')
  const version = asInteger(overlay.k, 'Crane Reach overlay has an invalid version')
  if (version !== 1 && version !== 2)
    throw new Error('Crane Reach overlay has an unsupported version')
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
  const visibility = overlay.v
  if (
    !Array.isArray(visibility) ||
    !visibility.every(
      (record) => record === null || (typeof record === 'string' && record.length > 0),
    )
  ) {
    throw new Error('Crane Reach overlay has malformed visibility')
  }
  const event = overlay.e
  if (event !== null && (!Array.isArray(event) || event.length !== (version === 1 ? 11 : 12))) {
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
    version,
    plan,
    side,
    rows: rows as string[],
    zoneRecords: zones as string[],
    round: asInteger(overlay.r, 'Crane Reach overlay has an invalid round'),
    capture: capture as [number, number, number],
    unitRecords: units as string[],
    activation: activation as number | null,
    visibilityRecords: visibility as (string | null)[],
    event: event as unknown[] | null,
    terminal,
    outcome: outcome as [number, number] | null,
  }
}

function rosterFor(plan: CompactOverlay['plan']): SceneRosterEntry[] {
  const roster: SceneRosterEntry[] = []
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

/**
 * The six axial neighbor offsets, in an order two other things depend on. Index i is the neighbor
 * across the edge running from corner i to corner i + 1 of `hexCorners`, which is how the renderer
 * finds the outer edges of a region. A wire path direction d is index d - 1.
 */
export const HEX_DIRECTIONS: ReadonlyArray<readonly [number, number]> = [
  [1, -1],
  [1, 0],
  [0, 1],
  [-1, 1],
  [-1, 0],
  [0, -1],
]

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
      const mapped = code === undefined ? undefined : TILE_CODES[code]
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
    for (const [dq, dr] of HEX_DIRECTIONS) {
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
  roster: SceneRosterEntry[],
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

/**
 * Who each living unit can see. The environment writes one mask per roster slot in player order,
 * filled for the living and null for the dead. Every living unit must carry one, because fog has no
 * other source; a leftover mask on a dead slot is simply never consulted.
 */
function readVisibility(
  overlay: CompactOverlay,
  roster: SceneRosterEntry[],
  units: SceneUnit[],
): Map<string, Set<string>> {
  if (overlay.visibilityRecords.length !== roster.length) {
    throw new Error('Crane Reach overlay visibility must follow full roster order')
  }
  const visibility = new Map<string, Set<string>>()
  for (const [slot, record] of overlay.visibilityRecords.entries()) {
    if (record === null) continue
    const seen = new Set<string>()
    for (const bit of decodeVisibilityBits(record, roster.length)) {
      seen.add((roster[bit] as SceneRosterEntry).unitId)
    }
    visibility.set((roster[slot] as SceneRosterEntry).playerId, seen)
  }
  for (const unit of units) {
    if (!visibility.has(unit.playerId)) {
      throw new Error('Crane Reach overlay omits a living unit from visibility')
    }
  }
  return visibility
}

interface Coordinate {
  q: number
  r: number
}

function coordinateFromRecord(q: unknown, r: unknown, overlay: CompactOverlay): Coordinate {
  const qValue = asInteger(q, 'Crane Reach event has an invalid coordinate')
  const rValue = asInteger(r, 'Crane Reach event has an invalid coordinate')
  const extent = (overlay.side - 1) / 2
  if (
    qValue < 0 ||
    qValue >= overlay.side ||
    rValue < 0 ||
    rValue >= overlay.side ||
    qValue + rValue < extent ||
    qValue + rValue > 3 * extent
  ) {
    throw new Error('Crane Reach event has an out-of-range coordinate')
  }
  return { q: qValue, r: rValue }
}

function decodePathId(pathId: unknown): number[] {
  if (typeof pathId !== 'number') throw new Error('Crane Reach event has an invalid path id')
  return decodePath(pathId)
}

function routeForPath(
  pathId: unknown,
  from: Coordinate,
  to: Coordinate,
  overlay: CompactOverlay,
): Coordinate[] {
  const route = [{ ...from }]
  const extent = (overlay.side - 1) / 2
  for (const direction of decodePathId(pathId)) {
    const delta = HEX_DIRECTIONS[direction - 1]
    if (delta === undefined) throw new Error('Crane Reach event has an invalid path direction')
    const previous = route[route.length - 1] as Coordinate
    const next = { q: previous.q + delta[0], r: previous.r + delta[1] }
    if (
      next.q < 0 ||
      next.q >= overlay.side ||
      next.r < 0 ||
      next.r >= overlay.side ||
      next.q + next.r < extent ||
      next.q + next.r > 3 * extent
    ) {
      throw new Error('Crane Reach event path leaves the battlefield')
    }
    route.push(next)
  }
  const end = route[route.length - 1] as Coordinate
  if (end.q !== to.q || end.r !== to.r)
    throw new Error('Crane Reach event path does not reach its endpoint')
  return route
}

/** The ruleset's hex distance, which both range and vision use. */
export function hexDistance(from: Coordinate, to: Coordinate): number {
  return Math.max(
    Math.abs(to.q - from.q),
    Math.abs(to.r - from.r),
    Math.abs(to.q + to.r - from.q - from.r),
  )
}

/** Split a `q,r` tile key back into its coordinate. */
export function tileCoordinate(key: string): Coordinate {
  const [q, r] = key.split(',').map(Number) as [number, number]
  return { q, r }
}

function fallbackRoute(
  from: Coordinate,
  to: Coordinate,
): { route: Coordinate[]; movementTiles: number } {
  const movementTiles = Math.min(4, hexDistance(from, to))
  return { route: movementTiles === 0 ? [from] : [from, to], movementTiles }
}

function legacyActionPath(state: StepState, actorId: string): unknown {
  const agents = state.agents as unknown
  if (agents === null || typeof agents !== 'object' || Array.isArray(agents)) return undefined
  const agent = (agents as Record<string, unknown>)[actorId]
  if (agent === null || typeof agent !== 'object' || Array.isArray(agent)) return undefined
  const action = (agent as Record<string, unknown>).action
  if (action === null || typeof action !== 'object' || Array.isArray(action)) return undefined
  return (action as Record<string, unknown>).path
}

function readEvent(
  overlay: CompactOverlay,
  roster: SceneRosterEntry[],
  centerFor: (q: number, r: number) => Point,
  state: StepState,
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
  const fromCoordinate = coordinateFromRecord(fromQ, fromR, overlay)
  const toCoordinate = coordinateFromRecord(toQ, toR, overlay)
  const pathId = overlay.event[11]
  let route: Coordinate[]
  let movementTiles: number
  if (overlay.version === 2) {
    route = routeForPath(pathId, fromCoordinate, toCoordinate, overlay)
    movementTiles = route.length - 1
  } else {
    try {
      route = routeForPath(
        legacyActionPath(state, actorEntry.playerId),
        fromCoordinate,
        toCoordinate,
        overlay,
      )
      movementTiles = route.length - 1
    } catch {
      const fallback = fallbackRoute(fromCoordinate, toCoordinate)
      route = fallback.route
      movementTiles = fallback.movementTiles
    }
  }
  return {
    actorId: actorEntry.unitId,
    from: centerFor(fromCoordinate.q, fromCoordinate.r),
    to: centerFor(toCoordinate.q, toCoordinate.r),
    route: route.map((coordinate) => centerFor(coordinate.q, coordinate.r)),
    movementTiles,
    targetId: targetEntry?.unitId ?? null,
    damage: asInteger(damage, 'Crane Reach event has an invalid damage value'),
    automatic,
    deathId: deathEntry?.unitId ?? null,
    redCapture: asInteger(redCapture, 'Crane Reach event has an invalid red capture change'),
    blueCapture: asInteger(blueCapture, 'Crane Reach event has an invalid blue capture change'),
  }
}

function scoreText(score: number): string {
  return Number.isInteger(score) ? String(score) : String(Number(score.toFixed(2)))
}

/** Convert one compact recorded state into the complete static Crane Reach frame. */
export function computeScene(state: StepState, config: SceneConfig = {}): CraneReachScene {
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
  const rosters = {
    red: { footman: 0, archer: 0, cavalry: 0 },
    blue: { footman: 0, archer: 0, cavalry: 0 },
  }
  for (const unit of units) rosters[unit.side][unit.type] += 1
  const visibility = readVisibility(overlay, roster, units)
  const terminal =
    !overlay.terminal || overlay.outcome === null
      ? null
      : {
          winner: (overlay.outcome[0] === overlay.outcome[1]
            ? 'draw'
            : overlay.outcome[0] > overlay.outcome[1]
              ? 'red'
              : 'blue') as 'red' | 'blue' | 'draw',
          result:
            overlay.outcome[0] === overlay.outcome[1]
              ? `draw ${scoreText(overlay.outcome[0])} - ${scoreText(overlay.outcome[1])}`
              : `${overlay.outcome[0] > overlay.outcome[1] ? 'red' : 'blue'} wins ${scoreText(Math.max(...overlay.outcome))} - ${scoreText(Math.min(...overlay.outcome))}`,
        }
  return {
    width: SCENE_WIDTH,
    height: SCENE_HEIGHT,
    battlefieldKey: battlefield.key,
    hexRadius: battlefield.radius,
    tiles: battlefield.tiles,
    zones: battlefield.zones,
    units,
    roster,
    visibility,
    activation:
      activeUnit === undefined
        ? null
        : {
            playerId: activeUnit.playerId,
            unitId: activeUnit.unitId,
            position: activeUnit.position,
          },
    event: readEvent(overlay, roster, battlefield.centerFor, state),
    hud: {
      round: overlay.round,
      capture:
        overlay.capture[2] > 0
          ? { red: overlay.capture[0], blue: overlay.capture[1], target: overlay.capture[2] }
          : null,
      rosters,
      terrainEnabled: config.terrainEnabled === true,
      unitAbilities: config.unitAbilities === true,
      terminal,
    },
  }
}
