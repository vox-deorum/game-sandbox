/**
 * Optional Google Analytics 4 (gtag.js) injection for the served SPA entrypoint.
 */

/** The `<head>`-placement snippet template; `%ID%` is replaced with the escaped measurement id. */
const SNIPPET = `    <!-- Google tag (gtag.js) -->
    <script async src="https://www.googletagmanager.com/gtag/js?id=%ID%"></script>
    <script>
      window.dataLayer = window.dataLayer || [];
      function gtag(){dataLayer.push(arguments);}
      gtag('js', new Date());

      gtag('config', '%ID%');
    </script>`

/**
 * Return `html` with the gtag.js loader inserted before `</head>` so every page load reports to the
 * configured GA4 property. An empty or unset measurement id is a no-op, so the static bundle is
 * served verbatim until a deployment opts in. The id is HTML-escaped so a stray quote in
 * configuration cannot break out of the injected markup.
 */
export function injectGoogleAnalytics(html: string, measurementId?: string): string {
  const id = measurementId?.trim()
  if (id === undefined || id === '') {
    return html
  }
  const snippet = SNIPPET.replaceAll('%ID%', escapeHtml(id))
  if (html.includes('</head>')) {
    return html.replace('</head>', `${snippet}\n  </head>`)
  }
  return `${html}\n${snippet}\n`
}

/** Escape HTML-significant characters for use inside an attribute or script. */
function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => {
    switch (char) {
      case '&':
        return '&amp;'
      case '<':
        return '&lt;'
      case '>':
        return '&gt;'
      case '"':
        return '&quot;'
      default:
        return '&#39;'
    }
  })
}
