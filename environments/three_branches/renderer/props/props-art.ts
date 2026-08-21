import { stableHashParts } from '@renderers/base/math.js'

/** Complete high-resolution pine stills available for stable placement selection. */
export const PINE_FRAME_NAMES = ['pineA', 'pineB', 'pineC', 'pineD', 'pineE', 'pineF'] as const

export type PropArtPage = 'props' | 'monuments' | 'lantern'
export type PropArtRole = 'lower' | 'upper'
type RegistrationRole = 'lower' | 'upper' | 'full'

/** One sprite role selected from a dedicated atlas page and state frame. */
export interface PropArtFrame {
  page: PropArtPage
  frame: string
  registrationRole?: RegistrationRole
  clip?: PropArtRole
}

/** The explicit lower and upper artwork roles for one recorded prop state. */
export interface PropTreatment {
  lower?: PropArtFrame
  upper?: PropArtFrame
}

type TreatmentByState = Readonly<Record<string, PropTreatment>>

const ordinary = (frame: string): PropTreatment => ({ lower: { page: 'props', frame } })
const pump = (frame: string): PropTreatment => ({
  lower: { page: 'monuments', frame, registrationRole: 'full', clip: 'lower' },
  upper: { page: 'monuments', frame, registrationRole: 'full', clip: 'upper' },
})
const bell = (frame: string): PropTreatment => ({
  lower: { page: 'monuments', frame: 'bellFoundation', registrationRole: 'lower' },
  upper: { page: 'monuments', frame, registrationRole: 'upper' },
})
const lantern = (frame: string): PropTreatment => ({
  lower: { page: 'lantern', frame, registrationRole: 'full', clip: 'lower' },
  upper: { page: 'lantern', frame, registrationRole: 'full', clip: 'upper' },
})

const TREATMENTS: Readonly<Record<string, TreatmentByState>> = {
  stall: { open: ordinary('stallOpen'), closed: ordinary('stallClosed') },
  lantern: { lit: lantern('lanternLit'), unlit: lantern('lanternUnlit') },
  bench: { occupied: ordinary('benchOccupied'), empty: ordinary('benchEmpty') },
  shrine: { tended: ordinary('shrineTended'), untended: ordinary('shrineUntended') },
  board: { none: ordinary('boardNone') },
  plot: { tended: ordinary('plotTended'), overgrown: ordinary('plotOvergrown') },
  hearth: { lit: ordinary('hearthLit'), unlit: ordinary('hearthUnlit') },
  repair_bench: { busy: ordinary('repairBenchBusy'), idle: ordinary('repairBenchIdle') },
  pump: { flowing: pump('pumpFlowing'), idle: pump('pumpIdle') },
  bell: { ringing: bell('bellRinging'), silent: bell('bellSilent') },
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

/** Symmetric props whose recorded facing is ignored: they always draw facing north. */
const FIXED_FACING_PROP_TYPES = new Set(['lantern', 'shrine', 'pump', 'bell'])

/** Whether a prop type draws fixed north, ignoring its recorded facing. */
export function isFixedFacingPropType(type: string): boolean {
  return FIXED_FACING_PROP_TYPES.has(type)
}

/** Resolve lower and upper artwork roles for one recorded prop state. */
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

/** Resolve one artwork role without coupling its page selection to presentation registration. */
export function propRoleTreatment(
  type: string,
  state: string,
  role: PropArtRole,
): PropArtFrame | null {
  return propTreatment(type, state)[role] ?? null
}

/** Whether any state of a shipped prop draws the requested retained sprite role. */
export function hasPropArtRole(type: string, role: PropArtRole): boolean {
  return Object.values(TREATMENTS[type] ?? {}).some((treatment) => treatment[role] !== undefined)
}

/** Select one fixed scenery frame from a catalog type and stable placement id. */
export function sceneryFrame(type: string, id: string): string {
  if (type === 'crate') return 'marketCrate'
  if (type === 'pine') {
    const index = stableHashParts('three-branches-scenery', id) % PINE_FRAME_NAMES.length
    return PINE_FRAME_NAMES.at(index) ?? PINE_FRAME_NAMES[0]
  }
  throw new Error(`Three Branches scenery type has no art frame: ${type}`)
}
