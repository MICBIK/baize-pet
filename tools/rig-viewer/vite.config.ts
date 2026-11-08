// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The generated pack (characters/baize-b3) is served at the site root, so
 * the viewer loads /manifest-style paths exactly like the app protocol does
 * (loadRigPack('/') mirrors loadRigPack('baize-character://b3/')).
 */

import { defineConfig } from 'vite'

export default defineConfig({
  publicDir: '../../characters/baize-b3',
  server: { port: 5178, strictPort: true },
  // @baize/rig ships CJS dist and is workspace-linked (excluded from the
  // dep scanner by default): force prebundling so its named exports work.
  optimizeDeps: { include: ['@baize/rig'] },
})
