import vue from '@vitejs/plugin-vue'
import { defineConfig } from 'vite'

// One origin in dev: the Vite server proxies /api (HTTP and WebSocket) to the backend on port 8080,
// so the browser sees a single origin and no CORS configuration exists anywhere. In production the
// backend serves this build (frontend/dist) from the same origin through @fastify/static, so the
// whole stack is one process and one command — see backend/src/app.ts.
export default defineConfig({
  plugins: [vue()],
  server: {
    proxy: {
      '/api': {
        target: 'http://localhost:8080',
        changeOrigin: true,
        ws: true,
      },
    },
  },
})
