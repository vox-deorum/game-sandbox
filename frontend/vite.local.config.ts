import { existsSync } from 'node:fs'
import { fileURLToPath, URL } from 'node:url'

import vue from '@vitejs/plugin-vue'
import { defineConfig, type Plugin } from 'vite'

// The local bundle is served by the Python loopback bridge, never by the production backend. Keep its
// one HTML entry and output directory isolated so the normal Vite build cannot ship local play.
// Publication sets GAME_SANDBOX_LOCAL_ENV to one environment so each kit carries only that
// environment's renderer and assets. Without it, the bundle includes every renderer for local play.

const VIRTUAL_ID = 'virtual:local-renderers'
const RESOLVED_ID = `\0${VIRTUAL_ID}`

function localRenderers(): Plugin {
  return {
    name: 'local-renderers',
    resolveId(id) {
      return id === VIRTUAL_ID ? RESOLVED_ID : null
    },
    load(id) {
      if (id !== RESOLVED_ID) return null
      const registryPath = fileURLToPath(
        new URL('./src/renderers/registry.ts', import.meta.url),
      ).replaceAll('\\', '/')
      const env = process.env.GAME_SANDBOX_LOCAL_ENV
      if (!env) {
        const index = fileURLToPath(
          new URL('./src/renderers/index.ts', import.meta.url),
        ).replaceAll('\\', '/')
        return `import ${JSON.stringify(index)}`
      }
      if (!/^[a-z0-9_]+$/.test(env)) {
        throw new Error(
          `GAME_SANDBOX_LOCAL_ENV must be a lowercase environment name, got ${JSON.stringify(env)}`,
        )
      }
      const renderer = fileURLToPath(
        new URL(`../environments/${env}/renderer/index.ts`, import.meta.url),
      ).replaceAll('\\', '/')
      if (!existsSync(renderer)) {
        throw new Error(
          `GAME_SANDBOX_LOCAL_ENV=${JSON.stringify(env)} has no renderer index at ${renderer}`,
        )
      }
      return [
        `import { registerRendererModules } from ${JSON.stringify(registryPath)}`,
        `import definition from ${JSON.stringify(renderer)}`,
        `registerRendererModules({ ${JSON.stringify(renderer)}: { default: definition } })`,
      ].join('\n')
    },
  }
}

export default defineConfig({
  plugins: [localRenderers(), vue()],
  // The site icons under public/ belong to the main app; local play references none of them.
  publicDir: false,
  resolve: {
    alias: {
      '@renderers': fileURLToPath(new URL('./src/renderers', import.meta.url)),
    },
  },
  build: {
    outDir: 'dist-local',
    emptyOutDir: true,
    rollupOptions: {
      input: fileURLToPath(new URL('./local.html', import.meta.url)),
    },
  },
})
