import type { RecordingHeader, StepState } from '@game-sandbox/schema'
import { messageKey } from '@game-sandbox/schema/message'

import catalogDocument from '../../catalog.json'
import rulesDocument from '../../rules.json'
import type { Cell, SpeechLine, VillageDynamic, VillageSize, VillageStatic } from '../core/types.js'
import {
  array,
  finiteNumber,
  nonnegativeInteger,
  positiveInteger,
  positiveNumber,
} from '../core/validation.js'

/** Validated rules document used as the renderer's semantic source of truth. */
export const RULES = rulesDocument
/** Validated catalog document used for footprints, shapes, states, and labels. */
export const CATALOG = catalogDocument

const FACING = new Set(['north', 'east', 'south', 'west'])

/** Read the episode-static village once, before dynamic states begin arriving. */
export function readStatic(header: RecordingHeader): VillageStatic {
  if (header.environment !== 'three_branches') {
    throw new Error('Three Branches renderer received a header for another environment.')
  }
  const source = record(header.overlay_static, 'overlay_static')
  const sizeSource = record(source.size, 'overlay_static.size')
  const size = {
    cellsX: positiveInteger(sizeSource.cells_x, 'overlay_static.size.cells_x'),
    cellsY: positiveInteger(sizeSource.cells_y, 'overlay_static.size.cells_y'),
    cellSize: positiveNumber(sizeSource.cell_size, 'overlay_static.size.cell_size'),
  }
  const knownGround = new Set(RULES.grounds.map((ground) => ground.code))
  const ground = array(source.ground, 'overlay_static.ground').map((row, index) => {
    const value = text(row, `overlay_static.ground[${index}]`)
    if (value.length !== size.cellsX || [...value].some((code) => !knownGround.has(code))) {
      throw new Error(`overlay_static.ground[${index}] has an invalid width or ground code.`)
    }
    return value
  })
  if (ground.length !== size.cellsY) {
    throw new Error('overlay_static.ground does not match the configured row count.')
  }

  const buildingTypes = new Set(CATALOG.buildings.map((item) => item.token))
  const propTypes = new Set(CATALOG.props.map((item) => item.token))
  const sceneryTypes = new Set(CATALOG.scenery.map((item) => item.token))
  const buildings = array(source.buildings, 'overlay_static.buildings').map((item, index) => {
    const value = record(item, `overlay_static.buildings[${index}]`)
    return {
      id: text(value.id, `overlay_static.buildings[${index}].id`),
      type: knownType(value.type, buildingTypes, `overlay_static.buildings[${index}].type`),
      cell: readCell(value.cell, `overlay_static.buildings[${index}].cell`, size),
    }
  })
  const props = array(source.props, 'overlay_static.props').map((item, index) => {
    const value = record(item, `overlay_static.props[${index}]`)
    const facing = text(value.facing, `overlay_static.props[${index}].facing`)
    if (!FACING.has(facing)) throw new Error(`overlay_static.props[${index}].facing is invalid.`)
    return {
      id: text(value.id, `overlay_static.props[${index}].id`),
      type: knownType(value.type, propTypes, `overlay_static.props[${index}].type`),
      cell: readCell(value.cell, `overlay_static.props[${index}].cell`, size),
      facing,
    }
  })
  const scenery = array(source.scenery, 'overlay_static.scenery').map((item, index) => {
    const value = record(item, `overlay_static.scenery[${index}]`)
    const scaleName = `overlay_static.scenery[${index}].scale`
    const scale = value.scale === undefined ? 1 : finiteNumber(value.scale, scaleName)
    if (scale <= 0) throw new Error(`${scaleName} must be positive.`)
    return {
      type: knownType(value.type, sceneryTypes, `overlay_static.scenery[${index}].type`),
      cell: readCell(value.cell, `overlay_static.scenery[${index}].cell`, size),
      scale,
    }
  })
  assertUnique(
    buildings.map((item) => item.id),
    'building',
  )
  assertUnique(
    props.map((item) => item.id),
    'prop',
  )
  const spawnSource = record(source.spawn, 'overlay_static.spawn')
  const spawn = {
    x: finiteNumber(spawnSource.x, 'overlay_static.spawn.x'),
    y: finiteNumber(spawnSource.y, 'overlay_static.spawn.y'),
  }
  return { size, ground, buildings, props, scenery, spawn }
}

const PLAYER_ID = /^player_(0|[1-9][0-9]*)$/

/** Read the recording's canonical roster in numeric player order. */
export function expectedCharacterIds(header: RecordingHeader): readonly string[] {
  const players = Object.keys(header.players)
  players.forEach(assertCanonicalPlayerId)
  players.sort((left, right) => playerNumber(left) - playerNumber(right))
  if (players.length === 0 || players[0] !== 'player_0') {
    throw new Error('Three Branches recording header is missing player_0.')
  }
  players.forEach((player, index) => {
    if (playerNumber(player) !== index)
      throw new Error('Three Branches players must be contiguous.')
  })
  return players
}

/** Read delivered lines whose endpoints are members of the recording roster. */
export function readSpeech(
  state: StepState,
  expectedIds: readonly string[],
): readonly SpeechLine[] {
  const roster = new Set(expectedIds)
  const lines: SpeechLine[] = []
  for (const message of state.messages ?? []) {
    if (!roster.has(message.from) || (message.to !== null && !roster.has(message.to))) continue
    lines.push({
      key: messageKey({ tick: state.tick, ...message }),
      speaker: message.from,
      addressee: message.to,
      text: message.text,
    })
  }
  return lines
}

/** Read a dynamic frame, or return null for the valid live opening before an overlay exists. */
export function readDynamic(
  state: StepState,
  expectedIds: readonly string[],
  staticVillage: VillageStatic,
): VillageDynamic | null {
  if (state.overlay === undefined) {
    if (Object.keys(state.agents).length === 0) return null
    throw new Error('Three Branches state is missing its dynamic overlay.')
  }
  const source = record(state.overlay, 'overlay')
  const characters = array(source.characters, 'overlay.characters').map((item, index) => {
    const value = record(item, `overlay.characters[${index}]`)
    const expression = record(value.expression, `overlay.characters[${index}].expression`)
    return {
      id: text(value.id, `overlay.characters[${index}].id`),
      x: finiteNumber(value.x, `overlay.characters[${index}].x`),
      y: finiteNumber(value.y, `overlay.characters[${index}].y`),
      heading: finiteNumber(value.heading, `overlay.characters[${index}].heading`),
      moved: finiteNumber(value.moved, `overlay.characters[${index}].moved`),
      expression: {
        type: text(expression.type, `overlay.characters[${index}].expression.type`),
        target: text(expression.target, `overlay.characters[${index}].expression.target`),
      },
    }
  })
  if (
    characters.length !== expectedIds.length ||
    characters.some((character, index) => character.id !== expectedIds[index])
  ) {
    throw new Error('overlay.characters does not match the recording roster.')
  }
  const propsSource = record(source.props, 'overlay.props')
  const props: Record<string, string> = {}
  for (const prop of staticVillage.props) {
    props[prop.id] = text(propsSource[prop.id], `overlay.props.${prop.id}`)
  }
  return {
    tick: nonnegativeInteger(source.tick, 'overlay.tick'),
    phase: text(source.phase, 'overlay.phase'),
    characters,
    props,
    terminal: boolean(source.terminal, 'overlay.terminal'),
  }
}

function readCell(value: unknown, name: string, size: VillageSize): Cell {
  const source = record(value, name)
  const cell = {
    x: nonnegativeInteger(source.x, `${name}.x`),
    y: nonnegativeInteger(source.y, `${name}.y`),
  }
  if (cell.x >= size.cellsX || cell.y >= size.cellsY)
    throw new Error(`${name} is outside the village.`)
  return cell
}

function record(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new Error(`${name} must be an object.`)
  return value as Record<string, unknown>
}

function text(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.length === 0)
    throw new Error(`${name} must be non-empty text.`)
  return value
}

function boolean(value: unknown, name: string): boolean {
  if (typeof value !== 'boolean') throw new Error(`${name} must be true or false.`)
  return value
}

function knownType(value: unknown, known: ReadonlySet<string>, name: string): string {
  const result = text(value, name)
  if (!known.has(result)) throw new Error(`${name} names an unknown catalog type.`)
  return result
}

function assertUnique(ids: readonly string[], name: string): void {
  if (new Set(ids).size !== ids.length) throw new Error(`overlay_static has duplicate ${name} ids.`)
}

function playerNumber(player: string): number {
  return Number(PLAYER_ID.exec(player)![1])
}

function assertCanonicalPlayerId(player: string): void {
  if (!PLAYER_ID.test(player)) throw new Error(`Invalid Three Branches player id ${player}.`)
}
