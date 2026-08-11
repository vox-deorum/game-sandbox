/** Closed-form village geometry used by the placeholder and collision scenes. */
import rulesData from '../rules.json'
import type { Bridge, Building, Point, Polyline, Village } from './overlay.js'
import { PRESENTATION } from './presentation.js'

export const WORLD_SCALE = PRESENTATION.worldScale
export const WORLD_SIZE_METERS = 100
export const WORLD_SIZE = WORLD_SIZE_METERS * WORLD_SCALE
/** The body the engine gives every character, so drawn circles match the collision truth. */
export const CHARACTER_RADIUS_METERS = rulesData.profile.body_radius
export const CHARACTER_HEADING_LENGTH_METERS = 0.4
export const STATIC_SEGMENT_RADIUS_METERS = 0.05

export interface Segment {
  start: Point
  end: Point
}

export interface Circle {
  center: Point
  radius: number
}

/** Convert a meter-space point to the renderer's world coordinates. */
export function worldPoint(point: Point): Point {
  return { x: point.x * WORLD_SCALE, y: point.y * WORLD_SCALE }
}

/** Convert a meter measurement to renderer world coordinates. */
export function worldLength(meters: number): number {
  return meters * WORLD_SCALE
}

/** Return the unit vector for an east-zero, clockwise-on-screen heading. */
export function headingVector(heading: number): Point {
  const angle = (wrapHeading(heading) * Math.PI) / 180
  return { x: Math.cos(angle), y: Math.sin(angle) }
}

/** Return the four rotated footprint corners in the engine's stable perimeter order. */
export function footprintCorners(
  center: Point,
  width: number,
  depth: number,
  heading: number,
): Point[] {
  const forward = headingVector(heading)
  const left = { x: -forward.y, y: forward.x }
  const halfWidth = width / 2
  const halfDepth = depth / 2
  return [
    add(add(center, forward, -halfWidth), left, -halfDepth),
    add(add(center, forward, halfWidth), left, -halfDepth),
    add(add(center, forward, halfWidth), left, halfDepth),
    add(add(center, forward, -halfWidth), left, halfDepth),
  ]
}

/** Split a building perimeter around its doorway gap, exactly as the engine does. */
export function buildingWallSegments(building: Building): Segment[] {
  const corners = footprintCorners(
    building.center,
    building.width,
    building.depth,
    building.rotation,
  )
  const edges = corners.map((start, index) => ({
    start,
    end: corners[(index + 1) % corners.length] as Point,
  }))
  const doorwayEdge = edges.reduce((closest, edge) =>
    distanceToSegment(building.doorway.position, edge.start, edge.end) <
    distanceToSegment(building.doorway.position, closest.start, closest.end)
      ? edge
      : closest,
  )
  const walls: Segment[] = []
  for (const edge of edges) {
    if (edge !== doorwayEdge) {
      walls.push(edge)
      continue
    }
    const direction = normalize(subtract(edge.end, edge.start))
    const projected = dot(subtract(building.doorway.position, edge.start), direction)
    const length = distance(edge.start, edge.end)
    const gapStart = add(edge.start, direction, Math.max(0, projected - building.doorway.width / 2))
    const gapEnd = add(
      edge.start,
      direction,
      Math.min(length, projected + building.doorway.width / 2),
    )
    if (!samePoint(gapStart, edge.start)) walls.push({ start: edge.start, end: gapStart })
    if (!samePoint(gapEnd, edge.end)) walls.push({ start: gapEnd, end: edge.end })
  }
  return walls
}

/** Return the endpoint of a heading tick in meter space. */
export function headingEndpoint(
  position: Point,
  heading: number,
  length = CHARACTER_HEADING_LENGTH_METERS,
): Point {
  return add(position, headingVector(heading), length)
}

/** Build the water-bank segments used by the engine's static physics space. */
export function waterBankSegments(village: Village): Segment[] {
  const banks: Segment[] = []
  for (const channel of village.channels) {
    for (const side of [-channel.width / 2, channel.width / 2]) {
      const points = offsetPolyline(channel.points, side)
      for (let index = 0; index < points.length - 1; index += 1) {
        const start = points[index]
        const end = points[index + 1]
        if (!start || !end) continue
        let pieces: Segment[] = [{ start, end }]
        for (const bridge of village.bridges) {
          pieces = pieces.flatMap((piece) => segmentOutsideBridge(piece, bridge))
        }
        banks.push(...pieces)
      }
    }
  }
  for (const bridge of village.bridges) {
    const forward = headingVector(bridge.heading)
    const normal = { x: -forward.y, y: forward.x }
    const start = add(bridge.position, forward, -bridge.span / 2)
    const end = add(bridge.position, forward, bridge.span / 2)
    banks.push(
      { start: add(start, normal, -bridge.width / 2), end: add(end, normal, -bridge.width / 2) },
      { start: add(start, normal, bridge.width / 2), end: add(end, normal, bridge.width / 2) },
    )
  }
  return banks
}

/** Fill shared channel endpoints with the same round caps as the engine. */
export function waterConfluenceDisks(village: Village): Circle[] {
  const endpoints = village.channels.flatMap((channel) => {
    const first = channel.points[0]
    const last = channel.points[channel.points.length - 1]
    if (!first || !last) return []
    return [
      { center: first, radius: channel.width / 2 },
      { center: last, radius: channel.width / 2 },
    ]
  })
  const disks: Circle[] = []
  while (endpoints.length > 0) {
    const endpoint = endpoints.pop()
    if (!endpoint) continue
    const matches = [endpoint]
    const remaining: Circle[] = []
    for (const candidate of endpoints) {
      if (distance(endpoint.center, candidate.center) <= 1e-8) matches.push(candidate)
      else remaining.push(candidate)
    }
    endpoints.splice(0, endpoints.length, ...remaining)
    if (matches.length > 1) {
      disks.push({
        center: endpoint.center,
        radius: Math.max(...matches.map((candidate) => candidate.radius)),
      })
    }
  }
  return disks
}

/** Return the four static walls that confine the hundred-meter world. */
export function worldBoundarySegments(): Segment[] {
  return [
    { start: { x: 0, y: 0 }, end: { x: WORLD_SIZE_METERS, y: 0 } },
    {
      start: { x: WORLD_SIZE_METERS, y: 0 },
      end: { x: WORLD_SIZE_METERS, y: WORLD_SIZE_METERS },
    },
    {
      start: { x: WORLD_SIZE_METERS, y: WORLD_SIZE_METERS },
      end: { x: 0, y: WORLD_SIZE_METERS },
    },
    { start: { x: 0, y: WORLD_SIZE_METERS }, end: { x: 0, y: 0 } },
  ]
}

export function wrapHeading(heading: number): number {
  const wrapped = heading % 360
  return Object.is(wrapped, -0) || Math.abs(wrapped) < 1e-9
    ? 0
    : wrapped < 0
      ? wrapped + 360
      : wrapped
}

function add(point: Point, vector: Point, scale = 1): Point {
  return { x: point.x + vector.x * scale, y: point.y + vector.y * scale }
}

function subtract(left: Point, right: Point): Point {
  return { x: left.x - right.x, y: left.y - right.y }
}

function dot(left: Point, right: Point): number {
  return left.x * right.x + left.y * right.y
}

function distance(first: Point, second: Point): number {
  return Math.hypot(first.x - second.x, first.y - second.y)
}

function normalize(vector: Point): Point {
  const length = Math.hypot(vector.x, vector.y)
  return { x: vector.x / length, y: vector.y / length }
}

function distanceToSegment(point: Point, start: Point, end: Point): number {
  const segment = subtract(end, start)
  const lengthSquared = dot(segment, segment)
  if (lengthSquared <= 1e-9) return distance(point, start)
  const fraction = Math.max(0, Math.min(1, dot(subtract(point, start), segment) / lengthSquared))
  return distance(point, add(start, segment, fraction))
}

function samePoint(left: Point, right: Point): boolean {
  return left.x === right.x && left.y === right.y
}

/** Shift a polyline sideways by `side`, following the local tangent so the two sides stay parallel. */
export function offsetPolyline(points: readonly Point[], side: number): Point[] {
  return points.map((point, index) => {
    const previous = points[Math.max(0, index - 1)] as Point
    const following = points[Math.min(points.length - 1, index + 1)] as Point
    const forward = normalize(subtract(following, previous))
    const normal = { x: -forward.y, y: forward.x }
    return add(point, normal, side)
  })
}

function segmentOutsideBridge(segment: Segment, bridge: Bridge): Segment[] {
  const forward = headingVector(bridge.heading)
  const normal = { x: -forward.y, y: forward.x }
  const local = (point: Point): Point => {
    const relative = subtract(point, bridge.position)
    return { x: dot(relative, forward), y: dot(relative, normal) }
  }
  const first = local(segment.start)
  const second = local(segment.end)
  const localDelta = subtract(second, first)
  const globalDelta = subtract(segment.end, segment.start)
  let low = 0
  let high = 1
  const axes: Array<readonly [number, number, number]> = [
    [first.x, localDelta.x, bridge.span / 2],
    [first.y, localDelta.y, bridge.width / 2],
  ]
  for (const [position, direction, limit] of axes) {
    if (Math.abs(direction) < 1e-9) {
      if (Math.abs(position) > limit) return [segment]
      continue
    }
    let enter = (-limit - position) / direction
    let leave = (limit - position) / direction
    if (enter > leave) [enter, leave] = [leave, enter]
    low = Math.max(low, enter)
    high = Math.min(high, leave)
  }
  if (low >= high || high <= 0 || low >= 1) return [segment]
  low = Math.max(0, low - 1e-6)
  high = Math.min(1, high + 1e-6)
  const pieces: Segment[] = []
  if (low > 0) pieces.push({ start: segment.start, end: add(segment.start, globalDelta, low) })
  if (high < 1) pieces.push({ start: add(segment.start, globalDelta, high), end: segment.end })
  return pieces
}
