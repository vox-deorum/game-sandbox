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
