import { stableHashParts } from '@renderers/base/math.js'

/** A resolved prop treatment that never depends on placement or playback history. */
export interface PropTreatment {
  /** Complete north-facing still for this recorded state. */
  frame: string
}

type TreatmentByState = Readonly<Record<string, PropTreatment>>

const TREATMENTS: Readonly<Record<string, TreatmentByState>> = {
  stall: {
    open: { frame: 'stallOpen' },
    closed: { frame: 'stallClosed' },
  },
  lantern: {
    lit: { frame: 'lanternLit' },
    unlit: { frame: 'lanternUnlit' },
  },
  bench: {
    occupied: { frame: 'benchOccupied' },
    empty: { frame: 'benchEmpty' },
  },
  shrine: {
    tended: { frame: 'shrineTended' },
    untended: { frame: 'shrineUntended' },
  },
  board: {
    none: { frame: 'boardNone' },
  },
  plot: {
    tended: { frame: 'plotTended' },
    overgrown: { frame: 'plotOvergrown' },
  },
  hearth: {
    lit: { frame: 'hearthLit' },
    unlit: { frame: 'hearthUnlit' },
  },
  repair_bench: {
    busy: { frame: 'repairBenchBusy' },
    idle: { frame: 'repairBenchIdle' },
  },
  pump: {
    flowing: { frame: 'pumpFlowing' },
    idle: { frame: 'pumpIdle' },
  },
  bell: {
    ringing: { frame: 'bellRinging' },
    silent: { frame: 'bellSilent' },
  },
}

/** Prop art types enabled for the current owner artwork review. */
export const SHIPPED_PROP_TYPES = [
  'stall',
  'lantern',
  'bench',
  'shrine',
  'board',
  'plot',
  'hearth',
  'repair_bench',
  'pump',
  'bell',
] as const

/** Whether a prop type has enabled still artwork in the current renderer slice. */
export function isShippedPropType(type: string): boolean {
  return SHIPPED_PROP_TYPES.includes(type as (typeof SHIPPED_PROP_TYPES)[number])
}

/** Symmetric prop art types whose recorded facing is ignored: they always draw facing north. */
const FIXED_FACING_PROP_TYPES = new Set(['lantern', 'shrine'])

/** Whether a prop type draws fixed north, ignoring its recorded facing. */
export function isFixedFacingPropType(type: string): boolean {
  return FIXED_FACING_PROP_TYPES.has(type)
}

/** Resolve a complete prop treatment, failing clearly for an unsupported catalog value. */
export function propTreatment(type: string, state: string): PropTreatment {
  const byState = TREATMENTS[type]
  if (byState === undefined)
    throw new Error(`Three Branches prop type has no art treatment: ${type}`)
  const treatment = byState[state]
  if (treatment === undefined) {
    throw new Error(`Three Branches prop state has no art treatment: ${type}.${state}`)
  }
  return treatment
}

/** Resolve a state-independent foundation frame for a fixed monument. */
export function propFoundationFrame(type: string): string | null {
  return type === 'bell' ? 'bellFoundation' : null
}

/** Select one fixed scenery frame from a catalog type and stable placement id. */
export function sceneryFrame(type: string, id: string): string {
  if (type === 'crate') return 'marketCrate'
  if (type === 'pine') {
    const variants = ['pineA', 'pineB', 'pineC'] as const
    return variants[stableHashParts('three-branches-scenery', id) % variants.length]!
  }
  throw new Error(`Three Branches scenery type has no art frame: ${type}`)
}
