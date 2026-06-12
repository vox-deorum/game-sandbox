import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// One origin in dev: the Vite server proxies /api (HTTP and WebSocket) to the backend on port 8080,
// so the browser sees a single origin and no CORS configuration exists anywhere. Serving the built
// bundle from the backend is a deployment concern deferred exactly like the backend's own build.
export default defineConfig({
  plugins: [react()],
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
