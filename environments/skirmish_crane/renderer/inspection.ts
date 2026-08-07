import type { SceneEvent, SceneUnit } from './scene.js'

/** View-only inspection state. Pixi handlers reduce through this module and never send actions. */
export type InspectionTarget =
  | { kind: 'unit'; unitId: string }
  | { kind: 'roster'; side: 'red' | 'blue'; type: 'footman' | 'archer' | 'cavalry' }
  | null

export type RosterInspectionTarget = Exclude<InspectionTarget, null> & { kind: 'roster' }

export interface InspectionState {
  target: InspectionTarget
  hoveredUnitId: string | null
  hoveredRoster: RosterInspectionTarget | null
}

export const EMPTY_INSPECTION: InspectionState = { target: null, hoveredUnitId: null, hoveredRoster: null }

export type InspectionEvent =
  | { type: 'hover-unit'; unitId: string | null }
  | { type: 'hover-roster'; target: RosterInspectionTarget | null }
  | { type: 'inspect'; target: Exclude<InspectionTarget, null> }
  | { type: 'dismiss' }

/** Keep pointer inspection deterministic and intentionally separate from the renderer action boundary. */
export function reduceInspection(state: InspectionState, event: InspectionEvent): InspectionState {
  if (event.type === 'hover-unit') return { ...state, hoveredUnitId: event.unitId }
  if (event.type === 'hover-roster') return { ...state, hoveredRoster: event.target }
  if (event.type === 'dismiss') return EMPTY_INSPECTION
  return { ...state, target: event.target }
}

/** Touch and pen taps keep a chip open. Mouse inspection is transient hover only. */
export function pinsInspectionForPointer(pointerType: string): boolean {
  return pointerType !== 'mouse'
}

/** One display priority keeps hover useful while a touch card remains pinned underneath it. */
export function resolveInspection(state: InspectionState): InspectionTarget {
  if (state.hoveredUnitId !== null) return { kind: 'unit', unitId: state.hoveredUnitId }
  if (state.hoveredRoster !== null) return state.hoveredRoster
  return state.target
}

/** Stable renderer-host probe text for browser interaction coverage. */
export function inspectionTargetLabel(target: InspectionTarget): string {
  if (target === null) return 'none'
  return target.kind === 'unit'
    ? `unit:${target.unitId}`
    : `roster:${target.side}:${target.type}`
}

export interface InspectionPresentation {
  target: InspectionTarget
  range: 'acting' | 'inspected'
}

/** A roster card never replaces the acting unit's board range. */
export function inspectionPresentation(state: InspectionState): InspectionPresentation {
  const target = resolveInspection(state)
  return { target, range: target?.kind === 'unit' ? 'inspected' : 'acting' }
}

/** Rendering details for the range layer, kept pure with the inspection priority. */
export function rangePresentation(state: InspectionState, inspectedUnitAvailable = true): {
  wash: 'bone' | 'gilt'
  alpha: number
  outline: 'dashed' | 'solid'
  outlineInk: 'dilute-ink' | 'gilt'
  ring: boolean
} {
  return inspectionPresentation(state).range === 'inspected' && inspectedUnitAvailable
    ? { wash: 'bone', alpha: 0.18, outline: 'dashed', outlineInk: 'dilute-ink', ring: true }
    : { wash: 'gilt', alpha: 0.1, outline: 'solid', outlineInk: 'gilt', ring: false }
}

/** Event timing may hide the acting range, but never a range owned by an inspected board unit. */
export function rangeVisibleDuringEvent(
  inspectedUnitAvailable: boolean,
  actingRangeVisible: boolean,
): boolean {
  return inspectedUnitAvailable || actingRangeVisible
}

/**
 * The probe skips the active event's actor and target only while the event is presenting: mid-motion
 * or under its activation seal, either makes an awkward, unstable hover target. Once the event settles
 * they are exactly as stable and hoverable as any other unit, and a two-per-side skirmish roster needs
 * both available so the probe can still fall back to whichever now sits closest to the view center.
 */
export function probeExclusions(
  event: Pick<SceneEvent, 'actorId' | 'targetId'> | null,
  eventAnimating: boolean,
): ReadonlySet<string> {
  if (!eventAnimating || event === null) return new Set()
  return new Set([event.actorId, event.targetId].filter((id): id is string => id !== null))
}

/** A unit projected into the camera's logical view, the input `selectInspectionProbe` ranks. */
export interface ProjectedUnit {
  unit: SceneUnit
  point: { x: number; y: number }
}

/**
 * Pick the browser test's hover anchor: a unit that stays a reliable, hoverable target after the
 * camera pans or zooms. Each fallback tier (stationary footman, stationary any type, visible footman,
 * visible any type, then off-screen footman, off-screen any) picks the candidate closest to the view
 * center rather than the first match in scene order, since a unit sitting near the view's edge is the
 * one most likely to leave the frame after the modest camera movement the browser suite performs next.
 */
export function selectInspectionProbe(
  projected: ProjectedUnit[],
  view: { width: number; height: number },
  excludedUnitIds: ReadonlySet<string>,
): ProjectedUnit | undefined {
  const visible = projected.filter(
    ({ point }) => point.x >= 0 && point.x <= view.width && point.y >= 0 && point.y <= view.height,
  )
  const stationary = visible.filter(({ unit }) => !excludedUnitIds.has(unit.unitId))
  const center = { x: view.width / 2, y: view.height / 2 }
  const footmen = (candidates: ProjectedUnit[]) =>
    candidates.filter(({ unit }) => unit.type === 'footman')
  return (
    nearestToCenter(footmen(stationary), center) ??
    nearestToCenter(stationary, center) ??
    nearestToCenter(footmen(visible), center) ??
    nearestToCenter(visible, center) ??
    nearestToCenter(footmen(projected), center) ??
    nearestToCenter(projected, center)
  )
}

function nearestToCenter(
  candidates: ProjectedUnit[],
  center: { x: number; y: number },
): ProjectedUnit | undefined {
  return candidates.reduce<ProjectedUnit | undefined>((closest, candidate) => {
    if (closest === undefined) return candidate
    const closestDistance = Math.hypot(closest.point.x - center.x, closest.point.y - center.y)
    const candidateDistance = Math.hypot(candidate.point.x - center.x, candidate.point.y - center.y)
    return candidateDistance < closestDistance ? candidate : closest
  }, undefined)
}
