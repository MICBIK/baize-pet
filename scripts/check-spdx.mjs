#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
// Verifies that every source file starts with the AGPL-3.0 SPDX license header.
// Exits non-zero and prints the offending files otherwise.
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

const ROOTS = ['apps', 'packages', 'scripts']
const SKIP_DIRS = new Set(['node_modules', 'dist', 'out', 'release', 'coverage'])
const CODE_EXTS = new Set(['.ts', '.tsx', '.mts', '.cts', '.mjs', '.cjs', '.js', '.jsx'])
const MARKUP_EXTS = new Set(['.html'])
const CODE_HEADER = /^\/\/ SPDX-License-Identifier: AGPL-3\.0-only/
const MARKUP_HEADER = /^<!-- SPDX-License-Identifier: AGPL-3\.0-only -->/

function collectFiles(dir, acc) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name) || entry.name.startsWith('.')) continue
      collectFiles(join(dir, entry.name), acc)
    } else {
      acc.push(join(dir, entry.name))
    }
  }
  return acc
}

function hasHeader(filePath) {
  const lines = readFileSync(filePath, 'utf8').split('\n', 2)
  // Skip a leading shebang before looking at the license header.
  const firstContent = lines.find((line) => line !== '' && !line.startsWith('#!')) ?? ''
  if (MARKUP_EXTS.has(extname(filePath))) return MARKUP_HEADER.test(firstContent)
  return CODE_HEADER.test(firstContent)
}

function extname(name) {
  const idx = name.lastIndexOf('.')
  return idx === -1 ? '' : name.slice(idx)
}

const missing = []
for (const root of ROOTS) {
  let files
  try {
    statSync(root)
  } catch {
    continue
  }
  files = collectFiles(root, []).filter((f) => {
    const ext = extname(f)
    return CODE_EXTS.has(ext) || MARKUP_EXTS.has(ext)
  })
  for (const file of files) {
    if (!hasHeader(file)) missing.push(file)
  }
}

if (missing.length > 0) {
  console.error('Missing SPDX license header (// SPDX-License-Identifier: AGPL-3.0-only) in:')
  for (const file of missing) console.error(`  ${file}`)
  process.exit(1)
}
console.log('All source files carry the AGPL-3.0-only SPDX header.')
