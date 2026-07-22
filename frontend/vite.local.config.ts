import { fileURLToPath, URL } from 'node:url'

import vue from '@vitejs/plugin-vue'
import { defineConfig } from 'vite'

// The local bundle is served by the Python loopback bridge, never by the production backend. Keep its
// one HTML entry and output directory isolated so the normal Vite build cannot ship local play.
export default defineConfig({
  plugins: [vue()],
  build: {
    outDir: 'dist-local',
    emptyOutDir: true,
    rollupOptions: {
      input: fileURLToPath(new URL('./local.html', import.meta.url)),
    },
  },
})
