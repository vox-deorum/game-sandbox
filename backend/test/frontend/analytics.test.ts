import { describe, expect, it } from 'vitest'

import { injectGoogleAnalytics } from '../../src/frontend/analytics.js'

describe('injectGoogleAnalytics', () => {
  const HTML = '<!doctype html><html><head><title>Game Sandbox</title></head><body></body></html>'

  it('returns the document untouched without a measurement id', () => {
    expect(injectGoogleAnalytics(HTML, undefined)).toBe(HTML)
    expect(injectGoogleAnalytics(HTML, '')).toBe(HTML)
    expect(injectGoogleAnalytics(HTML, '   ')).toBe(HTML)
  })

  it('inserts the gtag.js loader before </head> with the measurement id', () => {
    const result = injectGoogleAnalytics(HTML, 'G-G98YR1FFWX')
    expect(result).toContain(
      '<script async src="https://www.googletagmanager.com/gtag/js?id=G-G98YR1FFWX"></script>',
    )
    expect(result).toContain("gtag('config', 'G-G98YR1FFWX');")
    expect(result).toContain("gtag('js', new Date());")
    expect(result.startsWith('<!doctype html>')).toBe(true)
    expect(result.endsWith('</html>')).toBe(true)
    const headEnd = result.indexOf('</head>')
    const gtagStart = result.indexOf('gtag.js')
    expect(gtagStart).toBeGreaterThan(0)
    expect(gtagStart).toBeLessThan(headEnd)
  })

  it('escapes characters that could break out of the injected markup', () => {
    const result = injectGoogleAnalytics(HTML, 'G">alert(1)<')
    expect(result).not.toContain('id=G">')
    expect(result).toContain('id=G&quot;&gt;alert(1)&lt;')
  })

  it('appends the snippet when the document has no </head>', () => {
    const result = injectGoogleAnalytics('<html><body>plain</body></html>', 'G-ABC123')
    expect(result).toContain('googletagmanager.com')
    expect(result).toContain('<html><body>plain</body></html>')
  })
})
