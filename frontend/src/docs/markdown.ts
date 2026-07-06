/**
 * The documentation markdown renderer: one configured markdown-it instance plus the link policy that
 * lets the repo's student guides render in-app unchanged. The guides are authored for MkDocs, so their
 * cross-page links are relative `.md` paths and their headings rely on MkDocs-style anchor slugs; this
 * module reproduces both so a page reads and navigates the same on the website as in the built docs.
 *
 * Links are rewritten relative to the page being rendered (passed as `docPath` through markdown-it's
 * `env`): a link to another student page becomes an in-app route and is tagged `data-internal` so the
 * page component intercepts the click; a link to a doc outside the served `students/` subtree (a spec,
 * say) becomes a GitHub URL; an external link opens in a new tab. Anchors get MkDocs/GitHub-style ids.
 */
import hljs from 'highlight.js/lib/core'
import bash from 'highlight.js/lib/languages/bash'
import json from 'highlight.js/lib/languages/json'
import powershell from 'highlight.js/lib/languages/powershell'
import python from 'highlight.js/lib/languages/python'
import shell from 'highlight.js/lib/languages/shell'
import MarkdownIt from 'markdown-it'
import anchor from 'markdown-it-anchor'

// The languages the student guides actually fence. `shell` supplies the `console` alias the guides use
// for shell sessions; `bash` is a separate module. An unfenced or unknown language (e.g. `text`) falls
// through to escaped plain text rather than throwing.
hljs.registerLanguage('python', python)
hljs.registerLanguage('json', json)
hljs.registerLanguage('bash', bash)
hljs.registerLanguage('shell', shell)
hljs.registerLanguage('powershell', powershell)

/**
 * The blob base for links that point at docs the website does not serve (contributors, specs). Defaults
 * to the canonical repo; a fork or a renamed default branch sets `VITE_DOCS_GITHUB_BASE` at build time
 * so those out-of-scope links do not silently 404. Must end in a trailing slash: the resolved doc path
 * is appended directly.
 */
export const DOCS_GITHUB_BASE =
  import.meta.env.VITE_DOCS_GITHUB_BASE ??
  'https://github.com/vox-deorum/game-sandbox/blob/main/docs/'

/** The subtree served in-app; a resolved link outside it links out to GitHub instead. */
const SERVED_PREFIX = 'students/'

/**
 * MkDocs/python-markdown heading slug: normalize, drop punctuation other than word chars, spaces and
 * hyphens, lowercase, then collapse runs of spaces and hyphens to a single hyphen. This is what turns
 * `` `chat(inbox)` `` into `chatinbox`, so a cross-page `...#chatinbox` link resolves to the heading.
 */
export function slugify(text: string): string {
  return text
    .normalize('NFKD')
    .replace(/[^\w\s-]/g, '')
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, '-')
}

/** The directory portion of a docs-relative path, e.g. `students/environments` for a spades page. */
function dirOf(docPath: string): string {
  const parts = docPath.split('/')
  parts.pop()
  return parts.join('/')
}

/** Resolve a relative link against a base directory, collapsing `.`/`..`, POSIX-style. */
function resolveRelative(baseDir: string, rel: string): string {
  const segments = baseDir === '' ? [] : baseDir.split('/')
  for (const part of rel.split('/')) {
    if (part === '' || part === '.') continue
    if (part === '..') segments.pop()
    else segments.push(part)
  }
  return segments.join('/')
}

/**
 * The in-app route for a served docs path: `/docs` for the landing, the directory route for a section's
 * `index.md`, and `/docs/<path-without-.md>` otherwise. Shared with the page component so the nav links
 * and the rewritten in-body links agree on one URL scheme.
 */
export function routeForDocPath(path: string): string {
  const noExt = path.replace(/\.md$/, '')
  if (noExt === 'students/index') return '/docs'
  return `/docs/${noExt.replace(/\/index$/, '')}`
}

/** Whether a link target is an absolute URL or protocol-relative (external to the SPA). */
function isExternal(href: string): boolean {
  return /^([a-z][a-z0-9+.-]*:|\/\/)/i.test(href)
}

interface RewrittenLink {
  href: string
  internal: boolean
  external: boolean
}

/** Apply the link policy to one href, given the page it appears on. */
export function rewriteLink(href: string, docPath: string): RewrittenLink {
  // A bare in-page fragment scrolls within the rendered page; leave it to native anchor behavior.
  if (href.startsWith('#')) return { href, internal: false, external: false }
  if (isExternal(href)) return { href, internal: false, external: true }

  const hashIndex = href.indexOf('#')
  const fragment = hashIndex === -1 ? '' : href.slice(hashIndex)
  const target = hashIndex === -1 ? href : href.slice(0, hashIndex)

  // Only relative markdown links participate in cross-page resolution; anything else is left as-is.
  if (!target.endsWith('.md')) return { href, internal: false, external: false }

  const resolved = resolveRelative(dirOf(docPath), target)
  if (resolved.startsWith(SERVED_PREFIX)) {
    return { href: `${routeForDocPath(resolved)}${fragment}`, internal: true, external: false }
  }
  // A doc outside the served subtree (contributors/, specs/) is not on the site: link to its source.
  return { href: `${DOCS_GITHUB_BASE}${resolved}${fragment}`, internal: false, external: true }
}

/** One renderer rule; used to type the link_open override and its default fallback. */
type RenderRule = NonNullable<MarkdownIt['renderer']['rules'][string]>

function createRenderer(): MarkdownIt {
  // Annotated so the highlight function may reference `md` without a circular type inference.
  const md: MarkdownIt = new MarkdownIt({
    // The guides contain no raw HTML, and disabling it keeps a class-index override file from injecting
    // markup; fenced code is highlighted with the registered languages, plain-escaped otherwise.
    html: false,
    linkify: false,
    highlight(str, lang) {
      if (lang && hljs.getLanguage(lang)) {
        try {
          const value = hljs.highlight(str, { language: lang, ignoreIllegals: true }).value
          return `<pre class="hljs"><code>${value}</code></pre>`
        } catch {
          // Fall through to the plain-escaped rendering below.
        }
      }
      return `<pre class="hljs"><code>${md.utils.escapeHtml(str)}</code></pre>`
    },
  })

  md.use(anchor, { slugify, tabIndex: false })

  const defaultLinkOpen: RenderRule =
    md.renderer.rules.link_open ??
    ((tokens, idx, options, _env, self) => self.renderToken(tokens, idx, options))

  md.renderer.rules.link_open = (tokens, idx, options, env, self) => {
    const token = tokens[idx]
    const href = token?.attrGet('href') ?? null
    if (token !== undefined && href !== null) {
      const { href: nextHref, internal, external } = rewriteLink(href, env?.docPath ?? '')
      token.attrSet('href', nextHref)
      if (internal) token.attrSet('data-internal', '')
      if (external) {
        token.attrSet('target', '_blank')
        token.attrSet('rel', 'noopener noreferrer')
      }
    }
    return defaultLinkOpen(tokens, idx, options, env, self)
  }

  return md
}

const renderer = createRenderer()

/** Render one documentation page's markdown to HTML, resolving links relative to `docPath`. */
export function renderDocsMarkdown(content: string, docPath: string): string {
  return renderer.render(content, { docPath })
}
