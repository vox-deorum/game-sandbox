/**
 * A deliberately narrow renderer for compact user-authored copy on public cards. It is separate from
 * the documentation renderer because a season description is one inline paragraph, not a trusted
 * documentation page with navigation-aware links and block-level formatting.
 */
import MarkdownIt from 'markdown-it'

/** Only absolute HTTP(S) destinations become links. Everything else remains harmless visible text. */
function isSafeHttpUrl(href: string): boolean {
  try {
    const url = new URL(href)
    return url.protocol === 'http:' || url.protocol === 'https:'
  } catch {
    return false
  }
}

function createInlineRenderer(): MarkdownIt {
  const renderer = new MarkdownIt({ html: false, linkify: false, breaks: false })
  // Images and strikethrough do not belong in the compact public-card format. Block syntax stays
  // literal because callers use renderInline rather than the normal block renderer.
  renderer.disable('strikethrough')
  renderer.validateLink = isSafeHttpUrl
  renderer.renderer.rules.image = (tokens, index) =>
    renderer.utils.escapeHtml(tokens[index]?.content ?? '')
  // Source wrapping remains one rendered paragraph. Markdown hard-break syntax does not introduce
  // a block-like line break in this deliberately narrow format.
  renderer.renderer.rules.softbreak = () => ' '
  renderer.renderer.rules.hardbreak = () => ' '

  const defaultLinkOpen =
    renderer.renderer.rules.link_open ??
    ((tokens, index, options, _env, self) => self.renderToken(tokens, index, options))
  renderer.renderer.rules.link_open = (tokens, index, options, env, self) => {
    const token = tokens[index]
    if (token !== undefined) {
      token.attrSet('target', '_blank')
      token.attrSet('rel', 'noopener noreferrer')
    }
    return defaultLinkOpen(tokens, index, options, env, self)
  }
  return renderer
}

const inlineRenderer = createInlineRenderer()

/** Render the permitted inline Markdown subset to safe HTML for a public season card. */
export function renderInlineMarkdown(markdown: string): string {
  return inlineRenderer.renderInline(markdown)
}
