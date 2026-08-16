import type { AtlasPageSpec } from '@renderers/base/atlas/atlas.js'

import type { FrameGrid } from './tint.js'

/** One generated source atlas and its optimized runtime counterpart. */
interface ThreeBranchesRasterDraft {
  source: `./source-art/${string}.png`
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
  'stallBase',
  'lanternBase',
  'benchBase',
  'shrineBase',
  'boardBase',
  'plotBase',
  'hearthBase',
  'repairBenchBase',
  'pumpBase',
  'bellBase',
  'stallGoods',
  'stallShutter',
  'stallOpen',
  'stallClosed',
  'lanternLit',
  'lanternUnlit',
  'benchOccupied',
  'benchEmpty',
  'shrineTended',
  'shrineUntended',
  'boardPosted',
  'plotTended',
  'plotOvergrown',
  'plotFence',
  'hearthLit',
  'hearthUnlit',
  'repairBenchBusy',
  'repairBenchIdle',
  'pumpFlowing',
  'pumpIdle',
  'bellRinging',
  'bellSilent',
  'lanternCore',
  'benchCushion',
  'shrineOffering',
  'bellClapper',
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
] as const

/** The six generated atlases that make up the Hearthside Ink runtime art. */
export const THREE_BRANCHES_ASSET_CATALOG = [
  {
    name: 'terrain',
    source: './source-art/terrain-atlas-source.png',
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
    source: './source-art/buildings-atlas-source.png',
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
    source: './source-art/props-atlas-source.png',
    sourceWidth: 1536,
    sourceHeight: 1024,
    path: './assets/props-atlas.png',
    width: 576,
    height: 384,
    tintable: false,
    format: 'full-color',
    consumer: 'interactive prop bases, state overlays, and silhouette-changing stills',
    frames: {
      width: 96,
      height: 64,
      columns: 6,
      rows: 6,
      names: PROPS_ATLAS_FRAME_NAMES,
    },
  },
  {
    name: 'scenery',
    source: './source-art/scenery-atlas-source.png',
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
        source: './source-art/characters-body-atlas-source.png',
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
        source: './source-art/characters-clothing-atlas-source.png',
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
        source: './source-art/characters-arms-atlas-source.png',
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
        source: './source-art/characters-details-atlas-source.png',
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
    source: './source-art/effects-atlas-source.png',
    sourceWidth: 1448,
    sourceHeight: 1086,
    path: './assets/effects-atlas.png',
    width: 768,
    height: 512,
    tintable: true,
    format: 'grayscale-alpha',
    consumer: 'character marks, prop effects, and white-crane dressing',
    frames: {
      width: 192,
      height: 128,
      columns: 4,
      rows: 4,
      names: EFFECTS_ATLAS_FRAME_NAMES,
    },
  },
] as const satisfies readonly ThreeBranchesAtlasDraft[]

function flatFramePaths(names: readonly string[]): readonly string[] {
  return names.map((name) => `${name}.png`)
}

function propsFramePath(name: string): string {
  const words = name.split(/(?=[A-Z])/)
  const state = words.pop()
  if (state === undefined) throw new Error(`Three Branches prop frame has no state: ${name}`)
  return `${words.map((word) => word.toLowerCase()).join('_')}/${state.toLowerCase()}.png`
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

/** The loose-frame manifests for the nine compiled Three Branches atlas pages. */
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
      ? atlas.frames.names.map(propsFramePath)
      : flatFramePaths(atlas.frames.names)
  return [atlasPage(atlas.name, atlas.format, atlas, `./assets/${atlas.name}`, framePaths)]
}) satisfies readonly AtlasPageSpec[]

/** The separate illustrative image used by the environment card. */
export const THREE_BRANCHES_THUMBNAIL_ASSET = {
  source: './source-art/thumbnail-source.png',
  sourceWidth: 1672,
  sourceHeight: 941,
  path: './thumbnail.png',
  width: 320,
  height: 180,
  format: 'full-color',
} as const

export type ThreeBranchesAtlasName = (typeof THREE_BRANCHES_ASSET_CATALOG)[number]['name']

/** Runtime pages consumed after the terrain and character art units have landed. */
export interface ThreeBranchesRuntimeAssets<T> {
  terrain: T
  characters: {
    body: T
    clothing: T
    arms: T
    details: T
  }
  effects: T
}

/** Resolve and load only the atlas pages consumed by terrain and characters. */
export async function loadThreeBranchesRuntimeAssets<T>(
  load: (source: string) => Promise<T> | T,
): Promise<ThreeBranchesRuntimeAssets<T>> {
  const urls = threeBranchesRuntimeAssetUrls()
  const loadPath = (path: string): Promise<T> => {
    const source = urls[path]
    if (source === undefined) throw new Error(`Three Branches atlas is missing: ${path}`)
    return Promise.resolve(load(source))
  }
  const [terrain, body, clothing, arms, details, effects] = await Promise.all([
    loadPath('./assets/terrain-atlas.png'),
    loadPath('./assets/characters-body-atlas.png'),
    loadPath('./assets/characters-clothing-atlas.png'),
    loadPath('./assets/characters-arms-atlas.png'),
    loadPath('./assets/characters-details-atlas.png'),
    loadPath('./assets/effects-atlas.png'),
  ])
  return { terrain, characters: { body, clothing, arms, details }, effects }
}

/** Ask Vite for production URLs without bundling the deferred atlas pages. */
function threeBranchesRuntimeAssetUrls(): Record<string, string> {
  return import.meta.glob(
    [
      './assets/terrain-atlas.png',
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
