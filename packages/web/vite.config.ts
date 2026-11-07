import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Ziel der API in der Entwicklung; gegen den laufenden Stack z.B.
// VITE_API_TARGET=http://deployer.192-168-0-252.nip.io pnpm dev
const target = process.env.VITE_API_TARGET ?? 'http://127.0.0.1:3000'

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // In der Entwicklung laeuft die API daneben; im Betrieb liefert sie
    // dieses Bundle selbst aus.
    proxy: {
      '/api': { target, changeOrigin: true },
      '/health': { target, changeOrigin: true },
    },
  },
  build: { outDir: 'dist', sourcemap: true },
})
