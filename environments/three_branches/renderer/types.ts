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
}

/**
 * One delivered line, named by character id rather than by the recording's player id.
 *
 * The host admits lines before they reach the renderer, so a bubble draws whatever arrives. The
 * visitor's own session therefore carries fewer lines than a watcher's, exactly as the environment's
 * speech contract describes.
 */
export interface SpeechLine {
  /** Canonical presentation identity derived from the delivered message. */
  key: string
  /** Character id of the speaker. */
  speaker: string
  /** Character id of the single addressee, or null for a broadcast. */
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
