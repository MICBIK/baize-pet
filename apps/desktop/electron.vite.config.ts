// SPDX-License-Identifier: AGPL-3.0-only

import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import react from '@vitejs/plugin-react'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'

const appDir = fileURLToPath(new URL('.', import.meta.url))
const outDir = (name: string) => resolve(appDir, 'out', name)

// NOTE: this file MUST be named electron.vite.config.ts (dots) — that is the only
// name electron-vite 6 auto-loads (findConfigFile). A dash (electron-vite.config.ts)
// is silently ignored and every section below never applies.
//
// Main and preload are emitted as CommonJS on purpose: sandboxed preload scripts and
// native modules are a CJS ecosystem. Internal @baize/* packages live in devDependencies
// so they are bundled instead of externalized. Output directories are pinned explicitly
// because electron-vite 6 / vite 8 otherwise resolve the default outDir against the
// workspace root instead of the app directory. electron-vite 6 reads build.rolldownOptions
// for every environment (vite 8 is rolldown-powered), so the renderer's multi-page
// inputs live on rolldownOptions too.
export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      outDir: outDir('main'),
      rolldownOptions: {
        output: {
          format: 'cjs',
        },
      },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      outDir: outDir('preload'),
      rolldownOptions: {
        output: {
          format: 'cjs',
        },
      },
    },
  },
  renderer: {
    plugins: [react()],
    root: resolve(appDir, 'src/renderer'),
    build: {
      outDir: outDir('renderer'),
      rolldownOptions: {
        input: {
          index: resolve(appDir, 'src/renderer/index.html'),
          settings: resolve(appDir, 'src/renderer/settings.html'),
          chat: resolve(appDir, 'src/renderer/chat.html'),
        },
      },
    },
  },
})
