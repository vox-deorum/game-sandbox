/** Grid and scale values recorded once for a village. */
export interface VillageSize {
  /** Number of cells across the village. */
  cellsX: number
  /** Number of cells from south to north. */
  cellsY: number
  /** Length of one cell edge in configured metres. */
  cellSize: number
}

/** A point in the environment's configured, north-up metre space. */
export interface VillagePoint {
  /** Distance east of the frame's west edge. */
  x: number
  /** Distance north of the frame's south edge. */
  y: number
}

/** One integer cell in the recorded north-up village grid. */
export interface Cell {
  /** Column counted from the west edge. */
  x: number
  /** Row counted from the south edge. */
  y: number
}

/** A semantic building placement from the static recording header. */
export interface StaticBuilding {
  /** Stable building identifier. */
  id: string
  /** Catalog building token. */
  type: string
  /** South-west origin cell. */
  cell: Cell
}

/** An interactive prop placement from the static recording header. */
export interface StaticProp extends StaticBuilding {
  /** Cardinal presentation direction, which does not rotate collision. */
  facing: string
}

/** A non-interactive solid placement from the static recording header. */
export interface StaticScenery {
  /** Catalog scenery token. */
  type: string
  /** South-west origin cell. */
  cell: Cell
}

/** Immutable village data carried once in `RecordingHeader.overlay_static`. */
export interface VillageStatic {
  /** Configured grid dimensions and cell scale. */
  size: VillageSize
  /** Ground rows in their recorded south-first order. */
  ground: readonly string[]
  /** Semantic building placements. */
  buildings: readonly StaticBuilding[]
  /** Interactive prop placements. */
  props: readonly StaticProp[]
  /** Solid scenery placements. */
  scenery: readonly StaticScenery[]
  /** Visitor spawn in north-up configured metres. */
  spawn: VillagePoint
}

/** A character expression recorded by the environment. */
export interface CharacterExpression {
  /** Configured expression token. */
  type: string
  /** Stable target id, or the environment's no-target token. */
  target: string
}

/** One character in a dynamic renderer overlay. */
export interface DynamicCharacter {
  /** Stable environment character identifier. */
  id: string
  /** North-up x position in configured metres. */
  x: number
  /** North-up y position in configured metres. */
  y: number
  /** Heading in environment degrees. */
  heading: number
  /** Distance moved on the latest tick. */
  moved: number
  /** Current emote or prop-use expression. */
  expression: CharacterExpression
}

/** Environment-specific values that change on each completed transition. */
export interface VillageDynamic {
  /** Completed environment tick. */
  tick: number
  /** Configured day phase name. */
  phase: string
  /** Characters in canonical visitor-first roster order. */
  characters: readonly DynamicCharacter[]
  /** Current state token for every interactive prop. */
  props: Readonly<Record<string, string>>
  /** Whether this frame completed the episode. */
  terminal: boolean
}

/** A point in the renderer's downward-y world coordinate space. */
export interface WorldPoint {
  /** Horizontal renderer coordinate. */
  x: number
  /** Vertical renderer coordinate. */
  y: number
}

/** An axis-aligned rectangle in renderer world coordinates. */
export interface WorldRect extends WorldPoint {
  /** Rectangle width in renderer units. */
  width: number
  /** Rectangle height in renderer units. */
  height: number
}

/** Dimensions in renderer world coordinates. */
export interface WorldSize {
  /** Horizontal extent in renderer units. */
  width: number
  /** Vertical extent in renderer units. */
  height: number
}

/** Config-derived rendering behavior for one ground code. */
export interface GroundClass {
  /** Single-character ground code. */
  code: string
  /** Human-readable rules name. */
  name: string
  /** Provisional renderer color. */
  color: string
  /** Whether character movement may enter the ground. */
  passable: boolean
  /** Packed tiled-map layer that paints the code. */
  layer: 'base' | 'landscape' | 'structure'
}

/** One immutable semantic object prepared for retained drawing. */
export interface StaticDrawable {
  /** Stable reconciliation identifier. */
  id: string
  /** Catalog type token. */
  type: string
  /** Human-readable diagnostic label. */
  label: string
  /** Catalog collision shape. */
  shape: 'box' | 'circle'
  /** Catalog collision diameter fraction for circular props. */
  collisionScale: number
  /** Config-derived renderer extent. */
  rect: WorldRect
  /** Optional cardinal presentation direction. */
  facing?: string
}

/** Immutable, mount-scoped scene derived from the recording header and shared JSON. */
export interface StaticScene {
  /** Validated source village. */
  village: VillageStatic
  /** Renderer world dimensions. */
  world: WorldSize
  /** Visitor spawn converted into renderer coordinates. */
  spawn: WorldPoint
  /** Ground classes in rules order. */
  ground: readonly GroundClass[]
  /** Ground classes indexed by recorded code. */
  groundByCode: Readonly<Record<string, GroundClass>>
  /** Ground rows converted once to Pixi's top-first order. */
  topFirstRows: readonly string[]
  /** Semantic building drawables. */
  buildings: readonly StaticDrawable[]
  /** Interactive prop drawables. */
  props: readonly StaticDrawable[]
  /** Solid scenery drawables. */
  scenery: readonly StaticDrawable[]
}

/** One dynamic character prepared for retained Pixi drawing. */
export interface CharacterDrawable extends DynamicCharacter {
  /** Position converted into renderer coordinates. */
  point: WorldPoint
  /** Config-derived body radius in renderer units. */
  radius: number
  /** Provisional body fill. */
  fill: string
  /** Human-readable identity and expression label. */
  label: string
  /** The expression chip's title-cased text, or null when the character has no expression. */
  expressionTitle: string | null
}

/**
 * One delivered line carrying canonical raw recording player ids.
 *
 * The host admits lines before they reach the renderer, so a bubble draws whatever arrives. The
 * visitor's own session therefore carries fewer lines than a watcher's, exactly as the environment's
 * speech contract describes.
 */
export interface SpeechLine {
  /** Canonical presentation identity derived from the delivered message. */
  key: string
  /** Canonical recording player id of the speaker. */
  speaker: string
  /** Canonical recording player id of the single addressee, or null for a broadcast. */
  addressee: string | null
  /** Delivered text. */
  text: string
}

/** Complete pure scene for one live or replay state. */
export interface FrameScene {
  /** Reused mount-scoped scene reference. */
  static: StaticScene
  /** Dynamic payload, or null before the live opening supplies one. */
  dynamic: VillageDynamic | null
  /** Recorded tick with interpolation progress applied for seek-safe presentation motion. */
  presentationTick: number
  /** Dynamic character drawables. */
  characters: readonly CharacterDrawable[]
}

/** Collision truth prepared for the diagnostic overlay. */
export type CollisionShape =
  | {
      /** Stable collision identifier. */
      id: string
      /** Axis-aligned rectangle discriminator. */
      kind: 'rect'
      /** Rectangle in renderer coordinates. */
      rect: WorldRect
      /** Human-readable diagnostic label. */
      label: string
      /** Collision source category. */
      group: 'blocked' | 'object' | 'boundary'
    }
  | {
      /** Stable collision identifier. */
      id: string
      /** Circle discriminator. */
      kind: 'circle'
      /** Circle center in renderer coordinates. */
      center: WorldPoint
      /** Circle radius in renderer units. */
      radius: number
      /** Human-readable diagnostic label. */
      label: string
      /** Collision source category. */
      group: 'object' | 'character'
    }

// Terrain contracts

/** One smooth-noise band used to displace a terrain curve. */
export interface TerrainCurveOctave {
  /** Noise wavelength measured in cells. */
  readonly wavelengthCells: number
  /** Perpendicular displacement the band usually draws, measured in cells. */
  readonly amplitudeCells: number
}

/** Geometry controls shared by terrain and route curves. */
export interface TerrainCurveProfile {
  /** Distance between resampled points measured in cells. */
  readonly sampleSpacingCells: number
  /** Radius a corner is rounded over, measured in cells, zero to keep every corner exact. */
  readonly cornerRadiusCells: number
  /** Ordered noise bands applied after smoothing. */
  readonly octaves: readonly TerrainCurveOctave[]
}

/**
 * Returns how far one source sample may leave its own source curve, in cells.
 *
 * @param sourceOffset Arc offset on the source curve in cells.
 */
export type TerrainCurveBudget = (sourceOffset: number) => number

/** One authored point supplied to terrain curve shaping. */
export interface TerrainCurveSourcePoint {
  /** Horizontal coordinate measured in cells. */
  readonly x: number
  /** Vertical coordinate measured in cells. */
  readonly y: number
  /** Whether shaping must preserve this point exactly. */
  readonly locked: boolean
}

/** One shaped point paired with its source-curve position. */
export interface TerrainCurvePoint {
  /** Shaped horizontal coordinate measured in cells. */
  readonly x: number
  /** Shaped vertical coordinate measured in cells. */
  readonly y: number
  /** Arc offset on the authored curve measured in cells. */
  readonly sourceOffset: number
  /** Whether shaping preserved this point exactly. */
  readonly locked: boolean
}

/** A point in cell units using top-first screen axes. */
export interface ContourCoordinate {
  /** Horizontal coordinate measured in cells. */
  readonly x: number
  /** Vertical coordinate measured in cells. */
  readonly y: number
}

/** Reference polyline that contour shaping and validation measure against. */
export interface ContourReference {
  /** Reference vertices in traversal order, without a repeated seam point. */
  readonly points: readonly ContourCoordinate[]
  /** Raw arc offset of each vertex, strictly increasing from zero. */
  readonly offsets: readonly number[]
  /** Whether each vertex sits inside locked geometry. */
  readonly locked: readonly boolean[]
}

/** Numeric controls for planning and shaping terrain contours. */
export interface TerrainContourSettings {
  /** Curve profiles selected by terrain family. */
  readonly profiles: {
    /** Curve profile for land boundaries. */
    readonly land: TerrainCurveProfile
    /** Curve profile for water boundaries. */
    readonly water: TerrainCurveProfile
  }
  /** Locked tangent length on each side of a junction, in cells. */
  readonly junctionTangentCells: number
  /** Maximum displacement from a reference boundary, in cells. */
  readonly maxDeviationCells: number
}

/** One authored cell that contributes provenance to a contour side. */
export interface TerrainContourCell extends ContourCoordinate {
  /** Zero-based grid column. */
  readonly column: number
  /** Zero-based top-first grid row. */
  readonly row: number
  /** Semantic ground name recorded for the cell. */
  readonly semantic: string
  /** Visual material assigned to the cell. */
  readonly material: string
}

/** Material and source cells on one side of a contour. */
export interface TerrainContourSide {
  /** Visual material beside the contour. */
  readonly material: string
  /** Ordered semantic ground names beside the contour. */
  readonly semantics: readonly string[]
  /** Authored cells beside the contour. */
  readonly cells: readonly TerrainContourCell[]
}

/** A raw source span retained for shoreline and structure treatments. */
export interface TerrainContourSpan {
  /** Inclusive arc offset at the start of the span, in cells. */
  readonly startOffset: number
  /** Exclusive arc offset at the end of the span, in cells. */
  readonly endOffset: number
  /** Source provenance on the left side. */
  readonly left: TerrainContourSide
  /** Source provenance on the right side. */
  readonly right: TerrainContourSide
  /** Whether the source geometry must stay fixed. */
  readonly fixed: boolean
  /** Whether the span separates water from land. */
  readonly shoreline: boolean
  /** Whether a bridge suppresses seam drawing on the span. */
  readonly bridgeSuppressed: boolean
}

/** One emitted contour point in cell units and top-first screen axes. */
export interface TerrainContourPoint extends ContourCoordinate {
  /** Arc offset on the raw contour, in cells. */
  readonly rawOffset: number
  /** Whether shaping preserved this point exactly. */
  readonly locked: boolean
  /** Shoreline treatment strength from zero to one. */
  readonly shorelineFactor: number
}

/** One shoreline interval along a contour chain. */
export interface TerrainShorelineSpan {
  /** Inclusive arc offset at the start of the span, in cells. */
  readonly startOffset: number
  /** Exclusive arc offset at the end of the span, in cells. */
  readonly endOffset: number
  /** Water semantics touching the span. */
  readonly waterSemantics: readonly string[]
  /** Whether route coverage suppresses the shoreline treatment. */
  readonly suppressed: boolean
}

/** One canonical curve shared by both incident material faces. */
export interface TerrainContourChain {
  /** Stable chain identifier. */
  readonly id: string
  /** Whether the chain closes back onto its first point. */
  readonly closed: boolean
  /** Canonically ordered pair of incident materials. */
  readonly materials: readonly [string, string]
  /** Material on the left during canonical traversal. */
  readonly leftMaterial: string
  /** Material on the right during canonical traversal. */
  readonly rightMaterial: string
  /** Shaped points in canonical traversal order. */
  readonly points: readonly TerrainContourPoint[]
  /** Authored points before shaping. */
  readonly rawPoints: readonly ContourCoordinate[]
  /** Corner-cut reference points that shaping deviated from. */
  readonly referencePoints: readonly ContourCoordinate[]
  /** Total authored curve length measured in cells. */
  readonly rawLength: number
  /** Source-provenance spans along the chain. */
  readonly spans: readonly TerrainContourSpan[]
  /** Shoreline treatment spans along the chain. */
  readonly shorelineSpans: readonly TerrainShorelineSpan[]
}

/** One directed use of a shared contour chain within a ring. */
export interface TerrainContourUse {
  /** Identifier of the shared chain. */
  readonly chainId: string
  /** Whether the ring traverses the chain in reverse. */
  readonly reversed: boolean
}

/** One outer boundary or hole assembled from shared contour chains. */
export interface TerrainContourRing {
  /** Stable ring identifier. */
  readonly id: string
  /** Identifier of the component that owns the ring. */
  readonly componentId: string
  /** Visual material enclosed by the ring. */
  readonly material: string
  /** Whether the ring is an outer boundary or a hole. */
  readonly role: 'outer' | 'hole'
  /** Directed shared-chain uses around the ring. */
  readonly uses: readonly TerrainContourUse[]
  /** Shaped ring points in traversal order. */
  readonly points: readonly ContourCoordinate[]
  /** Signed area, positive for outer rings and negative for holes. */
  readonly signedArea: number
}

/** One connected material region and its directly owned holes. */
export interface TerrainContourComponent {
  /** Stable component identifier. */
  readonly id: string
  /** Visual material assigned to the component. */
  readonly material: string
  /** Whether the component represents the material outside the grid. */
  readonly exterior: boolean
  /** Number of authored grid cells in the component. */
  readonly cellCount: number
  /** Identifier of the component's outer ring. */
  readonly outerRingId: string
  /** Identifiers of holes directly owned by the component. */
  readonly holeRingIds: readonly string[]
}

/** Complete deterministic contour plan for one terrain grid. */
export interface TerrainContourPlan {
  /** Grid width measured in cells. */
  readonly width: number
  /** Grid height measured in cells. */
  readonly height: number
  /** Canonical shared contour chains. */
  readonly chains: readonly TerrainContourChain[]
  /** Component rings assembled from shared chains. */
  readonly rings: readonly TerrainContourRing[]
  /** Connected material components. */
  readonly components: readonly TerrainContourComponent[]
}

/** Route family that owns a guide or bridge component. */
export type TerrainRouteOwner = 'road' | 'path'

/** Principal orientation used to select bridge artwork. */
export type TerrainBridgeOrientation = 'horizontal' | 'vertical' | 'compact'

/** Numeric controls for planning and drawing terrain routes. */
export interface TerrainRouteSettings {
  /** Road curve and stroke controls. */
  readonly road: {
    /** Curve-shaping profile for the road centerline. */
    readonly curve: TerrainCurveProfile
    /** Preferred road width measured in cells. */
    readonly targetWidthCells: number
    /** Narrowest allowed road width measured in cells. */
    readonly minimumWidthCells: number
    /** Road-layer opacity from zero to one. */
    readonly opacity: number
  }
  /** Path curve and stroke controls. */
  readonly path: {
    /** Curve-shaping profile for path centerlines. */
    readonly curve: TerrainCurveProfile
    /** Path width measured in cells. */
    readonly widthCells: number
    /** Path-layer opacity from zero to one. */
    readonly opacity: number
  }
}

/** One integer cell in a top-first route grid. */
export interface TerrainRouteCell {
  /** Zero-based grid column. */
  readonly column: number
  /** Zero-based top-first grid row. */
  readonly row: number
}

/** One route-space point measured in cells. */
export interface TerrainRoutePoint {
  /** Horizontal coordinate measured in cells. */
  readonly x: number
  /** Vertical coordinate measured in cells. */
  readonly y: number
}

/** One shaped point on the west-to-east road guide. */
export interface TerrainRoadGuidePoint extends TerrainRoutePoint {
  /** Authored horizontal coordinate before shaping. */
  readonly rawX: number
  /** Authored vertical coordinate before shaping. */
  readonly rawY: number
  /** Source road column. */
  readonly column: number
  /** Whether shaping preserved this point exactly. */
  readonly locked: boolean
  /** Fixed feature that anchors the point, when present. */
  readonly anchor: 'map' | 'bridge' | null
  /** Whether clearance forced the point back to its raw position. */
  readonly fellBack: boolean
  /** Local road width measured in cells. */
  readonly widthCells: number
}

/** One shaped point on a path guide. */
export interface TerrainPathGuidePoint extends TerrainRoutePoint {
  /** Authored horizontal coordinate before shaping. */
  readonly rawX: number
  /** Authored vertical coordinate before shaping. */
  readonly rawY: number
  /** Whether shaping preserved this point exactly. */
  readonly locked: boolean
  /** Fixed feature that anchors the point, when present. */
  readonly anchor: 'endpoint' | 'junction' | 'road' | 'bridge' | null
  /** Whether clearance forced the point back to its raw position. */
  readonly fellBack: boolean
}

/** One connected shaped path centerline. */
export interface TerrainPathGuide {
  /** Stable path-guide identifier. */
  readonly id: string
  /** Whether the guide closes back onto its first point. */
  readonly closed: boolean
  /** Shaped centerline points in traversal order. */
  readonly points: readonly TerrainPathGuidePoint[]
  /** Path stroke width measured in cells. */
  readonly widthCells: number
}

/** One cardinal route contact on the edge of a bridge component. */
export interface TerrainBridgeContact {
  /** Cardinal side of the bridge component. */
  readonly side: 'north' | 'east' | 'south' | 'west'
  /** Bridge cell that owns the contact. */
  readonly componentCell: TerrainRouteCell
  /** Adjacent route cell outside the bridge. */
  readonly neighborCell: TerrainRouteCell
  /** Route family touching the bridge. */
  readonly owner: TerrainRouteOwner
}

/** Geometry used to clip one component-wide bridge deck. */
export interface TerrainBridgeDeckSpec {
  /** Whether the deck follows an axis or uses a compact mask. */
  readonly kind: 'axis' | 'compact'
  /** Deck width measured in cells. */
  readonly widthCells: number
  /** Stroke cap used at deck portals. */
  readonly cap: 'butt' | 'square' | 'round'
  /** Deck center measured in route-space cells. */
  readonly center: TerrainRoutePoint
  /** Deck axis endpoints when the component has a principal axis. */
  readonly axis?: readonly [TerrainRoutePoint, TerrainRoutePoint]
}

/** One cardinally connected bridge region and its route ownership. */
export interface TerrainBridgeComponent {
  /** Stable bridge-component identifier. */
  readonly id: string
  /** Bridge cells in deterministic order. */
  readonly cells: readonly TerrainRouteCell[]
  /** Route contacts around the component boundary. */
  readonly contacts: readonly TerrainBridgeContact[]
  /** Route family that determines deck width. */
  readonly owner: TerrainRouteOwner
  /** Principal orientation used for plank artwork. */
  readonly orientation: TerrainBridgeOrientation
  /** Inclusive cell bounds of the component. */
  readonly bounds: {
    /** Westernmost component column. */
    readonly minColumn: number
    /** Easternmost component column. */
    readonly maxColumn: number
    /** Northernmost top-first component row. */
    readonly minRow: number
    /** Southernmost top-first component row. */
    readonly maxRow: number
  }
  /** Route portal centers on the component boundary. */
  readonly portals: readonly TerrainRoutePoint[]
  /** Component-wide deck clipping geometry. */
  readonly deck: TerrainBridgeDeckSpec
}

/** One route cell replaced by propagated natural visual substrate. */
export interface TerrainRoadSubstrateCell extends TerrainRouteCell {
  /** Route material replaced in the visual grid. */
  readonly replacedMaterial: 'road' | 'path'
  /** Natural source cell selected by propagation. */
  readonly source: TerrainRouteCell
  /** Ground code copied from the source cell. */
  readonly sourceCode: string
  /** Natural material copied from the source cell. */
  readonly sourceMaterial: 'ground' | 'field' | 'reeds'
  /** Stable identifier of the source material component. */
  readonly sourceComponentId: string
  /** Cardinal propagation distance measured in cells. */
  readonly distance: number
}

/** One path segment that joins a path guide to the road. */
export interface TerrainPathConnector {
  /** Stable connector identifier. */
  readonly id: string
  /** Path terminal cell on the first side of the road. */
  readonly pathCell: TerrainRouteCell
  /** Opposite terminal when the path continues beneath the road. */
  readonly oppositePathCell?: TerrainRouteCell
  /** Locked guide points that preserve a crossing tangent. */
  readonly via?: readonly TerrainRoutePoint[]
  /** Contact-width path cells omitted from the centerline graph. */
  readonly absorbedPathCells?: readonly TerrainRouteCell[]
  /** Road cell touched by the connector. */
  readonly roadCell: TerrainRouteCell
  /** Connector start measured in route-space cells. */
  readonly start: TerrainRoutePoint
  /** Connector end measured in route-space cells. */
  readonly end: TerrainRoutePoint
  /** Connector stroke width measured in cells. */
  readonly widthCells: number
}

/** Complete deterministic route and bridge plan for one terrain grid. */
export interface TerrainRoutePlan {
  /** Grid width measured in cells. */
  readonly width: number
  /** Grid height measured in cells. */
  readonly height: number
  /** Ground rows after natural substrate replaces road and path cells. */
  readonly visualRows: readonly string[]
  /** Provenance for every propagated substrate cell. */
  readonly visualSubstrate: readonly TerrainRoadSubstrateCell[]
  /** Shaped west-to-east road centerline. */
  readonly roadGuide: readonly TerrainRoadGuidePoint[]
  /** Cells covered by the road and road-owned bridge mask. */
  readonly roadMaskCells: readonly TerrainRouteCell[]
  /** Shaped path centerlines. */
  readonly pathGuides: readonly TerrainPathGuide[]
  /** Path-to-road connector segments. */
  readonly pathConnectors: readonly TerrainPathConnector[]
  /** Connected bridge regions and deck specifications. */
  readonly bridgeComponents: readonly TerrainBridgeComponent[]
}
