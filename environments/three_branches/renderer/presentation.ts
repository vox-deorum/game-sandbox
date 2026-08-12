/** Logical dimensions exposed to the renderer host. */
export interface RendererSize {
  /** Logical canvas width. */
  width: number
  /** Logical canvas height. */
  height: number
}

/** Tunable presentation values that are not part of the environment rules. */
export interface ThreeBranchesPresentation {
  /** Fixed logical surface advertised to the host. */
  internalSize: RendererSize
  /** Height of the fixed diagnostic strip. */
  chromeHeight: number
  /** Renderer world units used for one configured metre. */
  unitsPerMetre: number
  /** World-space padding used to derive camera limits. */
  cameraPadding: number
  /** Maximum zoom expressed as a multiple of fitted zoom. */
  maxZoomFactor: number
  /** Visitor-focused opening zoom expressed as a multiple of fitted zoom. */
  focusZoomFactor: number
  /** Natural wall-clock duration used to interpolate one environment tick. */
  movementDurationMs: number
}

/** Provisional renderer choices kept separate from rules and recorded game state. */
export const THREE_BRANCHES_PRESENTATION: ThreeBranchesPresentation = {
  internalSize: { width: 1200, height: 1000 },
  chromeHeight: 54,
  unitsPerMetre: 16,
  cameraPadding: 20,
  maxZoomFactor: 4,
  focusZoomFactor: 2,
  movementDurationMs: 1000,
} as const

/** Semantic provisional colors consumed by the renderer drawing modules. */
export interface ThreeBranchesPalette {
  /** Canvas backdrop. */
  backdrop: string
  /** Fixed chrome surface. */
  chrome: string
  /** Primary label color. */
  text: string
  /** Secondary label and border color. */
  muted: string
  /** Ordinary ground. */
  ground: string
  /** Road ground. */
  road: string
  /** Footpath ground. */
  path: string
  /** Bridge ground. */
  bridge: string
  /** Building interior ground. */
  interior: string
  /** Open doorway ground. */
  doorway: string
  /** Field ground. */
  field: string
  /** Reeds ground. */
  reeds: string
  /** Water ground. */
  water: string
  /** Building wall ground. */
  wall: string
  /** Semantic building outline. */
  building: string
  /** Interactive prop fill. */
  prop: string
  /** Solid scenery fill. */
  scenery: string
  /** Visitor body fill. */
  visitor: string
  /** NPC body fill. */
  npc: string
  /** Impassable-ground collision color. */
  blockedCollision: string
  /** Prop and scenery collision color. */
  objectCollision: string
  /** Character-body collision color. */
  characterCollision: string
  /** World-boundary collision color. */
  boundaryCollision: string
}

/** Diagnostic colors used until the signed art stage replaces the provisional drawing. */
export const PALETTE: ThreeBranchesPalette = {
  backdrop: '#17211f',
  chrome: '#202b29',
  text: '#f5f3ea',
  muted: '#b8c7c4',
  ground: '#718760',
  road: '#b58a5a',
  path: '#c4aa78',
  bridge: '#8b6b4d',
  interior: '#c6b78f',
  doorway: '#d8c690',
  field: '#8c9550',
  reeds: '#5f8067',
  water: '#39758f',
  wall: '#4a4038',
  building: '#6a4d3a',
  prop: '#d99b45',
  scenery: '#4f7454',
  visitor: '#f1c75b',
  npc: '#e8e1d4',
  blockedCollision: '#ff5c5c',
  objectCollision: '#ffd166',
  characterCollision: '#66e3ff',
  boundaryCollision: '#ff4fd8',
} as const

/** Resolve configured ground semantics to provisional paint without making codes authoritative. */
export function groundColor(name: string): string {
  return PALETTE[name as keyof typeof PALETTE] ?? PALETTE.ground
}
