// SPDX-License-Identifier: AGPL-3.0-only
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

// Tests run against package source files directly (no pre-built dist needed).
export default defineConfig({
  resolve: {
    alias: {
      '@baize/shared': fileURLToPath(new URL('./packages/shared/src/index.ts', import.meta.url)),
      '@baize/core': fileURLToPath(new URL('./packages/core/src/index.ts', import.meta.url)),
      '@baize/memory': fileURLToPath(new URL('./packages/memory/src/index.ts', import.meta.url)),
      '@baize/llm': fileURLToPath(new URL('./packages/llm/src/index.ts', import.meta.url)),
    },
  },
  test: {
    include: ['packages/*/src/**/*.test.ts', 'apps/desktop/src/**/*.test.ts'],
    passWithNoTests: true,
  },
})
