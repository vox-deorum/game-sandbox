import { stableHashParts } from '@renderers/base/math.js'

import { atlasFrameNames } from '../assets.js'

/** Complete high-resolution pine stills available for stable placement selection. */
export const PINE_FRAME_NAMES = atlasFrameNames('scenery').filter((name) =>
  /^pine[A-Z]$/.test(name),
)

export type PropArtPage = 'props'

/** One sprite role selected from a dedicated atlas page and state frame. */
export interface PropArtFrame {
  page: PropArtPage
  frame: string
}

/** The one centered still selected for one recorded prop state. */
export interface PropTreatment {
  lower: PropArtFrame
  moving?: PropArtFrame
}

type TreatmentByState = Readonly<Record<string, PropTreatment>>

const ordinary = (frame: string): PropTreatment => ({ lower: { page: 'props', frame } })
const bell = (): PropTreatment => ({
  lower: { page: 'props', frame: 'bellBase' },
  moving: { page: 'props', frame: 'bellStriker' },
})

const STALL_TREATMENTS = [
  { open: ordinary('stallAOpen'), closed: ordinary('stallAClosed') },
  { open: ordinary('stallBOpen'), closed: ordinary('stallBClosed') },
  { open: ordinary('stallCOpen'), closed: ordinary('stallCClosed') },
] as const satisfies readonly TreatmentByState[]

const BENCH_TREATMENTS = [
  { occupied: ordinary('benchAOccupied'), empty: ordinary('benchAEmpty') },
  { occupied: ordinary('benchBOccupied'), empty: ordinary('benchBEmpty') },
  { occupied: ordinary('benchCOccupied'), empty: ordinary('benchCEmpty') },
] as const satisfies readonly TreatmentByState[]

const TREATMENTS: Readonly<Record<string, TreatmentByState>> = {
  lantern: { lit: ordinary('lanternLit'), unlit: ordinary('lanternUnlit') },
  shrine: { tended: ordinary('shrineTended'), untended: ordinary('shrineUntended') },
  board: { none: ordinary('boardNone') },
  plot: { tended: ordinary('plotTended'), overgrown: ordinary('plotOvergrown') },
  hearth: { lit: ordinary('hearthLit'), unlit: ordinary('hearthUnlit') },
  repair_bench: { busy: ordinary('repairBenchBusy'), idle: ordinary('repairBenchIdle') },
  pump: { flowing: ordinary('pump'), idle: ordinary('pump') },
  bell: { ringing: bell(), silent: bell() },
}

function variantIndex(id: string, count: number): number {
  const suffix = id.match(/(\d+)$/)?.[1]
  return suffix === undefined ? 0 : Number.parseInt(suffix, 10) % count
}

/** Select one stall construction from its stable placement id. */
export function stallVariantIndex(id: string): number {
  return variantIndex(id, STALL_TREATMENTS.length)
}

/** Select one fabric-bench construction from its stable placement id. */
export function benchVariantIndex(id: string): number {
  return variantIndex(id, BENCH_TREATMENTS.length)
}

/** Prop art types enabled for the current owner artwork review. */
const SHIPPED_PROP_TYPES = [
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

/** Symmetric props whose recorded facing is ignored: they always draw facing north. */
const FIXED_FACING_PROP_TYPES = new Set(['lantern', 'shrine', 'pump', 'bell', 'board'])

/** Whether a prop type draws fixed north, ignoring its recorded facing. */
export function isFixedFacingPropType(type: string): boolean {
  return FIXED_FACING_PROP_TYPES.has(type)
}

/** Resolve the centered artwork still for one recorded prop state and stable placement id. */
export function propTreatment(type: string, state: string, id: string): PropTreatment {
  const byState: TreatmentByState | undefined =
    type === 'stall'
      ? STALL_TREATMENTS[stallVariantIndex(id)]
      : type === 'bench'
        ? BENCH_TREATMENTS[benchVariantIndex(id)]
        : TREATMENTS[type]
  if (byState === undefined)
    throw new Error(`Three Branches prop type has no art treatment: ${type}`)
  const treatment = byState[state]
  if (treatment === undefined) {
    throw new Error(`Three Branches prop state has no art treatment: ${type}.${state}`)
  }
  return treatment
}

/** Select one fixed scenery frame from a catalog type and stable placement id. */
export function sceneryFrame(type: string, id: string): string {
  if (type === 'crate') return 'marketCrate'
  if (type === 'pine') {
    const index = stableHashParts('three-branches-scenery', id) % PINE_FRAME_NAMES.length
    const frame = PINE_FRAME_NAMES.at(index)
    if (frame === undefined) throw new Error('Three Branches scenery atlas has no pine frames.')
    return frame
  }
  throw new Error(`Three Branches scenery type has no art frame: ${type}`)
}
