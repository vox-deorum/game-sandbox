import { describe, expect, it } from 'vitest'

import {
  DOCS_GITHUB_BASE,
  renderDocsMarkdown,
  rewriteLink,
  routeForDocPath,
  slugify,
} from '../src/docs/markdown.js'

describe('slugify (MkDocs/python-markdown parity)', () => {
  it('strips punctuation so backticked method headings match their cross-page anchors', () => {
    // The heading `chat(inbox)` is linked as ...#chatinbox from the Spades guide.
    expect(slugify('chat(inbox)')).toBe('chatinbox')
  })

  it('lowercases and hyphenates multi-word headings', () => {
    expect(slugify('Scoring and rewards')).toBe('scoring-and-rewards')
    expect(slugify('Time limits')).toBe('time-limits')
    expect(slugify('The helper module')).toBe('the-helper-module')
  })
})

describe('routeForDocPath', () => {
  it('maps the students index to the landing route', () => {
    expect(routeForDocPath('students/index.md')).toBe('/docs')
  })

  it('maps a section index to its directory route', () => {
    expect(routeForDocPath('students/environments/index.md')).toBe('/docs/students/environments')
  })

  it('maps a leaf page to its path route', () => {
    expect(routeForDocPath('students/getting-started.md')).toBe('/docs/students/getting-started')
    expect(routeForDocPath('students/environments/hearts.md')).toBe(
      '/docs/students/environments/hearts',
    )
  })
})

describe('rewriteLink', () => {
  it('rewrites an intra-students relative link to an in-app route, preserving the fragment', () => {
    const result = rewriteLink('../agent-interface.md#chatinbox', 'students/environments/spades.md')
    expect(result).toEqual({
      href: '/docs/students/agent-interface#chatinbox',
      internal: true,
      external: false,
    })
  })

  it('rewrites a section index link relative to the students index', () => {
    const result = rewriteLink('environments/index.md', 'students/index.md')
    expect(result.href).toBe('/docs/students/environments')
    expect(result.internal).toBe(true)
  })

  it('sends a link outside the served subtree to the docs source on GitHub', () => {
    const result = rewriteLink('../specs/llm.md', 'students/getting-started.md')
    expect(result.href).toBe(`${DOCS_GITHUB_BASE}specs/llm.md`)
    expect(result.external).toBe(true)
    expect(result.internal).toBe(false)
  })

  it('marks an absolute external link external and leaves its href untouched', () => {
    const href = 'https://pettingzoo.farama.org/'
    expect(rewriteLink(href, 'students/index.md')).toEqual({
      href,
      internal: false,
      external: true,
    })
  })

  it('leaves a bare in-page fragment for native scrolling', () => {
    expect(rewriteLink('#scoring-and-rewards', 'students/environments/hearts.md')).toEqual({
      href: '#scoring-and-rewards',
      internal: false,
      external: false,
    })
  })
})

describe('renderDocsMarkdown', () => {
  it('gives headings MkDocs-style anchor ids, including punctuation-stripped method names', () => {
    expect(renderDocsMarkdown('## Time limits\n', 'students/agent-interface.md')).toContain(
      'id="time-limits"',
    )
    expect(renderDocsMarkdown('### `chat(inbox)`\n', 'students/agent-interface.md')).toContain(
      'id="chatinbox"',
    )
  })

  it('renders an unknown fence language as escaped plain text without throwing', () => {
    const html = renderDocsMarkdown('```text\n<not> & code\n```\n', 'students/submitting.md')
    expect(html).toContain('&lt;not&gt; &amp; code')
  })

  it('highlights a known fence language', () => {
    const html = renderDocsMarkdown('```python\nx = 1\n```\n', 'students/getting-started.md')
    expect(html).toContain('class="hljs"')
  })

  it('tags an internal doc link and rewrites its href', () => {
    const html = renderDocsMarkdown(
      'See [the interface](../agent-interface.md#time-limits).\n',
      'students/environments/hearts.md',
    )
    expect(html).toContain('data-internal')
    expect(html).toContain('href="/docs/students/agent-interface#time-limits"')
  })

  it('opens an out-of-scope doc link on GitHub in a new tab', () => {
    const html = renderDocsMarkdown(
      'See [the submission spec](../specs/submission.md).\n',
      'students/submitting.md',
    )
    expect(html).toContain(`href="${DOCS_GITHUB_BASE}specs/submission.md"`)
    expect(html).toContain('target="_blank"')
    expect(html).toContain('rel="noopener noreferrer"')
  })
})
