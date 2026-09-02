import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { fileURLToPath, URL } from 'node:url'
import electron from 'vite-plugin-electron/simple'

export default defineConfig(({ command }) => ({
  plugins: [
    react(),
    electron({
      main: {
        entry: 'electron/main.ts',
        onstart({ startup }) {
          if (command === 'serve') void startup()
        }
      },
      preload: {
        input: fileURLToPath(new URL('./electron/preload.ts', import.meta.url)),
        // Electron executes this bundle as CommonJS even though the app package is ESM.
        // Using .cjs avoids treating the generated `require('electron')` as ESM.
        vite: {
          build: {
            rollupOptions: {
              output: {
                entryFileNames: '[name].cjs',
                chunkFileNames: '[name]-[hash].cjs'
              }
            }
          }
        }
      }
    })
  ],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url))
    }
  },
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true
  }
}))
