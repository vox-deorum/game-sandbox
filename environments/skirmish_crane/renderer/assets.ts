/** The complete bundled art contract for the Estuary Ink renderer. */
export interface CraneAsset {
  name: CraneAssetName
  path: `./assets/${string}`
  width: number
  height: number
  consumer: string
}

export const CRANE_ASSET_MANIFEST = [
  {
    name: 'paperField',
    path: './assets/paper-field.png',
    width: 1024,
    height: 1024,
    consumer: 'paper tooth over the sheet',
  },
  {
    name: 'washHexA',
    path: './assets/wash-hex-a.png',
    width: 128,
    height: 128,
    consumer: 'per-tile pigment pooling',
  },
  {
    name: 'washHexB',
    path: './assets/wash-hex-b.png',
    width: 128,
    height: 128,
    consumer: 'per-tile pigment pooling',
  },
  {
    name: 'washHexC',
    path: './assets/wash-hex-c.png',
    width: 128,
    height: 128,
    consumer: 'per-tile pigment pooling',
  },
  {
    name: 'edgeStroke',
    path: './assets/edge-stroke.png',
    width: 256,
    height: 64,
    consumer: 'dry-brush boundary',
  },
  {
    name: 'mistBandA',
    path: './assets/mist-band-a.png',
    width: 512,
    height: 192,
    consumer: 'static void mist',
  },
  {
    name: 'mistBandB',
    path: './assets/mist-band-b.png',
    width: 512,
    height: 192,
    consumer: 'static void mist',
  },
  { name: 'canopy', path: './assets/canopy.png', width: 96, height: 96, consumer: 'forest mark' },
  {
    name: 'waste',
    path: './assets/feature-waste.png',
    width: 96,
    height: 96,
    consumer: 'wasteland mark',
  },
  { name: 'sedgeA', path: './assets/sedge-a.png', width: 96, height: 48, consumer: 'marsh tuft' },
  { name: 'sedgeB', path: './assets/sedge-b.png', width: 96, height: 48, consumer: 'marsh tuft' },
  { name: 'ripple', path: './assets/ripple.png', width: 96, height: 32, consumer: 'water mark' },
  {
    name: 'contour',
    path: './assets/contour.png',
    width: 96,
    height: 96,
    consumer: 'hill strokes',
  },
  {
    name: 'shadowOval',
    path: './assets/shadow-oval.png',
    width: 64,
    height: 64,
    consumer: 'unit shadows',
  },
  {
    name: 'sealRing',
    path: './assets/seal-ring.png',
    width: 96,
    height: 96,
    consumer: 'activation and target seals',
  },
  {
    name: 'zoneDash',
    path: './assets/zone-dash.png',
    width: 96,
    height: 24,
    consumer: 'capture zone boundary',
  },
  {
    name: 'glyphSword',
    path: './assets/glyph-sword.png',
    width: 64,
    height: 64,
    consumer: 'footman token and HUD mark',
  },
  {
    name: 'glyphBow',
    path: './assets/glyph-bow.png',
    width: 64,
    height: 64,
    consumer: 'archer token and HUD mark',
  },
  {
    name: 'glyphHorse',
    path: './assets/glyph-horse.png',
    width: 64,
    height: 64,
    consumer: 'cavalry token and HUD mark',
  },
  {
    name: 'glyphMove',
    path: './assets/glyph-move.png',
    width: 64,
    height: 64,
    consumer: 'move marks and HUD',
  },
  {
    name: 'figFootman',
    path: './assets/fig-footman.png',
    width: 128,
    height: 128,
    consumer: 'Sengoku footman figure',
  },
  {
    name: 'figArcher',
    path: './assets/fig-archer.png',
    width: 128,
    height: 128,
    consumer: 'Sengoku archer figure',
  },
  {
    name: 'figCavalry',
    path: './assets/fig-cavalry.png',
    width: 128,
    height: 128,
    consumer: 'Sengoku cavalry figure',
  },
  {
    name: 'pennant',
    path: './assets/pennant.png',
    width: 48,
    height: 64,
    consumer: 'capture zone standard',
  },
  {
    name: 'crane',
    path: './assets/crane.png',
    width: 192,
    height: 96,
    consumer: 'thumbnail motif source',
  },
  {
    name: 'iconHp',
    path: './assets/icon-hp.png',
    width: 32,
    height: 32,
    consumer: 'HUD hit point field',
  },
  {
    name: 'iconMove',
    path: './assets/icon-move.png',
    width: 32,
    height: 32,
    consumer: 'HUD move field',
  },
  {
    name: 'iconAttack',
    path: './assets/icon-attack.png',
    width: 32,
    height: 32,
    consumer: 'HUD attack field',
  },
  {
    name: 'iconRange',
    path: './assets/icon-range.png',
    width: 32,
    height: 32,
    consumer: 'HUD range field',
  },
  {
    name: 'iconVision',
    path: './assets/icon-vision.png',
    width: 32,
    height: 32,
    consumer: 'HUD vision field',
  },
] as const satisfies readonly CraneAssetDraft[]

type CraneAssetDraft = Omit<CraneAsset, 'name'> & { name: string }
export type CraneAssetName = (typeof CRANE_ASSET_MANIFEST)[number]['name']

/** Resolve every source through an injected loader. Tests can supply a stub without image decoding. */
export async function loadCraneAssets<T>(
  load: (asset: (typeof CRANE_ASSET_MANIFEST)[number]) => Promise<T> | T,
): Promise<Record<CraneAssetName, T>> {
  const loaded = await Promise.all(
    CRANE_ASSET_MANIFEST.map(async (asset) => [asset.name, await load(asset)] as const),
  )
  return Object.fromEntries(loaded) as Record<CraneAssetName, T>
}

/** Vite bundles every local source asset and returns its production URL. */
export function craneAssetUrls(): Record<string, string> {
  return import.meta.glob('./assets/*', {
    eager: true,
    import: 'default',
    query: '?url',
  }) as Record<string, string>
}

/** Match every declared source to a bundled URL, failing loudly when a production asset is absent. */
export function craneAssetSources(
  urls: Record<string, string> = craneAssetUrls(),
): Record<CraneAssetName, string> {
  return Object.fromEntries(
    CRANE_ASSET_MANIFEST.map((asset) => {
      const url = urls[asset.path]
      if (url === undefined) throw new Error(`Crane Reach asset is missing: ${asset.path}`)
      return [asset.name, url]
    }),
  ) as Record<CraneAssetName, string>
}
