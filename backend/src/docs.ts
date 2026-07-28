/**
 * The in-app documentation source: shared student guides under `docs/students/` plus dynamically
 * discovered environment guides under `environments/<env>/environment.md`. The latter are exposed
 * at their stable virtual `students/environments/<slug>.md` paths. Only student documentation is
 * exposed; contributor and specification pages stay repo- and MkDocs-only.
 *
 * Three shapes back the three routes in `app.ts`:
 *  - {@link buildDocsManifest} walks the tree into the navigation the sidebar renders,
 *  - {@link readDocsPage} returns one page's raw markdown, path-sanitized against traversal,
 *  - {@link readDocsIndex} returns the landing page, honoring the optional class-index override.
 *
 * The frontend does the markdown rendering and link rewriting; this module only serves bytes and
 * the nav tree, so a page updates without a frontend rebuild.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, isAbsolute, join, posix, relative, resolve, sep } from 'node:path'

/** One navigation entry: a page, or a section whose landing page carries child pages. */
export interface DocsNavEntry {
  /** The docs-relative source path including `.md`, e.g. `students/getting-started.md`. */
  path: string
  /** The page's first H1, or a humanized filename when the page has no heading. */
  title: string
  /** Present on a section: the sibling pages under the same directory, ordered. */
  children?: DocsNavEntry[]
}

/** The navigation tree for the documentation area; `students/index.md` is excluded (it is the landing). */
export interface DocsManifest {
  pages: DocsNavEntry[]
}

/** One page's raw markdown and the docs-relative path it was read from (the link-resolution base). */
export interface DocsPage {
  path: string
  content: string
}

/** Raised when the documentation landing page cannot be read; the route maps it to a 500. */
export class DocsIndexError extends Error {}

/** Raised when a canonical environment guide cannot be published safely at its virtual path. */
export class DocsEnvironmentGuideError extends Error {}

/**
 * The pedagogical reading order the students index prescribes. Entries not listed here (a new guide,
 * a new environment) sort alphabetically after these, so the nav stays sensible without a code change
 * every time a page is added, mirroring how the MkDocs tree drives its own order.
 */
const CURATED_ORDER = ['getting-started', 'environments', 'agent-interface', 'submitting']

const SAFE_ENVIRONMENT_ID = /^[a-z0-9]+(?:_[a-z0-9]+)*$/
const RESERVED_ENVIRONMENT_SLUGS = new Set(['agents', 'index', 'readme'])
const MARKDOWN_LINK = /(?<!!)\]\(([^()\n]+)\)/g
export const ENVIRONMENT_CATALOG_PATH = 'students/environments/index.md'
export const ENVIRONMENT_CATALOG_MARKER =
  '[environment-guide-catalog]: # "Populated dynamically from canonical environment guides."'

/** The one subtree of `docs/` served to the website. */
function studentsRootOf(docsDir: string): string {
  return resolve(docsDir, 'students')
}

/** An absolute path back to its forward-slashed docs-relative form (the wire path). */
function toDocsRelative(docsDir: string, absPath: string): string {
  return relative(docsDir, absPath).split(sep).join('/')
}

/**
 * The first ATX H1 in the markdown, ignoring `#` lines inside fenced code blocks (a `# comment` in a
 * Python sample is not a heading). Returns null when the page has no top-level heading.
 */
function firstHeading(markdown: string): string | null {
  let fence: '`' | '~' | null = null
  for (const line of markdown.split(/\r?\n/)) {
    if (fence !== null) {
      const closer = fence === '`' ? /^\s{0,3}`{3,}\s*$/ : /^\s{0,3}~{3,}\s*$/
      if (closer.test(line)) fence = null
      continue
    }
    const open = line.match(/^\s{0,3}(`{3,}|~{3,})/)
    if (open) {
      fence = open[1]?.startsWith('`') ? '`' : '~'
      continue
    }
    const heading = line.match(/^\s{0,3}#\s+(.+?)\s*#*\s*$/)
    if (heading?.[1]) return heading[1].trim()
  }
  return null
}

/** A filename stem turned into a readable fallback title, e.g. `getting-started` to `Getting started`. */
function humanize(stem: string): string {
  const spaced = stem.replace(/[-_]/g, ' ').trim()
  return spaced.length === 0 ? stem : spaced.charAt(0).toUpperCase() + spaced.slice(1)
}

/** The title for a page: its first heading, else a humanized filename (best effort; never throws). */
function titleFor(absPath: string, stem: string): string {
  try {
    const heading = firstHeading(readFileSync(absPath, 'utf8'))
    if (heading !== null) return heading
  } catch {
    // A page that cannot be read still gets a nav entry; the fetch of its body surfaces the error.
  }
  return humanize(stem)
}

function titleForMarkdown(markdown: string, stem: string): string {
  return firstHeading(markdown) ?? humanize(stem)
}

/** A leaf page entry for a `.md` file in `dir`. */
function pageEntry(docsDir: string, dir: string, name: string): DocsNavEntry {
  const abs = join(dir, name)
  return { path: toDocsRelative(docsDir, abs), title: titleFor(abs, name.replace(/\.md$/, '')) }
}

interface EnvironmentGuide {
  envId: string
  path: string
  source: string
  content: string
}

function isExternalOrFragment(target: string): boolean {
  return (
    target.startsWith('#') ||
    target.startsWith('//') ||
    target.startsWith('http://') ||
    target.startsWith('https://') ||
    target.startsWith('mailto:')
  )
}

function environmentGuideSlug(envId: string): string {
  if (!SAFE_ENVIRONMENT_ID.test(envId)) {
    throw new DocsEnvironmentGuideError(
      `environment guide id ${JSON.stringify(envId)} must use lowercase letters, digits, and single underscores`,
    )
  }
  const slug = envId.replaceAll('_', '-')
  if (RESERVED_ENVIRONMENT_SLUGS.has(slug)) {
    throw new DocsEnvironmentGuideError(
      `environment guide slug ${JSON.stringify(slug)} is reserved`,
    )
  }
  return slug
}

function docsRelativeTarget(
  docsDir: string,
  canonicalDocsDir: string,
  source: string,
  target: string,
): string | null {
  if (
    [...target].some((character) => /\s/.test(character)) ||
    target.startsWith('<') ||
    target.includes('\\')
  ) {
    return null
  }
  const hash = target.indexOf('#')
  const pathText = hash === -1 ? target : target.slice(0, hash)
  if (isAbsolute(pathText) || pathText.includes('?') || !pathText.endsWith('.md')) {
    return null
  }
  const candidate = resolve(dirname(source), pathText)
  const relativeTarget = relative(resolve(canonicalDocsDir), candidate)
  if (
    relativeTarget === '' ||
    relativeTarget === '..' ||
    relativeTarget.startsWith(`..${sep}`) ||
    isAbsolute(relativeTarget)
  ) {
    return null
  }
  if (!existsSync(resolve(docsDir, relativeTarget))) {
    return null
  }
  const docsTarget = relativeTarget.split(sep).join('/')
  const fragment = hash === -1 ? '' : target.slice(hash)
  return `${docsTarget}${fragment}`
}

function renderEnvironmentGuide(
  docsDir: string,
  canonicalDocsDir: string,
  source: string,
  virtualPath: string,
): string {
  const markdown = readFileSync(source, 'utf8')
  return markdown.replace(MARKDOWN_LINK, (original, rawTarget: string) => {
    if (isExternalOrFragment(rawTarget)) return original
    const target = docsRelativeTarget(docsDir, canonicalDocsDir, source, rawTarget)
    if (target === null) return original
    const hash = target.indexOf('#')
    const docsPath = hash === -1 ? target : target.slice(0, hash)
    const fragment = hash === -1 ? '' : target.slice(hash)
    const rebased = posix.relative(posix.dirname(virtualPath), docsPath)
    return `](${rebased}${fragment})`
  })
}

/**
 * Discover every immediate environment directory that owns `environment.md`. Discovery validates
 * all names and virtual paths before returning any page, so a bad new environment cannot leave only
 * part of the documentation tree visible. Resolvable inline guide links are rebased to virtual paths.
 */
function discoverEnvironmentGuides(docsDir: string, environmentsDir: string): EnvironmentGuide[] {
  let entries: import('node:fs').Dirent[]
  try {
    entries = readdirSync(environmentsDir, { withFileTypes: true })
  } catch {
    return []
  }
  const sources = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => ({
      envId: entry.name,
      source: join(environmentsDir, entry.name, 'environment.md'),
    }))
    .filter(({ source }) => existsSync(source))
    .sort((a, b) => a.envId.localeCompare(b.envId))

  const paths = new Map<string, string>()
  const canonicalDocsDir = resolve(environmentsDir, '..', 'docs')
  return sources.map(({ envId, source }) => {
    const slug = environmentGuideSlug(envId)
    const path = `students/environments/${slug}.md`
    const previous = paths.get(path)
    if (previous !== undefined) {
      throw new DocsEnvironmentGuideError(
        `environment guide ids ${JSON.stringify(previous)} and ${JSON.stringify(envId)} both map to ${path}`,
      )
    }
    paths.set(path, envId)
    return {
      envId,
      path,
      source,
      content: renderEnvironmentGuide(docsDir, canonicalDocsDir, source, path),
    }
  })
}

function renderEnvironmentCatalog(docsDir: string, guides: EnvironmentGuide[]): string {
  const source = join(docsDir, ENVIRONMENT_CATALOG_PATH)
  const shell = readFileSync(source, 'utf8')
  if (shell.split(ENVIRONMENT_CATALOG_MARKER).length !== 2) {
    throw new DocsEnvironmentGuideError(
      `environment catalog ${source} must contain the dynamic catalog marker exactly once`,
    )
  }
  const entries = guides.map((guide) => {
    const title = titleForMarkdown(guide.content, guide.envId)
    return `- [${title}](${posix.basename(guide.path)})`
  })
  const listing = entries.length === 0 ? '_No environments are available._' : entries.join('\n')
  return `${shell.replace(ENVIRONMENT_CATALOG_MARKER, listing).trimEnd()}\n`
}

/** A section entry for a subdirectory, landing on its `index.md`; null when it has no `index.md`. */
function sectionEntry(
  docsDir: string,
  studentsRoot: string,
  dirName: string,
  environmentGuides: EnvironmentGuide[],
): DocsNavEntry | null {
  const dirAbs = join(studentsRoot, dirName)
  const indexAbs = join(dirAbs, 'index.md')
  if (!existsSync(indexAbs)) return null
  const children = readdirSync(dirAbs, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith('.md') && e.name !== 'index.md')
    .map((e) => pageEntry(docsDir, dirAbs, e.name))
  if (dirName === 'environments') {
    const childPaths = new Set(children.map((child) => child.path))
    for (const guide of environmentGuides) {
      if (childPaths.has(guide.path)) {
        throw new DocsEnvironmentGuideError(
          `environment guide ${guide.envId} has two sources for virtual path ${guide.path}`,
        )
      }
      children.push({
        path: guide.path,
        title: titleForMarkdown(guide.content, guide.envId),
      })
      childPaths.add(guide.path)
    }
  }
  return {
    path: toDocsRelative(docsDir, indexAbs),
    title: titleFor(indexAbs, dirName),
    children: sortEntries(children),
  }
}

/** The ordering key: a file's stem, or a section's directory name (its landing is that dir's index). */
function orderKey(entry: DocsNavEntry): string {
  const parts = entry.path.split('/')
  const base = parts[parts.length - 1] ?? entry.path
  return base === 'index.md' ? (parts[parts.length - 2] ?? base) : base.replace(/\.md$/, '')
}

/** Curated order first (in listed order), then everything else alphabetically. */
function sortEntries(entries: DocsNavEntry[]): DocsNavEntry[] {
  return [...entries].sort((a, b) => {
    const ka = orderKey(a)
    const kb = orderKey(b)
    const ia = CURATED_ORDER.indexOf(ka)
    const ib = CURATED_ORDER.indexOf(kb)
    if (ia !== -1 && ib !== -1) return ia - ib
    if (ia !== -1) return -1
    if (ib !== -1) return 1
    return ka.localeCompare(kb)
  })
}

/**
 * Walk `docs/students/` into the navigation tree. Top-level `.md` files become pages and each
 * subdirectory becomes a section landing on its `index.md`; `students/index.md` itself is omitted
 * because it is the landing page served by {@link readDocsIndex}. A missing tree yields no pages
 * rather than an error, so an unusual deployment degrades to an empty documentation area.
 */
export function buildDocsManifest(docsDir: string, environmentsDir: string): DocsManifest {
  const studentsRoot = studentsRootOf(docsDir)
  const environmentGuides = discoverEnvironmentGuides(docsDir, environmentsDir)
  let entries: import('node:fs').Dirent[]
  try {
    entries = readdirSync(studentsRoot, { withFileTypes: true })
  } catch {
    return { pages: [] }
  }
  const pages: DocsNavEntry[] = []
  for (const entry of entries) {
    if (entry.isDirectory()) {
      const section = sectionEntry(docsDir, studentsRoot, entry.name, environmentGuides)
      if (section !== null) pages.push(section)
    } else if (entry.isFile() && entry.name.endsWith('.md') && entry.name !== 'index.md') {
      pages.push(pageEntry(docsDir, studentsRoot, entry.name))
    }
  }
  return { pages: sortEntries(pages) }
}

/**
 * Resolve a requested docs-relative path to an absolute file under `students/`, or null if it escapes
 * that subtree. The wire path must start with `students/` and end in `.md`; backslashes are normalized
 * and `.`/`..`/empty segments are rejected before resolution, and the resolved path is boundary-checked
 * to sit under `students/` so an encoded traversal (e.g. `%2e%2e`) cannot reach outside the tree.
 */
function resolveStudentsPath(docsDir: string, relPath: string): string | null {
  const normalized = relPath.replace(/\\/g, '/').trim()
  if (!normalized.startsWith('students/') || !normalized.endsWith('.md')) return null
  if (normalized.split('/').some((seg) => seg === '' || seg === '.' || seg === '..')) return null
  const studentsRoot = studentsRootOf(docsDir)
  const candidate = resolve(docsDir, normalized)
  const boundary = studentsRoot.endsWith(sep) ? studentsRoot : studentsRoot + sep
  return candidate.startsWith(boundary) ? candidate : null
}

/**
 * One page's raw markdown by its docs-relative path, or null when the path is out of scope or the file
 * does not exist (the route returns a JSON 404 for null).
 */
export function readDocsPage(
  docsDir: string,
  environmentsDir: string,
  relPath: string,
): DocsPage | null {
  const normalized = relPath.replace(/\\/g, '/').trim()
  const environmentGuides = discoverEnvironmentGuides(docsDir, environmentsDir)
  if (normalized === ENVIRONMENT_CATALOG_PATH) {
    try {
      return {
        path: ENVIRONMENT_CATALOG_PATH,
        content: renderEnvironmentCatalog(docsDir, environmentGuides),
      }
    } catch (error) {
      if (error instanceof DocsEnvironmentGuideError) throw error
      return null
    }
  }
  const environmentGuide = environmentGuides.find((guide) => guide.path === normalized)
  if (environmentGuide !== undefined) {
    return { path: environmentGuide.path, content: environmentGuide.content }
  }
  const abs = resolveStudentsPath(docsDir, relPath)
  if (abs === null) return null
  try {
    return { path: toDocsRelative(docsDir, abs), content: readFileSync(abs, 'utf8') }
  } catch {
    return null
  }
}

/**
 * The documentation landing page. When `docsIndexFile` is set it replaces `docs/students/index.md`,
 * so a deployment can put its own class home at `/docs`. The returned `path` is always
 * `students/index.md` so relative links in an override file resolve as if it were the default file.
 * A configured-but-unreadable override throws {@link DocsIndexError} rather than falling back, because
 * a missing class home is operator misconfiguration that should fail loudly.
 */
export function readDocsIndex(docsDir: string, docsIndexFile?: string): DocsPage {
  const path = 'students/index.md'
  const source = docsIndexFile ?? join(studentsRootOf(docsDir), 'index.md')
  try {
    return { path, content: readFileSync(source, 'utf8') }
  } catch (cause) {
    const which = docsIndexFile !== undefined ? `DOCS_INDEX_FILE (${source})` : source
    throw new DocsIndexError(`cannot read documentation index from ${which}`, { cause })
  }
}
