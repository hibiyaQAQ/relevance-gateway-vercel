import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react()],
  base: '/static/admin/',
  build: {
    outDir: '../static/admin',
    emptyOutDir: true,
  },
  server: {
    proxy: {
      '/admin-api': 'http://127.0.0.1:8080',
      '/v1': 'http://127.0.0.1:8080',
    }
  }
})
