/** The material outside the authored grid. It closes every map-edge face. */
export const TERRAIN_EXTERIOR = '__exterior__'

/** Shoreline eligibility reaches full strength this far from a bridge-owned span. */
export const BRIDGE_SHORELINE_TAPER_CELLS = 0.25
const CURVE_BUCKET_SIZE_CELLS = 1

const CONTOURED_MATERIALS = new Set(['ground', 'field', 'reeds', 'water', 'road', 'path'])
const FIXED_MATERIALS = new Set(['interior', 'doorway', 'wall', TERRAIN_EXTERIOR])
const EPSILON = 1e-9

/** Numeric contour controls. The presentation configuration can satisfy this interface directly. */
export interface TerrainContourSettings {
  readonly smoothingPasses: number
  readonly cornerWeight: number
  readonly sampleSpacingCells: number
  readonly junctionTangentCells: number
  readonly noiseAmplitudeCells: number
  readonly noiseWavelengthCells: readonly [number, number]
  readonly maxDeviationCells: number
  readonly saddleRadiusCells: number
}

export interface ContourCoordinate {
  readonly x: number
  readonly y: number
}

/** One authored cell contributing semantic provenance to a contour side. */
export interface TerrainContourCell extends ContourCoordinate {
  readonly column: number
  readonly row: number
  readonly semantic: string
  readonly material: string
}

export interface TerrainContourSide {
  readonly material: string
  readonly semantics: readonly string[]
  readonly cells: readonly TerrainContourCell[]
}

/** A raw source span retained after smoothing for shore and structure treatments. */
export interface TerrainContourSpan {
  readonly startOffset: number
  readonly endOffset: number
  readonly left: TerrainContourSide
  readonly right: TerrainContourSide
  readonly fixed: boolean
  readonly saddle: boolean
  readonly shoreline: boolean
  readonly bridgeSuppressed: boolean
}

/** One emitted polyline point. Coordinates use cell units and top-first screen axes. */
export interface TerrainContourPoint extends ContourCoordinate {
  readonly rawOffset: number
  readonly locked: boolean
  readonly shorelineFactor: number
}

export interface TerrainShorelineSpan {
  readonly startOffset: number
  readonly endOffset: number
  readonly waterSemantics: readonly string[]
  readonly suppressed: boolean
}

/** One canonical curve shared by both incident faces. */
export interface TerrainContourChain {
  readonly id: string
  readonly closed: boolean
  readonly materials: readonly [string, string]
  readonly leftMaterial: string
  readonly rightMaterial: string
  readonly points: readonly TerrainContourPoint[]
  readonly rawPoints: readonly ContourCoordinate[]
  readonly rawLength: number
  readonly spans: readonly TerrainContourSpan[]
  readonly shorelineSpans: readonly TerrainShorelineSpan[]
}

/** A ring traverses a shared chain in canonical or exactly reversed order. */
export interface TerrainContourUse {
  readonly chainId: string
  readonly reversed: boolean
}

export interface TerrainContourRing {
  readonly id: string
  readonly componentId: string
  readonly material: string
  readonly role: 'outer' | 'hole'
  readonly uses: readonly TerrainContourUse[]
  readonly points: readonly ContourCoordinate[]
  /** Positive outer rings and negative holes follow the top-first screen coordinate system. */
  readonly signedArea: number
}

/** A connected material region with only its directly owned holes. */
export interface TerrainContourComponent {
  readonly id: string
  readonly material: string
  readonly exterior: boolean
  readonly cellCount: number
  readonly outerRingId: string
  readonly holeRingIds: readonly string[]
  readonly parentComponentId?: string
  readonly nestingDepth: number
}

export interface TerrainSaddle {
  readonly x: number
  readonly y: number
  readonly materials: readonly [string, string]
  readonly winner: string
  readonly radius: number
}

export interface TerrainContourPlan {
  readonly width: number
  readonly height: number
  readonly chains: readonly TerrainContourChain[]
  readonly rings: readonly TerrainContourRing[]
  readonly components: readonly TerrainContourComponent[]
  readonly saddles: readonly TerrainSaddle[]
}

interface CellRecord extends TerrainContourCell {
  readonly index: number
}

interface SaddleRecord extends TerrainSaddle {
  readonly winnerCells: readonly CellRecord[]
}

interface GraphNode extends ContourCoordinate {
  readonly id: string
  readonly segments: number[]
}

interface GraphSegment {
  readonly id: number
  readonly start: GraphNode
  readonly end: GraphNode
  readonly fixed: boolean
  readonly saddle: boolean
  left: SideRecord
  right: SideRecord
}

interface SideRecord extends TerrainContourSide {
  readonly componentKey: string
}

interface ChainAtom {
  readonly segment: GraphSegment
  readonly reversed: boolean
}

interface WorkingChain {
  id: string
  readonly closed: boolean
  readonly pairKey: string
  readonly atoms: readonly ChainAtom[]
  readonly rawPoints: readonly ContourCoordinate[]
  readonly rawLength: number
  readonly spans: readonly TerrainContourSpan[]
  readonly points: readonly TerrainContourPoint[]
  readonly materials: readonly [string, string]
  readonly leftMaterial: string
  readonly rightMaterial: string
  readonly shorelineSpans: readonly TerrainShorelineSpan[]
}

interface DirectedSegment {
  readonly segment: GraphSegment
  readonly reversed: boolean
}

interface WorkingRing {
  id: string
  readonly componentKey: string
  componentId: string
  readonly material: string
  readonly rawPoints: readonly ContourCoordinate[]
  readonly uses: readonly TerrainContourUse[]
  readonly points: readonly ContourCoordinate[]
  readonly signedArea: number
  role: 'outer' | 'hole'
}

interface ComponentRecord {
  readonly key: string
  readonly material: string
  readonly exterior: boolean
  readonly cells: readonly CellRecord[]
  id: string
  outerRingId: string
  holeRingIds: readonly string[]
  parentComponentId?: string
  nestingDepth: number
}

class DisjointSet {
  private readonly parent: number[]
  private readonly rank: number[]

  constructor(size: number) {
    this.parent = Array.from({ length: size }, (_, index) => index)
    this.rank = Array.from({ length: size }, () => 0)
  }

  find(value: number): number {
    const parent = this.parent[value]
    if (parent === undefined) throw new Error('Contour component index is out of range.')
    if (parent !== value) this.parent[value] = this.find(parent)
    return this.parent[value]!
  }

  union(first: number, second: number): void {
    let firstRoot = this.find(first)
    let secondRoot = this.find(second)
    if (firstRoot === secondRoot) return
    const firstRank = this.rank[firstRoot] ?? 0
    const secondRank = this.rank[secondRoot] ?? 0
    if (firstRank < secondRank) [firstRoot, secondRoot] = [secondRoot, firstRoot]
    this.parent[secondRoot] = firstRoot
    if (firstRank === secondRank) this.rank[firstRoot] = firstRank + 1
  }
}

/** Stable non-cryptographic hash for terrain geometry and static art choices. */
export function terrainHash(...parts: readonly (string | number)[]): number {
  let value = 2166136261
  for (const part of parts) {
    for (const character of String(part)) {
      value ^= character.charCodeAt(0)
      value = Math.imul(value, 16777619)
    }
    value ^= 31
    value = Math.imul(value, 16777619)
  }
  return value >>> 0
}

function avalancheHash(value: number): number {
  value ^= value >>> 16
  value = Math.imul(value, 0x7feb352d)
  value ^= value >>> 15
  value = Math.imul(value, 0x846ca68b)
  value ^= value >>> 16
  return value >>> 0
}

/** Pick a stable zero-based variant without relying on traversal or replay history. */
export function terrainVariant(count: number, ...parts: readonly (string | number)[]): number {
  if (!Number.isInteger(count) || count <= 0)
    throw new Error('Terrain variant count must be positive.')
  return avalancheHash(terrainHash(...parts)) % count
}

/**
 * Plan a closed, deterministic shared contour graph from top-first semantic rows.
 *
 * Bridge cells join the water material while remaining bridge-owned in span provenance.
 */
export function planTerrainContours(
  rows: readonly string[],
  groundNameForCode: Readonly<Record<string, string>>,
  settings: TerrainContourSettings,
  bridgeTaperCells = BRIDGE_SHORELINE_TAPER_CELLS,
): TerrainContourPlan {
  const { width, height } = validateInputs(rows, groundNameForCode, settings, bridgeTaperCells)
  const cells = buildCells(rows, groundNameForCode, width, height)
  const components = new DisjointSet(cells.length)
  unionCardinalComponents(cells, width, height, components)
  const saddles = findSaddles(cells, width, height, settings.saddleRadiusCells, components)
  const componentRecords = buildComponents(cells, components)
  const componentKeyForCell = new Map<number, string>()
  for (const component of componentRecords) {
    for (const cell of component.cells) componentKeyForCell.set(cell.index, component.key)
  }

  const graph = buildGraph(cells, width, height, saddles, componentKeyForCell)
  const workingChains = buildChains(graph.nodes, graph.segments, settings, bridgeTaperCells)
  validateCurveGraph(workingChains, settings.maxDeviationCells)

  const workingRings = buildRings(graph.nodes, graph.segments, workingChains)
  assignComponentAndRingIds(componentRecords, workingRings)
  assignComponentNesting(componentRecords, workingRings)
  validatePartition(workingChains, workingRings, componentRecords)

  return {
    width,
    height,
    chains: workingChains.map((chain) => ({
      id: chain.id,
      closed: chain.closed,
      materials: chain.materials,
      leftMaterial: chain.leftMaterial,
      rightMaterial: chain.rightMaterial,
      points: chain.points,
      rawPoints: chain.rawPoints,
      rawLength: chain.rawLength,
      spans: chain.spans,
      shorelineSpans: chain.shorelineSpans,
    })),
    rings: workingRings.map((ring) => ({
      id: ring.id,
      componentId: ring.componentId,
      material: ring.material,
      role: ring.role,
      uses: ring.uses,
      points: ring.points,
      signedArea: ring.signedArea,
    })),
    components: componentRecords.map((component) => ({
      id: component.id,
      material: component.material,
      exterior: component.exterior,
      cellCount: component.cells.length,
      outerRingId: component.outerRingId,
      holeRingIds: component.holeRingIds,
      ...(component.parentComponentId === undefined
        ? {}
        : { parentComponentId: component.parentComponentId }),
      nestingDepth: component.nestingDepth,
    })),
    saddles: saddles.map(({ winnerCells: _winnerCells, ...saddle }) => saddle),
  }
}

/** Concise alias for callers that already live in terrain-specific modules. */
export const planContours = planTerrainContours

function validateInputs(
  rows: readonly string[],
  groundNameForCode: Readonly<Record<string, string>>,
  settings: TerrainContourSettings,
  bridgeTaperCells: number,
): { width: number; height: number } {
  const width = rows[0]?.length ?? 0
  if (width === 0 || rows.some((row) => row.length !== width)) {
    throw new Error('Terrain contour planning requires a non-empty rectangular grid.')
  }
  for (const code of new Set(rows.join(''))) {
    const semantic = groundNameForCode[code]
    if (semantic === undefined)
      throw new Error(`Terrain code ${JSON.stringify(code)} has no ground name.`)
    const material = materialForSemantic(semantic)
    if (!CONTOURED_MATERIALS.has(material) && !FIXED_MATERIALS.has(material)) {
      throw new Error(`Terrain ground ${JSON.stringify(semantic)} cannot be contoured.`)
    }
  }
  if (!Number.isInteger(settings.smoothingPasses) || settings.smoothingPasses < 0) {
    throw new Error('Contour smoothing passes must be a non-negative integer.')
  }
  if (!(settings.cornerWeight > 0 && settings.cornerWeight <= 0.5)) {
    throw new Error('Contour corner weight must be greater than zero and at most 0.5.')
  }
  if (!(settings.sampleSpacingCells > 0 && settings.sampleSpacingCells <= 0.5)) {
    throw new Error('Contour sample spacing must be greater than zero and at most 0.5 cell.')
  }
  if (!(settings.junctionTangentCells >= 0 && settings.junctionTangentCells <= 0.5)) {
    throw new Error('Contour junction tangent must be between zero and 0.5 cell.')
  }
  if (!(settings.maxDeviationCells > 0 && settings.maxDeviationCells <= 0.15)) {
    throw new Error('Contour maximum deviation must be greater than zero and at most 0.15 cell.')
  }
  if (!(settings.noiseAmplitudeCells >= 0 && settings.noiseAmplitudeCells <= 0.06)) {
    throw new Error('Contour noise amplitude must be between zero and 0.06 cell.')
  }
  const [minimumWavelength, maximumWavelength] = settings.noiseWavelengthCells
  if (
    !(minimumWavelength >= 1.5 && maximumWavelength >= minimumWavelength && maximumWavelength <= 3)
  ) {
    throw new Error('Contour noise wavelength must be an ordered range within 1.5 to 3 cells.')
  }
  if (!(settings.saddleRadiusCells > 0 && settings.saddleRadiusCells <= 0.08)) {
    throw new Error('Contour saddle radius must be greater than zero and at most 0.08 cell.')
  }
  if (!Number.isFinite(bridgeTaperCells) || bridgeTaperCells < 0 || bridgeTaperCells > 1) {
    throw new Error('Bridge shoreline taper must be between zero and one cell.')
  }
  return { width, height: rows.length }
}

function materialForSemantic(semantic: string): string {
  return semantic === 'bridge' ? 'water' : semantic
}

function buildCells(
  rows: readonly string[],
  groundNameForCode: Readonly<Record<string, string>>,
  width: number,
  height: number,
): CellRecord[] {
  const cells: CellRecord[] = []
  for (let row = 0; row < height; row += 1) {
    for (let column = 0; column < width; column += 1) {
      const code = rows[row]?.[column]
      const semantic = code === undefined ? undefined : groundNameForCode[code]
      if (semantic === undefined)
        throw new Error('Terrain contour cell is missing its ground name.')
      cells.push({
        index: row * width + column,
        column,
        row,
        x: column + 0.5,
        y: row + 0.5,
        semantic,
        material: materialForSemantic(semantic),
      })
    }
  }
  return cells
}

function cellAt(
  cells: readonly CellRecord[],
  width: number,
  height: number,
  column: number,
  row: number,
): CellRecord | undefined {
  if (column < 0 || row < 0 || column >= width || row >= height) return undefined
  return cells[row * width + column]
}

function unionCardinalComponents(
  cells: readonly CellRecord[],
  width: number,
  height: number,
  components: DisjointSet,
): void {
  for (const cell of cells) {
    const east = cellAt(cells, width, height, cell.column + 1, cell.row)
    const south = cellAt(cells, width, height, cell.column, cell.row + 1)
    if (east?.material === cell.material) components.union(cell.index, east.index)
    if (south?.material === cell.material) components.union(cell.index, south.index)
  }
}

function findSaddles(
  cells: readonly CellRecord[],
  width: number,
  height: number,
  radius: number,
  components: DisjointSet,
): SaddleRecord[] {
  const saddles: SaddleRecord[] = []
  for (let y = 1; y < height; y += 1) {
    for (let x = 1; x < width; x += 1) {
      const northWest = cellAt(cells, width, height, x - 1, y - 1)!
      const northEast = cellAt(cells, width, height, x, y - 1)!
      const southEast = cellAt(cells, width, height, x, y)!
      const southWest = cellAt(cells, width, height, x - 1, y)!
      if (
        northWest.material !== southEast.material ||
        northEast.material !== southWest.material ||
        northWest.material === northEast.material
      ) {
        continue
      }
      const materials = [northWest.material, northEast.material].sort() as [string, string]
      const winner = materials[terrainVariant(2, 'terrain-saddle', x, y, ...materials)]!
      const winnerCells =
        winner === northWest.material ? [northWest, southEast] : [northEast, southWest]
      components.union(winnerCells[0]!.index, winnerCells[1]!.index)
      saddles.push({ x, y, materials, winner, radius, winnerCells })
    }
  }
  return saddles
}

function buildComponents(cells: readonly CellRecord[], components: DisjointSet): ComponentRecord[] {
  const byRoot = new Map<number, CellRecord[]>()
  for (const cell of cells) {
    const root = components.find(cell.index)
    const group = byRoot.get(root) ?? []
    group.push(cell)
    byRoot.set(root, group)
  }
  const records: ComponentRecord[] = [...byRoot.values()].map((group) => {
    const ordered = group.sort(compareCells)
    const first = ordered[0]!
    return {
      key: `cell:${first.index}`,
      material: first.material,
      exterior: false,
      cells: ordered,
      id: '',
      outerRingId: '',
      holeRingIds: [],
      nestingDepth: 0,
    } satisfies ComponentRecord
  })
  records.push({
    key: TERRAIN_EXTERIOR,
    material: TERRAIN_EXTERIOR,
    exterior: true,
    cells: [],
    id: '',
    outerRingId: '',
    holeRingIds: [],
    nestingDepth: 0,
  })
  return records.sort(
    (first, second) =>
      first.material.localeCompare(second.material) || first.key.localeCompare(second.key),
  )
}

function compareCells(first: CellRecord, second: CellRecord): number {
  return first.row - second.row || first.column - second.column
}

function buildGraph(
  cells: readonly CellRecord[],
  width: number,
  height: number,
  saddles: readonly SaddleRecord[],
  componentKeyForCell: ReadonlyMap<number, string>,
): { nodes: readonly GraphNode[]; segments: readonly GraphSegment[] } {
  const nodes = new Map<string, GraphNode>()
  const segments: GraphSegment[] = []
  const saddleAt = new Map(saddles.map((saddle) => [`${saddle.x}:${saddle.y}`, saddle]))

  const node = (id: string, x: number, y: number): GraphNode => {
    const existing = nodes.get(id)
    if (existing !== undefined) return existing
    const created = { id, x, y, segments: [] }
    nodes.set(id, created)
    return created
  }
  const endpoint = (x: number, y: number, direction: 'N' | 'E' | 'S' | 'W'): GraphNode => {
    const saddle = saddleAt.get(`${x}:${y}`)
    if (saddle === undefined) return node(`v:${x}:${y}`, x, y)
    const offsets = {
      N: [0, -saddle.radius],
      E: [saddle.radius, 0],
      S: [0, saddle.radius],
      W: [-saddle.radius, 0],
    } as const
    const [dx, dy] = offsets[direction]
    return node(`s:${x}:${y}:${direction}`, x + dx, y + dy)
  }
  const addSegment = (start: GraphNode, end: GraphNode, saddle: boolean): void => {
    if (samePoint(start, end))
      throw new Error('Terrain contour contains a zero-length source edge.')
    const left = sideAtSegment(
      start,
      end,
      true,
      cells,
      width,
      height,
      saddleAt,
      componentKeyForCell,
    )
    const right = sideAtSegment(
      start,
      end,
      false,
      cells,
      width,
      height,
      saddleAt,
      componentKeyForCell,
    )
    if (left.material === right.material) {
      throw new Error('Terrain contour source edge does not separate two materials.')
    }
    const fixed =
      saddle ||
      FIXED_MATERIALS.has(left.material) ||
      FIXED_MATERIALS.has(right.material) ||
      left.semantics.includes('bridge') ||
      right.semantics.includes('bridge')
    const segment = { id: segments.length, start, end, fixed, saddle, left, right }
    segments.push(segment)
    start.segments.push(segment.id)
    end.segments.push(segment.id)
  }

  for (let y = 0; y <= height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const north = cellAt(cells, width, height, x, y - 1)?.material ?? TERRAIN_EXTERIOR
      const south = cellAt(cells, width, height, x, y)?.material ?? TERRAIN_EXTERIOR
      if (north !== south) addSegment(endpoint(x, y, 'E'), endpoint(x + 1, y, 'W'), false)
    }
  }
  for (let x = 0; x <= width; x += 1) {
    for (let y = 0; y < height; y += 1) {
      const west = cellAt(cells, width, height, x - 1, y)?.material ?? TERRAIN_EXTERIOR
      const east = cellAt(cells, width, height, x, y)?.material ?? TERRAIN_EXTERIOR
      if (west !== east) addSegment(endpoint(x, y, 'S'), endpoint(x, y + 1, 'N'), false)
    }
  }
  for (const saddle of saddles) {
    const north = endpoint(saddle.x, saddle.y, 'N')
    const east = endpoint(saddle.x, saddle.y, 'E')
    const south = endpoint(saddle.x, saddle.y, 'S')
    const west = endpoint(saddle.x, saddle.y, 'W')
    const northWestMaterial = cellAt(cells, width, height, saddle.x - 1, saddle.y - 1)!.material
    if (saddle.winner === northWestMaterial) {
      addSegment(north, east, true)
      addSegment(south, west, true)
    } else {
      addSegment(west, north, true)
      addSegment(east, south, true)
    }
  }

  return {
    nodes: [...nodes.values()].sort((first, second) => first.id.localeCompare(second.id)),
    segments,
  }
}

function sideAtSegment(
  start: ContourCoordinate,
  end: ContourCoordinate,
  left: boolean,
  cells: readonly CellRecord[],
  width: number,
  height: number,
  saddleAt: ReadonlyMap<string, SaddleRecord>,
  componentKeyForCell: ReadonlyMap<number, string>,
): SideRecord {
  const dx = end.x - start.x
  const dy = end.y - start.y
  const length = Math.hypot(dx, dy)
  const direction = left ? 1 : -1
  const offset = Math.min(1e-5, length / 1000)
  return sideAtPoint(
    {
      x: (start.x + end.x) / 2 + direction * (-dy / length) * offset,
      y: (start.y + end.y) / 2 + direction * (dx / length) * offset,
    },
    cells,
    width,
    height,
    saddleAt,
    componentKeyForCell,
  )
}

function sideAtPoint(
  point: ContourCoordinate,
  cells: readonly CellRecord[],
  width: number,
  height: number,
  saddleAt: ReadonlyMap<string, SaddleRecord>,
  componentKeyForCell: ReadonlyMap<number, string>,
): SideRecord {
  const saddle = saddleAt.get(`${Math.round(point.x)}:${Math.round(point.y)}`)
  if (
    saddle !== undefined &&
    Math.abs(point.x - saddle.x) + Math.abs(point.y - saddle.y) < saddle.radius - EPSILON
  ) {
    return sideFromCells(saddle.winnerCells, componentKeyForCell)
  }
  const cell = cellAt(cells, width, height, Math.floor(point.x), Math.floor(point.y))
  if (cell === undefined) {
    return {
      material: TERRAIN_EXTERIOR,
      semantics: [TERRAIN_EXTERIOR],
      cells: [],
      componentKey: TERRAIN_EXTERIOR,
    }
  }
  return sideFromCells([cell], componentKeyForCell)
}

function sideFromCells(
  cells: readonly CellRecord[],
  componentKeyForCell: ReadonlyMap<number, string>,
): SideRecord {
  const first = cells[0]
  if (first === undefined) throw new Error('Terrain contour side has no source cell.')
  const componentKey = componentKeyForCell.get(first.index)
  if (componentKey === undefined) throw new Error('Terrain contour source cell has no component.')
  if (
    cells.some(
      (cell) =>
        cell.material !== first.material || componentKeyForCell.get(cell.index) !== componentKey,
    )
  ) {
    throw new Error('Terrain contour side crosses material components.')
  }
  return {
    material: first.material,
    semantics: [...new Set(cells.map((cell) => cell.semantic))].sort(),
    cells: [...cells].sort(compareCells),
    componentKey,
  }
}

function samePoint(first: ContourCoordinate, second: ContourCoordinate): boolean {
  return Math.abs(first.x - second.x) <= EPSILON && Math.abs(first.y - second.y) <= EPSILON
}

function segmentPair(segment: GraphSegment): readonly [string, string] {
  return [segment.left.material, segment.right.material].sort() as [string, string]
}

function pairKey(segment: GraphSegment): string {
  return segmentPair(segment).join('\u0000')
}

function buildChains(
  nodes: readonly GraphNode[],
  segments: readonly GraphSegment[],
  settings: TerrainContourSettings,
  bridgeTaperCells: number,
): WorkingChain[] {
  const segmentById = new Map(segments.map((segment) => [segment.id, segment]))
  const visited = new Set<number>()
  const sourceChains: Array<{
    readonly closed: boolean
    readonly pairKey: string
    readonly atoms: readonly ChainAtom[]
  }> = []

  const continues = (node: GraphNode, key: string): boolean =>
    node.segments.length === 2 &&
    node.segments.every((segmentId) => pairKey(segmentById.get(segmentId)!) === key)

  for (const seed of segments) {
    if (visited.has(seed.id)) continue
    const key = pairKey(seed)
    const start = !continues(seed.start, key)
      ? seed.start
      : !continues(seed.end, key)
        ? seed.end
        : seed.start
    const atoms: ChainAtom[] = []
    let node = start
    let segment = seed
    let closed = false
    while (true) {
      if (visited.has(segment.id)) {
        if (node === start) closed = true
        break
      }
      visited.add(segment.id)
      const reversed = segment.end === node
      atoms.push({ segment, reversed })
      node = reversed ? segment.start : segment.end
      if (!continues(node, key)) break
      const nextId = node.segments.find((segmentId) => segmentId !== segment.id)
      if (nextId === undefined) throw new Error('Terrain contour chain ended at a degree-two node.')
      segment = segmentById.get(nextId)!
    }
    sourceChains.push({ closed, pairKey: key, atoms: canonicalAtoms(atoms, closed) })
  }
  if (visited.size !== segments.length)
    throw new Error('Terrain contour chain ownership is incomplete.')

  const ordered = sourceChains.sort(
    (first, second) =>
      first.pairKey.localeCompare(second.pairKey) ||
      atomSequenceKey(first.atoms, first.closed).localeCompare(
        atomSequenceKey(second.atoms, second.closed),
      ),
  )
  return ordered.map((source, index) =>
    finishChain(source, `chain-${index}`, settings, bridgeTaperCells),
  )
}

function canonicalAtoms(atoms: readonly ChainAtom[], closed: boolean): readonly ChainAtom[] {
  if (atoms.length === 0) throw new Error('Terrain contour chain has no source edges.')
  if (!closed) {
    const first = atomStart(atoms[0]!)
    const last = atomEnd(atoms[atoms.length - 1]!)
    return compareCoordinates(first, last) <= 0 ? atoms : reverseAtoms(atoms)
  }
  let minimum = 0
  for (let index = 1; index < atoms.length; index += 1) {
    if (compareCoordinates(atomStart(atoms[index]!), atomStart(atoms[minimum]!)) < 0)
      minimum = index
  }
  const forward = rotate(atoms, minimum)
  const reversed = reverseAtoms(forward)
  const reversedMinimum = reversed.findIndex((atom) =>
    samePoint(atomStart(atom), atomStart(forward[0]!)),
  )
  const rotatedReverse = rotate(reversed, reversedMinimum)
  return atomSequenceKey(forward, true).localeCompare(atomSequenceKey(rotatedReverse, true)) <= 0
    ? forward
    : rotatedReverse
}

function atomStart(atom: ChainAtom): GraphNode {
  return atom.reversed ? atom.segment.end : atom.segment.start
}

function atomEnd(atom: ChainAtom): GraphNode {
  return atom.reversed ? atom.segment.start : atom.segment.end
}

function reverseAtoms(atoms: readonly ChainAtom[]): ChainAtom[] {
  return [...atoms].reverse().map((atom) => ({ segment: atom.segment, reversed: !atom.reversed }))
}

function rotate<T>(items: readonly T[], index: number): T[] {
  return [...items.slice(index), ...items.slice(0, index)]
}

function compareCoordinates(first: ContourCoordinate, second: ContourCoordinate): number {
  return first.y - second.y || first.x - second.x
}

function coordinateKey(point: ContourCoordinate): string {
  return `${point.y.toFixed(9)}:${point.x.toFixed(9)}`
}

function atomSequenceKey(atoms: readonly ChainAtom[], closed: boolean): string {
  const points = atoms.map(atomStart)
  if (!closed) points.push(atomEnd(atoms[atoms.length - 1]!))
  return points.map(coordinateKey).join('|')
}

function finishChain(
  source: {
    readonly closed: boolean
    readonly pairKey: string
    readonly atoms: readonly ChainAtom[]
  },
  id: string,
  settings: TerrainContourSettings,
  bridgeTaperCells: number,
): WorkingChain {
  const rawPoints: ContourCoordinate[] = [atomStart(source.atoms[0]!)]
  const spans: TerrainContourSpan[] = []
  let rawLength = 0
  for (const atom of source.atoms) {
    const start = atomStart(atom)
    const end = atomEnd(atom)
    if (!samePoint(rawPoints[rawPoints.length - 1]!, start)) {
      throw new Error('Terrain contour chain source edges are not continuous.')
    }
    const length = distance(start, end)
    const left = atom.reversed ? atom.segment.right : atom.segment.left
    const right = atom.reversed ? atom.segment.left : atom.segment.right
    const shoreline =
      (left.material === 'water' || right.material === 'water') &&
      left.material !== TERRAIN_EXTERIOR &&
      right.material !== TERRAIN_EXTERIOR
    const water = left.material === 'water' ? left : right.material === 'water' ? right : undefined
    spans.push({
      startOffset: rawLength,
      endOffset: rawLength + length,
      left,
      right,
      fixed: atom.segment.fixed,
      saddle: atom.segment.saddle,
      shoreline,
      bridgeSuppressed: shoreline && (water?.semantics.includes('bridge') ?? false),
    })
    rawLength += length
    rawPoints.push(end)
  }
  const firstSpan = spans[0]!
  if (
    spans.some(
      (span) =>
        span.left.material !== firstSpan.left.material ||
        span.right.material !== firstSpan.right.material,
    )
  ) {
    throw new Error('Terrain contour chain changes its incident material order.')
  }
  const materials = source.pairKey.split('\u0000') as [string, string]
  const shorelineSpans = spans
    .filter((span) => span.shoreline)
    .map((span) => {
      const water = span.left.material === 'water' ? span.left : span.right
      return {
        startOffset: span.startOffset,
        endOffset: span.endOffset,
        waterSemantics: water.semantics,
        suppressed: span.bridgeSuppressed,
      }
    })
  return {
    id,
    closed: source.closed,
    pairKey: source.pairKey,
    atoms: source.atoms,
    rawPoints,
    rawLength,
    spans,
    points: smoothChain(id, rawPoints, spans, rawLength, source.closed, settings, bridgeTaperCells),
    materials,
    leftMaterial: firstSpan.left.material,
    rightMaterial: firstSpan.right.material,
    shorelineSpans,
  }
}

interface WorkingPoint extends ContourCoordinate {
  readonly rawOffset: number
}

interface OffsetInterval {
  readonly startOffset: number
  readonly endOffset: number
}

interface ContourSpanIndex {
  readonly spans: readonly TerrainContourSpan[]
  readonly fixed: readonly OffsetInterval[]
  readonly bridgeSuppressed: readonly OffsetInterval[]
  readonly hasShoreline: boolean
}

function smoothChain(
  id: string,
  rawPoints: readonly ContourCoordinate[],
  spans: readonly TerrainContourSpan[],
  rawLength: number,
  closed: boolean,
  settings: TerrainContourSettings,
  bridgeTaperCells: number,
): TerrainContourPoint[] {
  let points = sampleRawChain(rawPoints, spans, settings.sampleSpacingCells, closed)
  for (let pass = 0; pass < settings.smoothingPasses; pass += 1) {
    points = chaikin(points, rawLength, closed, settings.cornerWeight)
  }
  const [minimumWavelength, maximumWavelength] = settings.noiseWavelengthCells
  const wavelengthUnit = terrainHash('contour-wavelength', id) / 2 ** 32
  const wavelength = minimumWavelength + wavelengthUnit * (maximumWavelength - minimumWavelength)
  const phase = (terrainHash('contour-phase', id) / 2 ** 32) * Math.PI * 2
  const rawIndex = indexRawPolyline(rawPoints)
  const spanIndex = indexContourSpans(spans)
  return points.map((point, index) => {
    const locked = offsetLocked(
      point.rawOffset,
      spanIndex.fixed,
      rawLength,
      closed,
      settings.junctionTangentCells,
    )
    const raw = rawPointAt(point.rawOffset, rawPoints, spanIndex.spans, rawLength, closed)
    if (locked)
      return {
        ...raw,
        rawOffset: normalizedOffset(point.rawOffset, rawLength, closed),
        locked,
        shorelineFactor: shorelineFactorAt(
          point.rawOffset,
          spanIndex,
          rawLength,
          closed,
          bridgeTaperCells,
        ),
      }
    const previous = points[(index - 1 + points.length) % points.length]!
    const next = points[(index + 1) % points.length]!
    const before = !closed && index === 0 ? point : previous
    const after = !closed && index === points.length - 1 ? point : next
    const tangentLength = Math.hypot(after.x - before.x, after.y - before.y) || 1
    const endpointFactor = closed
      ? 1
      : Math.min(1, point.rawOffset / 0.5, (rawLength - point.rawOffset) / 0.5)
    const noise =
      settings.noiseAmplitudeCells *
      endpointFactor *
      Math.sin((point.rawOffset / wavelength) * Math.PI * 2 + phase)
    const displaced = {
      x: point.x + (-(after.y - before.y) / tangentLength) * noise,
      y: point.y + ((after.x - before.x) / tangentLength) * noise,
    }
    const projection = projectToPolyline(displaced, rawIndex)
    const deviation = distance(displaced, projection.point)
    const limited =
      deviation <= settings.maxDeviationCells
        ? displaced
        : {
            x:
              projection.point.x +
              ((displaced.x - projection.point.x) / deviation) * settings.maxDeviationCells,
            y:
              projection.point.y +
              ((displaced.y - projection.point.y) / deviation) * settings.maxDeviationCells,
          }
    return {
      ...limited,
      rawOffset: normalizedOffset(point.rawOffset, rawLength, closed),
      locked,
      shorelineFactor: shorelineFactorAt(
        point.rawOffset,
        spanIndex,
        rawLength,
        closed,
        bridgeTaperCells,
      ),
    }
  })
}

function indexContourSpans(spans: readonly TerrainContourSpan[]): ContourSpanIndex {
  const byStartOffset = (first: OffsetInterval, second: OffsetInterval): number =>
    first.startOffset - second.startOffset
  return {
    spans,
    fixed: spans.filter((span) => span.fixed).sort(byStartOffset),
    bridgeSuppressed: spans.filter((span) => span.bridgeSuppressed).sort(byStartOffset),
    hasShoreline: spans.some((span) => span.shoreline),
  }
}

function sampleRawChain(
  rawPoints: readonly ContourCoordinate[],
  spans: readonly TerrainContourSpan[],
  spacing: number,
  closed: boolean,
): WorkingPoint[] {
  const points: WorkingPoint[] = []
  for (let index = 0; index < spans.length; index += 1) {
    const span = spans[index]!
    const start = rawPoints[index]!
    const end = rawPoints[index + 1]!
    const count = Math.max(1, Math.ceil((span.endOffset - span.startOffset) / spacing))
    for (let step = 0; step <= count; step += 1) {
      if ((index > 0 && step === 0) || (closed && index === spans.length - 1 && step === count)) {
        continue
      }
      const amount = step / count
      points.push({
        x: start.x + (end.x - start.x) * amount,
        y: start.y + (end.y - start.y) * amount,
        rawOffset: span.startOffset + (span.endOffset - span.startOffset) * amount,
      })
    }
  }
  return points
}

function chaikin(
  points: readonly WorkingPoint[],
  rawLength: number,
  closed: boolean,
  weight: number,
): WorkingPoint[] {
  if (points.length < 2) return [...points]
  const result: WorkingPoint[] = []
  const edgeCount = closed ? points.length : points.length - 1
  if (!closed) result.push(points[0]!)
  for (let index = 0; index < edgeCount; index += 1) {
    const first = points[index]!
    const second = points[(index + 1) % points.length]!
    let secondOffset = second.rawOffset
    if (closed && secondOffset <= first.rawOffset) secondOffset += rawLength
    result.push(
      interpolateWorking(first, second, first.rawOffset, secondOffset, weight, rawLength, closed),
    )
    result.push(
      interpolateWorking(
        first,
        second,
        first.rawOffset,
        secondOffset,
        1 - weight,
        rawLength,
        closed,
      ),
    )
  }
  if (!closed) result.push(points[points.length - 1]!)
  if (closed) {
    const minimum = result.reduce(
      (best, point, index) => (point.rawOffset < result[best]!.rawOffset ? index : best),
      0,
    )
    return rotate(result, minimum)
  }
  return result
}

function interpolateWorking(
  first: WorkingPoint,
  second: WorkingPoint,
  firstOffset: number,
  secondOffset: number,
  amount: number,
  rawLength: number,
  closed: boolean,
): WorkingPoint {
  return {
    x: first.x + (second.x - first.x) * amount,
    y: first.y + (second.y - first.y) * amount,
    rawOffset: normalizedOffset(
      firstOffset + (secondOffset - firstOffset) * amount,
      rawLength,
      closed,
    ),
  }
}

function normalizedOffset(offset: number, rawLength: number, closed: boolean): number {
  if (!closed) return Math.max(0, Math.min(rawLength, offset))
  const normalized = offset % rawLength
  return normalized < 0 ? normalized + rawLength : normalized
}

function rawPointAt(
  offset: number,
  rawPoints: readonly ContourCoordinate[],
  spans: readonly TerrainContourSpan[],
  rawLength: number,
  closed: boolean,
): ContourCoordinate {
  const normalized = normalizedOffset(offset, rawLength, closed)
  let lower = 0
  let upper = spans.length
  while (lower < upper) {
    const middle = Math.floor((lower + upper) / 2)
    if (spans[middle]!.endOffset > normalized + EPSILON) upper = middle
    else lower = middle + 1
  }
  const selectedIndex = Math.min(lower, spans.length - 1)
  const selected = spans[selectedIndex]!
  const start = rawPoints[selectedIndex]!
  const end = rawPoints[selectedIndex + 1]!
  const amount = Math.max(
    0,
    Math.min(1, (normalized - selected.startOffset) / (selected.endOffset - selected.startOffset)),
  )
  return { x: start.x + (end.x - start.x) * amount, y: start.y + (end.y - start.y) * amount }
}

function offsetLocked(
  offset: number,
  fixedIntervals: readonly OffsetInterval[],
  rawLength: number,
  closed: boolean,
  tangentLength: number,
): boolean {
  const normalized = normalizedOffset(offset, rawLength, closed)
  if (
    !closed &&
    (normalized <= tangentLength + EPSILON || rawLength - normalized <= tangentLength + EPSILON)
  ) {
    return true
  }
  return (
    nearestIntervalDistance(normalized, fixedIntervals, rawLength, closed) <=
    tangentLength + EPSILON
  )
}

function shorelineFactorAt(
  offset: number,
  spanIndex: ContourSpanIndex,
  rawLength: number,
  closed: boolean,
  taperCells: number,
): number {
  if (!spanIndex.hasShoreline) return 0
  if (spanIndex.bridgeSuppressed.length === 0) return 1
  const normalized = normalizedOffset(offset, rawLength, closed)
  const distance = nearestIntervalDistance(
    normalized,
    spanIndex.bridgeSuppressed,
    rawLength,
    closed,
  )
  if (taperCells === 0) return distance <= EPSILON ? 0 : 1
  return Math.min(1, distance / taperCells)
}

function nearestIntervalDistance(
  offset: number,
  intervals: readonly OffsetInterval[],
  length: number,
  closed: boolean,
): number {
  if (intervals.length === 0) return Number.POSITIVE_INFINITY
  let lower = 0
  let upper = intervals.length
  while (lower < upper) {
    const middle = Math.floor((lower + upper) / 2)
    if (intervals[middle]!.startOffset <= offset) lower = middle + 1
    else upper = middle
  }
  const candidateIndexes = closed
    ? [lower - 1, lower, 0, intervals.length - 1]
    : [lower - 1, lower]
  let nearest = Number.POSITIVE_INFINITY
  for (const index of candidateIndexes) {
    if (index < 0 || index >= intervals.length) continue
    const interval = intervals[index]!
    nearest = Math.min(
      nearest,
      circularDistanceToInterval(offset, interval.startOffset, interval.endOffset, length, closed),
    )
  }
  return nearest
}

function circularDistanceToInterval(
  offset: number,
  start: number,
  end: number,
  length: number,
  closed: boolean,
): number {
  const direct = offset < start ? start - offset : offset > end ? offset - end : 0
  if (!closed) return direct
  const below = Math.abs(offset + length - end)
  const above = Math.abs(start + length - offset)
  return Math.min(direct, below, above)
}

interface RawPolylineSegment {
  readonly start: ContourCoordinate
  readonly end: ContourCoordinate
}

interface RawPolylineIndex {
  readonly segments: readonly RawPolylineSegment[]
  readonly buckets: ReadonlyMap<string, readonly RawPolylineSegment[]>
}

/** Index raw source segments by cell so local contour adjustments avoid full-chain scans. */
function indexRawPolyline(points: readonly ContourCoordinate[]): RawPolylineIndex {
  const segments = points.slice(0, -1).map((start, index) => ({ start, end: points[index + 1]! }))
  const buckets = new Map<string, RawPolylineSegment[]>()
  for (const segment of segments) {
    const minimumX = Math.floor(Math.min(segment.start.x, segment.end.x))
    const maximumX = Math.floor(Math.max(segment.start.x, segment.end.x))
    const minimumY = Math.floor(Math.min(segment.start.y, segment.end.y))
    const maximumY = Math.floor(Math.max(segment.start.y, segment.end.y))
    for (let y = minimumY; y <= maximumY; y += 1) {
      for (let x = minimumX; x <= maximumX; x += 1) {
        const key = cellCoordinateKey(x, y)
        const bucket = buckets.get(key) ?? []
        bucket.push(segment)
        buckets.set(key, bucket)
      }
    }
  }
  return { segments, buckets }
}

function projectToPolyline(
  point: ContourCoordinate,
  index: RawPolylineIndex,
): { point: ContourCoordinate; distance: number } {
  const nearby = nearbyRawSegments(point, index)
  const candidates = nearby.length === 0 ? index.segments : nearby
  let nearest: ContourCoordinate = candidates[0]?.start ?? point
  let nearestDistance = Number.POSITIVE_INFINITY
  for (const segment of candidates) {
    const projected = projectToSegment(point, segment.start, segment.end)
    const candidateDistance = distance(point, projected)
    if (candidateDistance < nearestDistance) {
      nearest = projected
      nearestDistance = candidateDistance
    }
  }
  return { point: nearest, distance: nearestDistance }
}

/** Return raw segments in the point cell and its eight neighbors, without duplicate probes. */
function nearbyRawSegments(
  point: ContourCoordinate,
  index: RawPolylineIndex,
): readonly RawPolylineSegment[] {
  const column = Math.floor(point.x)
  const row = Math.floor(point.y)
  const segments = new Set<RawPolylineSegment>()
  for (let y = row - 1; y <= row + 1; y += 1) {
    for (let x = column - 1; x <= column + 1; x += 1) {
      for (const segment of index.buckets.get(cellCoordinateKey(x, y)) ?? []) segments.add(segment)
    }
  }
  return [...segments]
}

function projectToSegment(
  point: ContourCoordinate,
  start: ContourCoordinate,
  end: ContourCoordinate,
): ContourCoordinate {
  const dx = end.x - start.x
  const dy = end.y - start.y
  const lengthSquared = dx * dx + dy * dy
  if (lengthSquared <= EPSILON) return start
  const amount = Math.max(
    0,
    Math.min(1, ((point.x - start.x) * dx + (point.y - start.y) * dy) / lengthSquared),
  )
  return { x: start.x + dx * amount, y: start.y + dy * amount }
}

function distance(first: ContourCoordinate, second: ContourCoordinate): number {
  return Math.hypot(second.x - first.x, second.y - first.y)
}

function buildRings(
  nodes: readonly GraphNode[],
  segments: readonly GraphSegment[],
  chains: readonly WorkingChain[],
): WorkingRing[] {
  const segmentById = new Map(segments.map((segment) => [segment.id, segment]))
  const nodeById = new Map(nodes.map((node) => [node.id, node]))
  const placement = new Map<number, { chain: WorkingChain; reversed: boolean }>()
  for (const chain of chains) {
    for (const atom of chain.atoms) {
      if (placement.has(atom.segment.id))
        throw new Error('Terrain contour edge has duplicate chain ownership.')
      placement.set(atom.segment.id, { chain, reversed: atom.reversed })
    }
  }
  const visited = new Set<string>()
  const rings: WorkingRing[] = []
  const chainById = new Map(chains.map((chain) => [chain.id, chain]))
  for (const segment of segments) {
    for (const reversed of [false, true]) {
      const startKey = directedKey(segment.id, reversed)
      if (visited.has(startKey)) continue
      const darts: DirectedSegment[] = []
      let current: DirectedSegment = { segment, reversed }
      while (true) {
        const key = directedKey(current.segment.id, current.reversed)
        if (visited.has(key)) {
          if (key !== startKey)
            throw new Error('Terrain contour half-edge entered a different face cycle.')
          break
        }
        visited.add(key)
        darts.push(current)
        current = nextDirectedSegment(current, segmentById, nodeById)
      }
      const firstSide = directedLeft(darts[0]!)
      if (
        darts.some((dart) => {
          const side = directedLeft(dart)
          return (
            side.material !== firstSide.material || side.componentKey !== firstSide.componentKey
          )
        })
      ) {
        throw new Error('Terrain contour face cycle changes ownership.')
      }
      const rawUses = darts.map((dart) => {
        const owned = placement.get(dart.segment.id)
        if (owned === undefined) throw new Error('Terrain contour face references an unowned edge.')
        return { chainId: owned.chain.id, reversed: dart.reversed !== owned.reversed }
      })
      const uses = canonicalUses(compactCircularUses(rawUses))
      const rawPoints = pathForUses(uses, chainById, true)
      const points = pathForUses(uses, chainById, false)
      const rawArea = signedArea(rawPoints)
      rings.push({
        id: '',
        componentKey: firstSide.componentKey,
        componentId: '',
        material: firstSide.material,
        rawPoints,
        uses,
        points,
        signedArea: signedArea(points),
        role: rawArea >= 0 ? 'outer' : 'hole',
      })
    }
  }
  if (visited.size !== segments.length * 2)
    throw new Error('Terrain contour graph has open face ownership.')
  return rings
}

function directedKey(segmentId: number, reversed: boolean): string {
  return `${segmentId}:${reversed ? 1 : 0}`
}

function directedStart(directed: DirectedSegment): GraphNode {
  return directed.reversed ? directed.segment.end : directed.segment.start
}

function directedEnd(directed: DirectedSegment): GraphNode {
  return directed.reversed ? directed.segment.start : directed.segment.end
}

function directedLeft(directed: DirectedSegment): SideRecord {
  return directed.reversed ? directed.segment.right : directed.segment.left
}

function nextDirectedSegment(
  directed: DirectedSegment,
  segmentById: ReadonlyMap<number, GraphSegment>,
  nodeById: ReadonlyMap<string, GraphNode>,
): DirectedSegment {
  const end = directedEnd(directed)
  const node = nodeById.get(end.id)
  if (node === undefined || node.segments.length < 2)
    throw new Error('Terrain contour face is open.')
  const outgoing = node.segments
    .map((segmentId) => {
      const segment = segmentById.get(segmentId)!
      const candidate: DirectedSegment = { segment, reversed: segment.end === node }
      const target = directedEnd(candidate)
      return { candidate, angle: Math.atan2(target.y - node.y, target.x - node.x) }
    })
    .sort(
      (first, second) =>
        first.angle - second.angle || first.candidate.segment.id - second.candidate.segment.id,
    )
  const reverseIndex = outgoing.findIndex(
    (item) => item.candidate.segment.id === directed.segment.id,
  )
  if (reverseIndex < 0) throw new Error('Terrain contour node lost its incoming half-edge.')
  return outgoing[(reverseIndex - 1 + outgoing.length) % outgoing.length]!.candidate
}

function compactCircularUses(uses: readonly TerrainContourUse[]): TerrainContourUse[] {
  const compact: TerrainContourUse[] = []
  for (const use of uses) {
    const previous = compact[compact.length - 1]
    if (previous?.chainId === use.chainId && previous.reversed === use.reversed) continue
    compact.push(use)
  }
  if (
    compact.length > 1 &&
    compact[0]!.chainId === compact[compact.length - 1]!.chainId &&
    compact[0]!.reversed === compact[compact.length - 1]!.reversed
  ) {
    compact.pop()
  }
  return compact
}

function canonicalUses(uses: readonly TerrainContourUse[]): TerrainContourUse[] {
  if (uses.length === 0) throw new Error('Terrain contour face has no shared chains.')
  let minimum = 0
  for (let index = 1; index < uses.length; index += 1) {
    const candidate = `${uses[index]!.chainId}:${uses[index]!.reversed ? 1 : 0}`
    const current = `${uses[minimum]!.chainId}:${uses[minimum]!.reversed ? 1 : 0}`
    if (candidate.localeCompare(current) < 0) minimum = index
  }
  return rotate(uses, minimum)
}

function pathForUses(
  uses: readonly TerrainContourUse[],
  chainById: ReadonlyMap<string, WorkingChain>,
  raw: boolean,
): ContourCoordinate[] {
  const result: ContourCoordinate[] = []
  for (const use of uses) {
    const chain = chainById.get(use.chainId)
    if (chain === undefined) throw new Error('Terrain contour ring references a missing chain.')
    let points: readonly ContourCoordinate[] = raw ? chain.rawPoints : chain.points
    if (use.reversed) points = [...points].reverse()
    for (const point of points) {
      if (result.length === 0 || !samePoint(result[result.length - 1]!, point))
        result.push({ x: point.x, y: point.y })
    }
  }
  if (!samePoint(result[0]!, result[result.length - 1]!)) result.push({ ...result[0]! })
  return result
}

function signedArea(points: readonly ContourCoordinate[]): number {
  let twiceArea = 0
  for (let index = 0; index < points.length - 1; index += 1) {
    const first = points[index]!
    const second = points[index + 1]!
    twiceArea += first.x * second.y - second.x * first.y
  }
  return twiceArea / 2
}

function assignComponentAndRingIds(
  components: readonly ComponentRecord[],
  rings: WorkingRing[],
): void {
  components.forEach((component, index) => {
    component.id = `component-${index}`
  })
  const componentByKey = new Map(components.map((component) => [component.key, component]))
  rings.sort(
    (first, second) =>
      componentByKey
        .get(first.componentKey)!
        .id.localeCompare(componentByKey.get(second.componentKey)!.id) ||
      first.role.localeCompare(second.role) ||
      coordinateKey(first.rawPoints[0]!).localeCompare(coordinateKey(second.rawPoints[0]!)),
  )
  const ringsByComponent = new Map<string, WorkingRing[]>()
  rings.forEach((ring, index) => {
    ring.id = `ring-${index}`
    const component = componentByKey.get(ring.componentKey)
    if (component === undefined) throw new Error('Terrain contour ring has no component.')
    ring.componentId = component.id
    if (component.exterior) ring.role = 'outer'
    const owned = ringsByComponent.get(component.id) ?? []
    owned.push(ring)
    ringsByComponent.set(component.id, owned)
  })
  for (const component of components) {
    const owned = ringsByComponent.get(component.id) ?? []
    const outers = owned.filter((ring) => ring.role === 'outer')
    if (outers.length !== 1) {
      throw new Error(`Terrain contour component ${component.id} needs exactly one outer ring.`)
    }
    component.outerRingId = outers[0]!.id
    component.holeRingIds = owned.filter((ring) => ring.role === 'hole').map((ring) => ring.id)
  }
}

function assignComponentNesting(
  components: readonly ComponentRecord[],
  rings: readonly WorkingRing[],
): void {
  const ringById = new Map(rings.map((ring) => [ring.id, ring]))
  const candidatesByCell = outerRingCandidatesByCell(components, ringById)
  for (const component of components) {
    if (component.exterior || component.cells.length === 0) continue
    const sample = component.cells[0]!
    const ownOuter = ringById.get(component.outerRingId)!
    const containers = (candidatesByCell.get(cellCoordinateKey(sample.column, sample.row)) ?? [])
      .filter((candidate) => candidate !== component)
      .map((candidate) => ({ candidate, ring: ringById.get(candidate.outerRingId)! }))
      .filter(
        ({ ring }) =>
          Math.abs(signedArea(ring.rawPoints)) > Math.abs(signedArea(ownOuter.rawPoints)) + EPSILON,
      )
      .filter(({ ring }) => pointInPolygon(sample, ring.rawPoints))
      .sort(
        (first, second) =>
          Math.abs(signedArea(first.ring.rawPoints)) -
            Math.abs(signedArea(second.ring.rawPoints)) ||
          first.candidate.id.localeCompare(second.candidate.id),
      )
    component.parentComponentId = containers[0]?.candidate.id
  }
  const byId = new Map(components.map((component) => [component.id, component]))
  const depthFor = (component: ComponentRecord, seen = new Set<string>()): number => {
    if (component.parentComponentId === undefined) return 0
    if (seen.has(component.id))
      throw new Error('Terrain contour component nesting contains a cycle.')
    seen.add(component.id)
    const parent = byId.get(component.parentComponentId)
    if (parent === undefined)
      throw new Error('Terrain contour component has a missing nesting parent.')
    return 1 + depthFor(parent, seen)
  }
  for (const component of components) component.nestingDepth = depthFor(component)
}

/** Index candidate outer-ring bounds by the semantic cell centers they can contain. */
function outerRingCandidatesByCell(
  components: readonly ComponentRecord[],
  ringById: ReadonlyMap<string, WorkingRing>,
): ReadonlyMap<string, readonly ComponentRecord[]> {
  const candidates = new Map<string, ComponentRecord[]>()
  for (const component of components) {
    if (component.exterior || component.cells.length === 0) continue
    const ring = ringById.get(component.outerRingId)
    if (ring === undefined) throw new Error('Terrain contour component has a missing outer ring.')
    const bounds = ringBounds(ring.rawPoints)
    for (let row = Math.floor(bounds.minimumY); row <= Math.floor(bounds.maximumY); row += 1) {
      for (
        let column = Math.floor(bounds.minimumX);
        column <= Math.floor(bounds.maximumX);
        column += 1
      ) {
        const key = cellCoordinateKey(column, row)
        const bucket = candidates.get(key) ?? []
        bucket.push(component)
        candidates.set(key, bucket)
      }
    }
  }
  return candidates
}

function ringBounds(points: readonly ContourCoordinate[]): {
  minimumX: number
  maximumX: number
  minimumY: number
  maximumY: number
} {
  return points.reduce(
    (bounds, point) => ({
      minimumX: Math.min(bounds.minimumX, point.x),
      maximumX: Math.max(bounds.maximumX, point.x),
      minimumY: Math.min(bounds.minimumY, point.y),
      maximumY: Math.max(bounds.maximumY, point.y),
    }),
    {
      minimumX: Number.POSITIVE_INFINITY,
      maximumX: Number.NEGATIVE_INFINITY,
      minimumY: Number.POSITIVE_INFINITY,
      maximumY: Number.NEGATIVE_INFINITY,
    },
  )
}

function cellCoordinateKey(column: number, row: number): string {
  return `${column}:${row}`
}

function pointInPolygon(point: ContourCoordinate, polygon: readonly ContourCoordinate[]): boolean {
  let inside = false
  for (
    let firstIndex = 0, secondIndex = polygon.length - 1;
    firstIndex < polygon.length;
    secondIndex = firstIndex++
  ) {
    const first = polygon[firstIndex]!
    const second = polygon[secondIndex]!
    const crosses =
      first.y > point.y !== second.y > point.y &&
      point.x < ((second.x - first.x) * (point.y - first.y)) / (second.y - first.y) + first.x
    if (crosses) inside = !inside
  }
  return inside
}

interface CurvePiece {
  readonly chain: WorkingChain
  readonly rawIndex: RawPolylineIndex
  readonly index: number
  readonly start: ContourCoordinate
  readonly end: ContourCoordinate
  readonly count: number
}

function validateCurveGraph(chains: readonly WorkingChain[], maxDeviation: number): void {
  const pieces = chains.flatMap((chain) => {
    if (chain.points.length < 2) throw new Error('Terrain contour chain emitted too few points.')
    const points = chain.closed ? [...chain.points, chain.points[0]!] : chain.points
    const rawIndex = indexRawPolyline(chain.rawPoints)
    return points.slice(0, -1).map((start, index) => ({
      chain,
      rawIndex,
      index,
      start,
      end: points[index + 1]!,
      count: points.length - 1,
    }))
  })
  for (const piece of pieces) {
    if (!segmentStaysInTube(piece.start, piece.end, piece.rawIndex, maxDeviation)) {
      throw new Error('Terrain contour curve escaped its source tube.')
    }
  }
  for (const [first, second] of spatialCurvePairs(pieces)) {
    if (
      first.chain === second.chain &&
      piecesAreAdjacent(first, second) &&
      adjacentPiecesMeetOnlyAtEndpoint(first, second)
    ) {
      continue
    }
    if (!segmentsIntersect(first.start, first.end, second.start, second.end)) continue
    if (adjacentPiecesMeetOnlyAtEndpoint(first, second) || incidentIntersection(first, second))
      continue
    throw new Error('Terrain contour curves contain a nonincident intersection.')
  }
}

/** Return each pair of locally overlapping curve pieces once in deterministic insertion order. */
function spatialCurvePairs(
  pieces: readonly CurvePiece[],
): readonly (readonly [CurvePiece, CurvePiece])[] {
  const buckets = new Map<string, CurvePiece[]>()
  const indexes = new Map(pieces.map((piece, index) => [piece, index]))
  const pairs: [CurvePiece, CurvePiece][] = []
  const seen = new Set<string>()
  for (let index = 0; index < pieces.length; index += 1) {
    const piece = pieces[index]!
    for (const key of curveBucketKeys(piece)) {
      const bucket = buckets.get(key) ?? []
      for (const earlier of bucket) {
        const pairKey = `${indexes.get(earlier)!}:${index}`
        if (seen.has(pairKey)) continue
        seen.add(pairKey)
        pairs.push([earlier, piece])
      }
      bucket.push(piece)
      buckets.set(key, bucket)
    }
  }
  return pairs
}

function curveBucketKeys(piece: Pick<CurvePiece, 'start' | 'end'>): readonly string[] {
  const minimumX = Math.floor(Math.min(piece.start.x, piece.end.x) / CURVE_BUCKET_SIZE_CELLS)
  const maximumX = Math.floor(Math.max(piece.start.x, piece.end.x) / CURVE_BUCKET_SIZE_CELLS)
  const minimumY = Math.floor(Math.min(piece.start.y, piece.end.y) / CURVE_BUCKET_SIZE_CELLS)
  const maximumY = Math.floor(Math.max(piece.start.y, piece.end.y) / CURVE_BUCKET_SIZE_CELLS)
  const keys: string[] = []
  for (let y = minimumY; y <= maximumY; y += 1) {
    for (let x = minimumX; x <= maximumX; x += 1) keys.push(`${x}:${y}`)
  }
  return keys
}

/** Prove the full emitted segment stays in the source tube through adaptive 1-Lipschitz bounds. */
function segmentStaysInTube(
  start: ContourCoordinate,
  end: ContourCoordinate,
  rawIndex: RawPolylineIndex,
  maxDeviation: number,
  depth = 0,
): boolean {
  const middle = { x: (start.x + end.x) / 2, y: (start.y + end.y) / 2 }
  const maximumDistance = Math.max(
    projectToPolyline(start, rawIndex).distance,
    projectToPolyline(middle, rawIndex).distance,
    projectToPolyline(end, rawIndex).distance,
  )
  const quarterLength = distance(start, end) / 4
  if (maximumDistance + quarterLength <= maxDeviation + 1e-7) return true
  if (depth >= 18) return maximumDistance <= maxDeviation + 1e-7
  return (
    segmentStaysInTube(start, middle, rawIndex, maxDeviation, depth + 1) &&
    segmentStaysInTube(middle, end, rawIndex, maxDeviation, depth + 1)
  )
}

function piecesAreAdjacent(
  first: { readonly chain: WorkingChain; readonly index: number; readonly count: number },
  second: { readonly chain: WorkingChain; readonly index: number; readonly count: number },
): boolean {
  if (Math.abs(first.index - second.index) === 1) return true
  return (
    first.chain.closed &&
    new Set([first.index, second.index]).has(0) &&
    new Set([first.index, second.index]).has(first.count - 1)
  )
}

function adjacentPiecesMeetOnlyAtEndpoint(
  first: { readonly start: ContourCoordinate; readonly end: ContourCoordinate },
  second: { readonly start: ContourCoordinate; readonly end: ContourCoordinate },
): boolean {
  const shared = [first.start, first.end].find(
    (point) => samePoint(point, second.start) || samePoint(point, second.end),
  )
  if (shared === undefined) return false
  const firstOther = samePoint(first.start, shared) ? first.end : first.start
  const secondOther = samePoint(second.start, shared) ? second.end : second.start
  const firstVector = { x: firstOther.x - shared.x, y: firstOther.y - shared.y }
  const secondVector = { x: secondOther.x - shared.x, y: secondOther.y - shared.y }
  const cross = firstVector.x * secondVector.y - firstVector.y * secondVector.x
  if (Math.abs(cross) > EPSILON) return true
  return firstVector.x * secondVector.x + firstVector.y * secondVector.y <= EPSILON
}

function incidentIntersection(
  first: {
    readonly chain: WorkingChain
    readonly start: ContourCoordinate
    readonly end: ContourCoordinate
  },
  second: {
    readonly chain: WorkingChain
    readonly start: ContourCoordinate
    readonly end: ContourCoordinate
  },
): boolean {
  if (first.chain.closed || second.chain.closed) return false
  const firstEndpoints = [
    first.chain.points[0]!,
    first.chain.points[first.chain.points.length - 1]!,
  ]
  const secondEndpoints = [
    second.chain.points[0]!,
    second.chain.points[second.chain.points.length - 1]!,
  ]
  return firstEndpoints.some((firstEndpoint) =>
    secondEndpoints.some(
      (secondEndpoint) =>
        samePoint(firstEndpoint, secondEndpoint) &&
        (samePoint(first.start, firstEndpoint) || samePoint(first.end, firstEndpoint)) &&
        (samePoint(second.start, secondEndpoint) || samePoint(second.end, secondEndpoint)),
    ),
  )
}

function segmentsIntersect(
  firstStart: ContourCoordinate,
  firstEnd: ContourCoordinate,
  secondStart: ContourCoordinate,
  secondEnd: ContourCoordinate,
): boolean {
  const firstSide = orientation(firstStart, firstEnd, secondStart)
  const secondSide = orientation(firstStart, firstEnd, secondEnd)
  const thirdSide = orientation(secondStart, secondEnd, firstStart)
  const fourthSide = orientation(secondStart, secondEnd, firstEnd)
  if (
    ((firstSide > EPSILON && secondSide < -EPSILON) ||
      (firstSide < -EPSILON && secondSide > EPSILON)) &&
    ((thirdSide > EPSILON && fourthSide < -EPSILON) ||
      (thirdSide < -EPSILON && fourthSide > EPSILON))
  ) {
    return true
  }
  return (
    (Math.abs(firstSide) <= EPSILON && pointOnSegment(secondStart, firstStart, firstEnd)) ||
    (Math.abs(secondSide) <= EPSILON && pointOnSegment(secondEnd, firstStart, firstEnd)) ||
    (Math.abs(thirdSide) <= EPSILON && pointOnSegment(firstStart, secondStart, secondEnd)) ||
    (Math.abs(fourthSide) <= EPSILON && pointOnSegment(firstEnd, secondStart, secondEnd))
  )
}

function orientation(
  start: ContourCoordinate,
  end: ContourCoordinate,
  point: ContourCoordinate,
): number {
  return (end.x - start.x) * (point.y - start.y) - (end.y - start.y) * (point.x - start.x)
}

function pointOnSegment(
  point: ContourCoordinate,
  start: ContourCoordinate,
  end: ContourCoordinate,
): boolean {
  return (
    point.x >= Math.min(start.x, end.x) - EPSILON &&
    point.x <= Math.max(start.x, end.x) + EPSILON &&
    point.y >= Math.min(start.y, end.y) - EPSILON &&
    point.y <= Math.max(start.y, end.y) + EPSILON
  )
}

function validatePartition(
  chains: readonly WorkingChain[],
  rings: readonly WorkingRing[],
  components: readonly ComponentRecord[],
): void {
  const uses = new Map<string, TerrainContourUse[]>()
  for (const ring of rings) {
    if (
      ring.points.length < 4 ||
      !samePoint(ring.points[0]!, ring.points[ring.points.length - 1]!)
    ) {
      throw new Error('Terrain contour face is open.')
    }
    for (const use of ring.uses) {
      const owned = uses.get(use.chainId) ?? []
      owned.push(use)
      uses.set(use.chainId, owned)
    }
  }
  for (const chain of chains) {
    const owned = uses.get(chain.id) ?? []
    if (owned.length !== 2 || owned[0]!.reversed === owned[1]!.reversed) {
      throw new Error('Terrain contour shared chain must have exact reversed ownership.')
    }
  }
  if (uses.size !== chains.length)
    throw new Error('Terrain contour rings reference an unknown shared chain.')
  for (const component of components) {
    if (component.outerRingId === '')
      throw new Error('Terrain contour component has no outer face.')
  }
}
