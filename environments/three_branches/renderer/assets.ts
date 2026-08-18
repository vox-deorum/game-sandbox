import type { AtlasPageSpec } from '@renderers/base/atlas/atlas.js'

import catalogDocument from '../catalog.json'

import type { FrameGrid } from './ui/tint.js'

/** One generated source atlas and its optimized runtime counterpart. */
interface ThreeBranchesRasterDraft {
  source: `./assets/source-art/${string}.png`
  sourceWidth: number
  sourceHeight: number
  path: `./assets/${string}.png`
  width: number
  height: number
  frames: FrameGrid
}

interface ThreeBranchesSingleAtlasDraft extends ThreeBranchesRasterDraft {
  name: string
  tintable: boolean
  format: 'grayscale-alpha' | 'full-color'
  consumer: string
}

interface ThreeBranchesLayerDraft extends ThreeBranchesRasterDraft {
  name: string
}

interface ThreeBranchesLayeredAtlasDraft {
  name: string
  tintable: boolean
  format: 'grayscale-alpha' | 'full-color'
  consumer: string
  layers: readonly ThreeBranchesLayerDraft[]
}

type ThreeBranchesAtlasDraft = ThreeBranchesSingleAtlasDraft | ThreeBranchesLayeredAtlasDraft

export const TERRAIN_ATLAS_FRAME_NAMES = [
  'washA',
  'washB',
  'washC',
  'washD',
  'roadA',
  'roadB',
  'roadC',
  'roadD',
  'furrowA',
  'furrowB',
  'furrowC',
  'furrowD',
  'reedsA',
  'reedsB',
  'reedsC',
  'reedsD',
  'rippleA',
  'rippleB',
  'rippleC',
  'rippleD',
  'floorA',
  'floorB',
  'floorC',
  'floorD',
  'wallA',
  'wallB',
  'wallC',
  'wallD',
  'doorway',
  'bridgeA',
  'bridgeB',
  'bridgeC',
  'edge00',
  'edge01',
  'edge02',
  'edge03',
  'edge04',
  'edge05',
  'edge06',
  'edge07',
  'edge08',
  'edge09',
  'edge10',
  'edge11',
  'edge12',
  'edge13',
  'edge14',
  'edge15',
  'cornerA',
  'cornerB',
  'cornerC',
  'cornerD',
  'cornerE',
  'cornerF',
  'cornerG',
  'cornerH',
  'bankShoulder',
  'reedShoulderA',
  'reedShoulderB',
  'reedShoulderC',
  'furrowEndA',
  'furrowEndB',
  'furrowEndC',
  'bankStones',
] as const

export const BUILDINGS_ATLAS_FRAME_NAMES = [
  'homeFill',
  'homeEdge',
  'homeCorner',
  'homeRidge',
  'innFill',
  'innEdge',
  'innCorner',
  'innRidge',
  'shedFill',
  'shedEdge',
  'shedCorner',
  'shedRidge',
  'homeFillAlt',
  'innFillAlt',
  'shedFillAlt',
  'eaveShadow',
] as const

export const PROPS_ATLAS_FRAME_NAMES = [
  'stallOpen',
  'stallClosed',
  'lanternLit',
  'lanternUnlit',
  'benchOccupied',
  'benchEmpty',
  'shrineTended',
  'shrineUntended',
  'boardNone',
  'plotTended',
  'plotOvergrown',
  'hearthLit',
  'hearthUnlit',
  'repairBenchBusy',
  'repairBenchIdle',
] as const

/** Higher-density stills for the fixed north-facing pump and bell monuments. */
export const MONUMENTS_ATLAS_FRAME_NAMES = [
  'pumpFlowing',
  'pumpIdle',
  'bellRinging',
  'bellSilent',
  'bellFoundation',
] as const

export const SCENERY_ATLAS_FRAME_NAMES = ['pineA', 'pineB', 'pineC', 'marketCrate'] as const

export const CHARACTER_POSE_FRAME_NAMES = ['rest', 'leftForward', 'pass', 'rightForward'] as const

export const CHARACTER_DETAIL_FRAME_NAMES = [
  'hairKnot',
  'reedCap',
  'headscarf',
  'visitorTie',
] as const

export const EFFECTS_ATLAS_FRAME_NAMES = [
  'characterShadow',
  'directionMark',
  'glow',
  'glowFlicker',
  'flameA',
  'flameB',
  'flameC',
  'flameD',
  'smokeA',
  'smokeB',
  'waterA',
  'waterB',
  'bellLinesA',
  'bellLinesB',
  'craneA',
  'craneB',
  'glowLow',
  'glowHigh',
  'flameE',
  'flameF',
  'smokeC',
  'smokeD',
  'waterC',
  'waterD',
  'bellLinesC',
  'bellLinesD',
  'bellLinesE',
  'bellLinesF',
  'expressionWave',
  'expressionNod',
  'expressionShakeHead',
  'expressionPoint',
  'expressionLaugh',
  'expressionShrug',
  'expressionStartle',
  'expressionSleep',
  'expressionSweep',
  'expressionUse',
  'expressionAccentA',
  'expressionAccentB',
] as const

/** The seven generated atlases that make up the Hearthside Ink runtime art. */
export const THREE_BRANCHES_ASSET_CATALOG = [
  {
    name: 'terrain',
    source: './assets/source-art/terrain-atlas-source.png',
    sourceWidth: 1536,
    sourceHeight: 1024,
    path: './assets/terrain-atlas.png',
    width: 1024,
    height: 1024,
    tintable: true,
    format: 'grayscale-alpha',
    consumer: 'terrain fills, transitions, bridge planks, and the upper-wall repaint',
    frames: {
      width: 128,
      height: 128,
      columns: 8,
      rows: 8,
      names: TERRAIN_ATLAS_FRAME_NAMES,
    },
  },
  {
    name: 'buildings',
    source: './assets/source-art/buildings-atlas-source.png',
    sourceWidth: 1254,
    sourceHeight: 1254,
    path: './assets/buildings-atlas.png',
    width: 256,
    height: 256,
    tintable: false,
    format: 'full-color',
    consumer: 'home, inn, and repair-shed roof tiles',
    frames: {
      width: 64,
      height: 64,
      columns: 4,
      rows: 4,
      names: BUILDINGS_ATLAS_FRAME_NAMES,
    },
  },
  {
    name: 'props',
    source: './assets/source-art/props-atlas-source.png',
    sourceWidth: 2304,
    sourceHeight: 1536,
    path: './assets/props-atlas.png',
    width: 2304,
    height: 1536,
    tintable: false,
    format: 'full-color',
    consumer:
      'complete ordinary interactive prop state stills, with separate effects and emissives',
    frames: {
      width: 384,
      height: 256,
      columns: 6,
      rows: 6,
      names: PROPS_ATLAS_FRAME_NAMES,
    },
  },
  {
    name: 'monuments',
    source: './assets/source-art/monuments-atlas-source.png',
    sourceWidth: 2304,
    sourceHeight: 1024,
    path: './assets/monuments-atlas.png',
    width: 2304,
    height: 1024,
    tintable: false,
    format: 'full-color',
    consumer: 'higher-density fixed-north pump and bell stills, including the bell foundation',
    frames: {
      width: 768,
      height: 512,
      columns: 3,
      rows: 2,
      names: MONUMENTS_ATLAS_FRAME_NAMES,
    },
  },
  {
    name: 'scenery',
    source: './assets/source-art/scenery-atlas-source.png',
    sourceWidth: 1254,
    sourceHeight: 1254,
    path: './assets/scenery-atlas.png',
    width: 128,
    height: 128,
    tintable: true,
    format: 'grayscale-alpha',
    consumer: 'three red-pine variants and the market crate',
    frames: {
      width: 64,
      height: 64,
      columns: 2,
      rows: 2,
      names: SCENERY_ATLAS_FRAME_NAMES,
    },
  },
  {
    name: 'characters',
    tintable: true,
    format: 'grayscale-alpha',
    consumer: 'independently registered overhead body, clothing, arm, and detail masks',
    layers: [
      {
        name: 'body',
        source: './assets/source-art/characters-body-atlas-source.png',
        sourceWidth: 2172,
        sourceHeight: 724,
        path: './assets/characters-body-atlas.png',
        width: 768,
        height: 192,
        frames: {
          width: 192,
          height: 192,
          columns: 4,
          rows: 1,
          names: CHARACTER_POSE_FRAME_NAMES,
        },
      },
      {
        name: 'clothing',
        source: './assets/source-art/characters-clothing-atlas-source.png',
        sourceWidth: 2022,
        sourceHeight: 778,
        path: './assets/characters-clothing-atlas.png',
        width: 768,
        height: 192,
        frames: {
          width: 192,
          height: 192,
          columns: 4,
          rows: 1,
          names: CHARACTER_POSE_FRAME_NAMES,
        },
      },
      {
        name: 'arms',
        source: './assets/source-art/characters-arms-atlas-source.png',
        sourceWidth: 2137,
        sourceHeight: 736,
        path: './assets/characters-arms-atlas.png',
        width: 768,
        height: 192,
        frames: {
          width: 192,
          height: 192,
          columns: 4,
          rows: 1,
          names: CHARACTER_POSE_FRAME_NAMES,
        },
      },
      {
        name: 'details',
        source: './assets/source-art/characters-details-atlas-source.png',
        sourceWidth: 2103,
        sourceHeight: 748,
        path: './assets/characters-details-atlas.png',
        width: 768,
        height: 192,
        frames: {
          width: 192,
          height: 192,
          columns: 4,
          rows: 1,
          names: CHARACTER_DETAIL_FRAME_NAMES,
        },
      },
    ],
  },
  {
    name: 'effects',
    source: './assets/source-art/effects-atlas-source.png',
    sourceWidth: 3840,
    sourceHeight: 1024,
    path: './assets/effects-atlas.png',
    width: 1920,
    height: 512,
    tintable: true,
    format: 'grayscale-alpha',
    consumer: 'character marks, expression chips, prop effects, and white-crane dressing',
    frames: {
      width: 192,
      height: 128,
      columns: 10,
      rows: 4,
      names: EFFECTS_ATLAS_FRAME_NAMES,
    },
  },
] as const satisfies readonly ThreeBranchesAtlasDraft[]

function flatFramePaths(names: readonly string[]): readonly string[] {
  return names.map((name) => `${name}.png`)
}

function catalogPropFramePath(name: string): string {
  for (const prop of catalogDocument.props) {
    const type = prop.token.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase())
    const state = prop.states.find(
      (value) => `${type}${value[0]?.toUpperCase()}${value.slice(1)}` === name,
    )
    if (state !== undefined) return `${prop.token}/${state}.png`
  }
  throw new Error(`Three Branches prop frame has no catalog state: ${name}`)
}

function monumentFramePath(name: string): string {
  return name === 'bellFoundation' ? 'bell/foundation.png' : catalogPropFramePath(name)
}

function atlasPage(
  group: ThreeBranchesAtlasName,
  format: ThreeBranchesSingleAtlasDraft['format'],
  raster: ThreeBranchesRasterDraft,
  framesPath: string,
  framePaths: readonly string[],
): AtlasPageSpec {
  return {
    group,
    pagePath: raster.path,
    framesPath,
    format,
    width: raster.width,
    height: raster.height,
    columns: raster.frames.columns,
    rows: raster.frames.rows,
    framePaths,
  }
}

/** The loose-frame manifests for the ten compiled Three Branches atlas pages. */
export const ATLAS_PAGES = THREE_BRANCHES_ASSET_CATALOG.flatMap((atlas) => {
  if ('layers' in atlas) {
    return atlas.layers.map((layer) =>
      atlasPage(
        atlas.name,
        atlas.format,
        layer,
        `./assets/characters/${layer.name}`,
        flatFramePaths(layer.frames.names),
      ),
    )
  }

  const framePaths =
    atlas.name === 'props'
      ? atlas.frames.names.map(catalogPropFramePath)
      : atlas.name === 'monuments'
        ? atlas.frames.names.map(monumentFramePath)
        : flatFramePaths(atlas.frames.names)
  return [atlasPage(atlas.name, atlas.format, atlas, `./assets/${atlas.name}`, framePaths)]
}) satisfies readonly AtlasPageSpec[]

/** The separate illustrative image used by the environment card. */
export const THREE_BRANCHES_THUMBNAIL_ASSET = {
  source: './assets/source-art/thumbnail-source.png',
  sourceWidth: 1672,
  sourceHeight: 941,
  path: './assets/thumbnail.png',
  width: 320,
  height: 180,
  format: 'full-color',
} as const

export type ThreeBranchesAtlasName = (typeof THREE_BRANCHES_ASSET_CATALOG)[number]['name']

/** Runtime pages consumed after the terrain and character art units have landed. */
export interface ThreeBranchesRuntimeAssets<T> {
  terrain: T
  props: T
  monuments: T
  buildings: T
  scenery: T
  characters: {
    body: T
    clothing: T
    arms: T
    details: T
  }
  effects: T
}

/** Resolve and load the atlas pages consumed by shipped terrain, prop, and character art. */
export async function loadThreeBranchesRuntimeAssets<T>(
  load: (source: string) => Promise<T> | T,
): Promise<ThreeBranchesRuntimeAssets<T>> {
  const urls = threeBranchesRuntimeAssetUrls()
  const loadPath = (path: string): Promise<T> => {
    const source = urls[path]
    if (source === undefined) throw new Error(`Three Branches atlas is missing: ${path}`)
    return Promise.resolve(load(source))
  }
  const [terrain, props, monuments, buildings, scenery, body, clothing, arms, details, effects] =
    await Promise.all([
      loadPath('./assets/terrain-atlas.png'),
      loadPath('./assets/props-atlas.png'),
      loadPath('./assets/monuments-atlas.png'),
      loadPath('./assets/buildings-atlas.png'),
      loadPath('./assets/scenery-atlas.png'),
      loadPath('./assets/characters-body-atlas.png'),
      loadPath('./assets/characters-clothing-atlas.png'),
      loadPath('./assets/characters-arms-atlas.png'),
      loadPath('./assets/characters-details-atlas.png'),
      loadPath('./assets/effects-atlas.png'),
    ])
  return {
    terrain,
    props,
    monuments,
    buildings,
    scenery,
    characters: { body, clothing, arms, details },
    effects,
  }
}

/** Ask Vite for production URLs for every shipped runtime atlas page. */
function threeBranchesRuntimeAssetUrls(): Record<string, string> {
  return import.meta.glob(
    [
      './assets/terrain-atlas.png',
      './assets/props-atlas.png',
      './assets/monuments-atlas.png',
      './assets/buildings-atlas.png',
      './assets/scenery-atlas.png',
      './assets/characters-body-atlas.png',
      './assets/characters-clothing-atlas.png',
      './assets/characters-arms-atlas.png',
      './assets/characters-details-atlas.png',
      './assets/effects-atlas.png',
    ],
    {
      eager: true,
      import: 'default',
      query: '?url',
    },
  ) as Record<string, string>
}
