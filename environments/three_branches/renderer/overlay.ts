/** Strict decoding for the compact Days at Three Branches replay overlay. */
import propsData from '../props.json'
import rulesData from '../rules.json'

export const OVERLAY_VERSION = 1

const BASE36 = '0123456789abcdefghijklmnopqrstuvwxyz'
const NONE_TARGET = 'z'
const SCENERY_TYPE = /^[a-z][a-z0-9_]*$/
const BUILDING_ROSTER = [
  ['home_0', 'home'],
  ['home_1', 'home'],
  ['home_2', 'home'],
  ['home_3', 'home'],
  ['home_4', 'home'],
  ['inn', 'inn'],
  ['shed', 'shed'],
] as const

export interface Point {
  x: number
  y: number
}

export interface Polyline {
  width: number
  points: Point[]
}

export interface Bridge {
  position: Point
  heading: number
  width: number
  span: number
}

export interface Building {
  id: string
  type: string
  center: Point
  width: number
  depth: number
  rotation: number
  doorway: { position: Point; width: number }
}

export interface VillageProp {
  id: string
  type: string
  position: Point
  rotation: number
}

export interface Scenery {
  type: string
  position: Point
  radius: number
}

export interface Village {
  channels: Polyline[]
  road: Polyline
  footpaths: Polyline[]
  bridges: Bridge[]
  buildings: Building[]
  props: VillageProp[]
  scenery: Scenery[]
  spawn: Point
  ground: string[][]
}

export interface StaticOverlay {
  version: number
  castSize: number
  daynight: boolean
  village: Village
  propIds: string[]
}

export interface Character {
  id: string
  position: Point
  heading: number
  moved: number
  expression: string
  target: string
}

export interface DynamicOverlay {
  version: number
  village: Village
  tick: number
  characters: Character[]
  prop_states: Record<string, string>
  bell: boolean
  phase: string
  terminal: boolean
}

type PropType = (typeof propsData.props)[number]

const propTypes = new Map<string, PropType>(propsData.props.map((prop) => [prop.token, prop]))
const groundTokens = new Map(rulesData.ground.map((ground) => [ground.code, ground.token]))

/** Decode and validate the immutable header overlay. */
export function decodeStatic(header: unknown): StaticOverlay {
  const outer = record(header, 'overlay static data has unexpected fields')
  exactKeys(outer, ['v', 's'], 'overlay static data has unexpected fields')
  if (!Number.isInteger(outer.v) || outer.v !== OVERLAY_VERSION) {
    throw new Error('overlay static data has an unsupported version')
  }

  const value = record(outer.s, 'overlay static layout has unexpected fields')
  exactKeys(
    value,
    ['a', 'c', 'r', 'f', 'b', 'h', 'p', 'n', 'x', 'g'],
    'overlay static layout has unexpected fields',
  )
  const setting = value.a
  if (typeof setting !== 'string' || setting.length !== 2 || !'01'.includes(setting[1] ?? '')) {
    throw new Error('overlay cast and daynight setting is malformed')
  }
  const castSize = base36(setting[0] ?? '', 1, 'cast size')
  if (castSize !== 5 && castSize !== 10) throw new Error('overlay cast size must be 5 or 10')

  const channels = array(value.c, 'overlay must contain exactly four channels')
  const footpaths = array(value.f, 'overlay must contain at least one footpath')
  const bridges = array(value.b, 'overlay bridges must be a list')
  const buildings = array(value.h, 'overlay must contain exactly seven buildings')
  const props = array(value.p, 'overlay must contain exactly 31 props')
  const scenery = array(value.n, 'overlay scenery must be a list')
  if (channels.length !== 4) throw new Error('overlay must contain exactly four channels')
  if (footpaths.length === 0) throw new Error('overlay must contain at least one footpath')
  if (buildings.length !== BUILDING_ROSTER.length)
    throw new Error('overlay must contain exactly seven buildings')

  const propIds = propertyIds(props)
  return {
    version: OVERLAY_VERSION,
    castSize,
    daynight: setting[1] === '1',
    village: {
      channels: channels.map((channel) => decodePolyline(channel, 'channel')),
      road: decodePolyline(value.r, 'road'),
      footpaths: footpaths.map((path) => decodePolyline(path, 'footpath')),
      bridges: bridges.map(decodeBridge),
      buildings: buildings.map((building, index) => decodeBuilding(building, index)),
      props: props.map((prop, index) => decodeProp(prop, index, propIds)),
      scenery: scenery.map(decodeScenery),
      spawn: point(value.x, 'spawn'),
      ground: decodeGround(value.g),
    },
    propIds,
  }
}

/** Decode and validate one replay state against its already-decoded static header. */
export function decodeDynamic(state: unknown, staticOverlay?: StaticOverlay): DynamicOverlay {
  if (isRecord(state) && 's' in state) {
    throw new Error('overlay dynamic frame must not contain static layout data')
  }
  if (!staticOverlay) throw new Error('overlay static data is required')
  const outer = record(state, 'overlay dynamic frame has unexpected fields')
  exactKeys(outer, ['v', 'd'], 'overlay dynamic frame has unexpected fields')
  if (!Number.isInteger(outer.v) || outer.v !== OVERLAY_VERSION) {
    throw new Error('overlay dynamic frame has an unsupported version')
  }

  const dynamic = record(outer.d, 'overlay dynamic state has unexpected fields')
  exactKeys(dynamic, ['t', 'c', 'p', 'z'], 'overlay dynamic state has unexpected fields')
  const tick = dynamic.t
  if (
    typeof tick !== 'number' ||
    !Number.isInteger(tick) ||
    tick < 1 ||
    tick > rulesData.day_ticks
  ) {
    throw new Error('overlay tick must be within the day')
  }
  if (typeof dynamic.z !== 'string' || (dynamic.z !== '0' && dynamic.z !== '1')) {
    throw new Error('overlay terminal flag must be 0 or 1')
  }
  if (dynamic.z === '1' && tick !== rulesData.day_ticks) {
    throw new Error('overlay terminal flag may occur only on the final tick')
  }

  const records = array(dynamic.c, 'overlay character records must follow roster order')
  if (records.length !== staticOverlay.castSize + 1) {
    throw new Error('overlay character records must follow roster order')
  }
  const holders = new Set<string>()
  const characters = records.map((value, index) => {
    if (typeof value !== 'string' || value.length !== 13) {
      throw new Error('overlay character record must be 13 characters')
    }
    const moved = meters(value.slice(9, 11), 2, 'character movement')
    if (moved > 1) throw new Error('overlay character movement cannot exceed one meter')
    const expressionCode = base36(value[11] ?? '', 1, 'expression')
    const targetCode = value[12] ?? ''
    let expression: string
    let target = 'none'
    if (expressionCode === 10) {
      const targetIndex = base36(targetCode, 1, 'use target')
      if (targetIndex >= staticOverlay.propIds.length || moved !== 0) {
        throw new Error('overlay use target or movement is invalid')
      }
      target = staticOverlay.propIds[targetIndex] ?? ''
      if (holders.has(target)) throw new Error('overlay prop has multiple holders')
      holders.add(target)
      expression = 'use'
    } else {
      if (
        targetCode !== NONE_TARGET ||
        expressionCode < 0 ||
        expressionCode > rulesData.emotes.length
      ) {
        throw new Error('overlay expression and target do not agree')
      }
      expression = expressionCode === 0 ? 'none' : (rulesData.emotes[expressionCode - 1] ?? '')
    }
    return {
      id: index < staticOverlay.castSize ? `npc_${index}` : 'visitor',
      position: point(value.slice(0, 6), 'character'),
      heading: heading(value.slice(6, 9), 'character heading'),
      moved,
      expression,
      target,
    }
  })

  if (typeof dynamic.p !== 'string' || dynamic.p.length !== staticOverlay.propIds.length) {
    throw new Error('overlay prop states must contain exactly 31 characters')
  }
  const prop_states: Record<string, string> = {}
  for (const [index, propId] of staticOverlay.propIds.entries()) {
    const prop = propTypes.get(propToken(propId))
    const stateIndex = base36(dynamic.p[index] ?? '', 1, 'prop state')
    if (!prop || stateIndex >= prop.states.length)
      throw new Error('overlay prop state is out of range')
    prop_states[propId] = prop.states[stateIndex] ?? ''
  }

  return {
    version: OVERLAY_VERSION,
    village: copyVillage(staticOverlay.village),
    tick,
    characters,
    prop_states,
    bell: prop_states.bell_0 === 'ringing',
    phase: phaseAt(tick, staticOverlay.daynight),
    terminal: dynamic.z === '1',
  }
}

function decodePolyline(value: unknown, name: string): Polyline {
  if (typeof value !== 'string' || value.length < 15)
    throw new Error(`overlay ${name} is malformed`)
  const width = meters(value.slice(0, 2), 2, `${name} width`)
  const count = base36(value[2] ?? '', 1, `${name} point count`)
  if (width <= 0 || count < 2 || value.length !== 3 + count * 6) {
    throw new Error(`overlay ${name} has an invalid width or point count`)
  }
  const points: Point[] = []
  for (let index = 3; index < value.length; index += 6)
    points.push(point(value.slice(index, index + 6), `${name} point`))
  return { width, points }
}

function decodeBridge(value: unknown): Bridge {
  if (typeof value !== 'string' || value.length !== 13)
    throw new Error('overlay bridge record must be 13 characters')
  const width = meters(value.slice(9, 11), 2, 'bridge width')
  const span = meters(value.slice(11), 2, 'bridge span')
  if (width <= 0 || span <= 0) throw new Error('overlay bridge lengths must be positive')
  return {
    position: point(value.slice(0, 6), 'bridge'),
    heading: heading(value.slice(6, 9), 'bridge heading'),
    width,
    span,
  }
}

function decodeBuilding(value: unknown, index: number): Building {
  if (typeof value !== 'string' || value.length !== 21)
    throw new Error('overlay building record must be 21 characters')
  const width = meters(value.slice(6, 8), 2, 'building width')
  const depth = meters(value.slice(8, 10), 2, 'building depth')
  const doorwayWidth = meters(value.slice(19), 2, 'doorway width')
  if (Math.min(width, depth, doorwayWidth) <= 0 || doorwayWidth > Math.max(width, depth)) {
    throw new Error('overlay building lengths are invalid')
  }
  const roster = BUILDING_ROSTER[index]
  if (!roster) throw new Error('overlay must contain exactly seven buildings')
  return {
    id: roster[0],
    type: roster[1],
    center: point(value.slice(0, 6), 'building'),
    width,
    depth,
    rotation: heading(value.slice(10, 13), 'building rotation'),
    doorway: { position: point(value.slice(13, 19), 'doorway'), width: doorwayWidth },
  }
}

function decodeProp(value: unknown, index: number, propIds: string[]): VillageProp {
  if (typeof value !== 'string' || value.length !== 9)
    throw new Error('overlay prop record must be nine characters')
  const id = propIds[index]
  if (!id) throw new Error('overlay must contain exactly 31 props')
  return {
    id,
    type: propToken(id),
    position: point(value.slice(0, 6), 'prop'),
    rotation: heading(value.slice(6), 'prop rotation'),
  }
}

function decodeScenery(value: unknown): Scenery {
  if (typeof value !== 'string' || value.split(':').length !== 2)
    throw new Error('overlay scenery record is malformed')
  const [type, packed] = value.split(':')
  if (!type || !packed || !SCENERY_TYPE.test(type) || packed.length !== 8)
    throw new Error('overlay scenery record is malformed')
  const radius = meters(packed.slice(6), 2, 'scenery radius')
  if (radius <= 0) throw new Error('overlay scenery radius must be positive')
  return { type, position: point(packed.slice(0, 6), 'scenery'), radius }
}

function decodeGround(value: unknown): string[][] {
  const rows = array(value, 'overlay ground must contain exactly 100 rows')
  if (rows.length !== 100) throw new Error('overlay ground must contain exactly 100 rows')
  return rows.map((row) => {
    if (typeof row !== 'string' || row.length === 0 || row.length % 3 !== 0)
      throw new Error('overlay ground row is malformed')
    const cells: string[] = []
    let previous: string | undefined
    for (let index = 0; index < row.length; index += 3) {
      const code = row[index] ?? ''
      const count = base36(row.slice(index + 1, index + 3), 2, 'ground run')
      const token = groundTokens.get(code)
      if (!token || count < 1 || count > 100 || code === previous)
        throw new Error('overlay ground row has an invalid run')
      cells.push(...Array<string>(count).fill(token))
      previous = code
    }
    if (cells.length !== 100) throw new Error('overlay ground row must sum to 100 cells')
    return cells
  })
}

function propertyIds(packed: unknown[]): string[] {
  if (packed.length !== 31) throw new Error('overlay must contain exactly 31 props')
  return propsData.props.flatMap((prop) =>
    Array.from({ length: prop.count }, (_, index) => `${prop.token}_${index}`),
  )
}

function propToken(id: string): string {
  return id.slice(0, id.lastIndexOf('_'))
}

function point(value: unknown, name: string): Point {
  if (typeof value !== 'string' || value.length !== 6)
    throw new Error(`overlay ${name} must be six characters`)
  const x = meters(value.slice(0, 3), 3, `${name} x`)
  const y = meters(value.slice(3), 3, `${name} y`)
  if (x > 100 || y > 100) throw new Error(`overlay ${name} lies outside the village`)
  return { x, y }
}

function heading(value: unknown, name: string): number {
  const result = base36(value, 3, name)
  if (result >= 3600) throw new Error(`overlay ${name} is outside 0 through 359.9 degrees`)
  return result / 10
}

function meters(value: unknown, width: number, name: string): number {
  return base36(value, width, name) / 100
}

function base36(value: unknown, width: number, name: string): number {
  if (
    typeof value !== 'string' ||
    value.length !== width ||
    [...value].some((character) => !BASE36.includes(character))
  ) {
    throw new Error(`overlay ${name} must be ${width} base36 characters`)
  }
  return [...value].reduce((total, character) => total * 36 + BASE36.indexOf(character), 0)
}

function phaseAt(tick: number, daynight: boolean): string {
  if (!daynight) return rulesData.off_phase
  return (
    rulesData.phases.find((phase) => phase.start <= tick && tick <= phase.end)?.name ??
    rulesData.off_phase
  )
}

function array(value: unknown, message: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(message)
  return value
}

function record(value: unknown, message: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(message)
  return value as Record<string, unknown>
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function exactKeys(value: Record<string, unknown>, expected: string[], message: string): void {
  const keys = Object.keys(value)
  if (keys.length !== expected.length || expected.some((key) => !Object.hasOwn(value, key)))
    throw new Error(message)
}

function copyVillage(village: Village): Village {
  return {
    channels: village.channels.map(copyPolyline),
    road: copyPolyline(village.road),
    footpaths: village.footpaths.map(copyPolyline),
    bridges: village.bridges.map((bridge) => ({ ...bridge, position: { ...bridge.position } })),
    buildings: village.buildings.map((building) => ({
      ...building,
      center: { ...building.center },
      doorway: { ...building.doorway, position: { ...building.doorway.position } },
    })),
    props: village.props.map((prop) => ({ ...prop, position: { ...prop.position } })),
    scenery: village.scenery.map((item) => ({ ...item, position: { ...item.position } })),
    spawn: { ...village.spawn },
    ground: village.ground.map((row) => [...row]),
  }
}

function copyPolyline(line: Polyline): Polyline {
  return { width: line.width, points: line.points.map((item) => ({ ...item })) }
}
