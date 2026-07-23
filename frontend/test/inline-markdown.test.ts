import { describe, expect, it } from 'vitest'

import { renderInlineMarkdown } from '../src/markdown/inline.js'

describe('renderInlineMarkdown', () => {
  it('renders the permitted emphasis, strong text, and inline code', () => {
    expect(renderInlineMarkdown('*em* **strong** `code`')).toBe(
      '<em>em</em> <strong>strong</strong> <code>code</code>',
    )
  })

  it('keeps soft wrapping and Markdown hard-break syntax inside one visual paragraph', () => {
    const html = renderInlineMarkdown('soft\nwrap  \nhard\\\nbreak')
    expect(html).toBe('soft wrap hard break')
    expect(html).not.toContain('<br')
  })

  it('escapes raw HTML and leaves disabled image and block syntax non-structural', () => {
    const html = renderInlineMarkdown(
      '<script>alert(1)</script> ![alt](https://example.test/a.png) # title\n- list\n> quote\n```code```',
    )
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;')
    expect(html).not.toContain('<script')
    expect(html).not.toContain('<img')
    expect(html).not.toMatch(/<(h1|ul|blockquote|pre)>/)
    expect(html).toContain('alt')
    expect(html).not.toContain('<a href="https://example.test/a.png"')
    expect(html).toContain('# title')
  })

  it('opens only absolute HTTP(S) Markdown links and autolinks in a new tab', () => {
    for (const href of [
      'http://example.test/path',
      'https://example.test/path',
      'HtTpS://example.test/path',
    ]) {
      const html = renderInlineMarkdown(`[safe](${href}) <${href}>`)
      expect(html).toContain(`href="${href}"`)
      expect(html).toContain('target="_blank"')
      expect(html).toContain('rel="noopener noreferrer"')
    }
  })

  it('leaves unsafe or unsupported links as text', () => {
    for (const href of [
      '/relative',
      '#fragment',
      '//example.test',
      'mailto:person@example.test',
      'javascript:alert(1)',
      'data:text/html,alert(1)',
      'java%73cript:alert(1)',
      'java&#x73;cript:alert(1)',
      'h%74tps://example.test',
      'https:%2f%2fexample.test',
    ]) {
      expect(renderInlineMarkdown(`[unsafe](${href})`)).not.toContain('<a ')
      expect(renderInlineMarkdown(`<${href}>`)).not.toContain('<a ')
    }
  })
})
