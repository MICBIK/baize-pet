// SPDX-License-Identifier: AGPL-3.0-only

/**
 * End-to-end smoke test against the PRODUCTION build (apps/desktop/out/).
 * Run after `pnpm build`:
 *
 *   node apps/desktop/tests/smoke/run.mjs
 *
 * On Linux CI it must run under xvfb (xvfb-run -a). The suite asserts, in order:
 *   1. out/renderer/ contains index.html, settings.html and chat.html;
 *   2. the packaged app boots with a temp user-data dir; the pet, settings and
 *      chat pages all load with no did-fail-load;
 *   3. the pet window's <video> can be drawn to a canvas and read back
 *      (getImageData at the frame center) without a SecurityError, alpha > 0;
 *   4. with a local mock OpenAI-compatible SSE server: wizardTest sends the
 *      draft key (Authorization header) to the configured baseUrl; wizardSave
 *      persists the config without plaintext key on disk; a chat message gets
 *      the streamed reply; the memory DB gains a semantic fact + episodic row.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'
import { _electron } from 'playwright-core'
import { startMockOpenAi, stopMockOpenAi } from './mock-openai.mjs'

const desktopRoot = fileURLToPath(new URL('../..', import.meta.url))
const rendererDir = join(desktopRoot, 'out', 'renderer')

const failures = []
const check = (name, condition, detail = '') => {
  const ok = Boolean(condition)
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures.push(name)
  return ok
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function until(fn, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs
  let lastError
  while (Date.now() < deadline) {
    try {
      const value = await fn()
      if (value) return value
    } catch (error) {
      lastError = error
    }
    await sleep(200)
  }
  throw new Error(`timeout waiting for ${label}${lastError ? `: ${lastError}` : ''}`)
}

// --- 1. multi-page renderer output ----------------------------------------
for (const page of ['index.html', 'settings.html', 'chat.html']) {
  check(`renderer output contains ${page}`, existsSync(join(rendererDir, page)))
}

const mock = startMockOpenAi()
const mockBaseUrl = await mock.baseUrl

// --- 2. launch the built app in a temp profile ------------------------------
const tempHome = mkdtempSync(join(tmpdir(), 'baize-smoke-'))
const desktopRequire = createRequire(join(desktopRoot, 'package.json'))
const electronPath = desktopRequire('electron')

// Launch the app directory (not the main.js file) so app.getAppPath() resolves
// exactly like a real install: package.json "main" → out/main/index.js.
// --user-data-dir redirects Electron's userData (config + memory DB) to a temp
// profile. safeStorage on Linux only reports available for a real secret
// backend: --password-store=gnome selects the libsecret backend (the ci.yml
// job runs a dbus session with an unlocked gnome-keyring for it); basic_text
// would make isEncryptionAvailable() false and the wizard would refuse to
// store the key — correct product behavior, just not testable bare.
const electronArgs = [desktopRoot.slice(0, -1), `--user-data-dir=${join(tempHome, 'user-data')}`]
if (process.platform === 'linux') {
  electronArgs.push('--no-sandbox', '--disable-dev-shm-usage', '--password-store=gnome')
}
if (process.platform === 'linux') {
  electronArgs.push('--no-sandbox', '--disable-dev-shm-usage')
}
electronArgs.push('--password-store=basic')

const electronApp = await _electron.launch({
  executablePath: electronPath,
  args: electronArgs,
  env: {
    ...process.env,
    ELECTRON_ENABLE_LOGGING: '1',
  },
})

let exitError = null
electronApp.process().once('exit', (code) => {
  if (code && code !== 0) exitError = new Error(`electron exited with code ${code}`)
})

// Track did-fail-load across every webContents the app ever creates.
// -3 (ERR_ABORTED) is a navigation cancel, not a load failure.
await electronApp.evaluate(({ app }) => {
  if (globalThis.__baizeLoadWatch) return
  globalThis.__baizeLoadWatch = true
  globalThis.__baizeFailedLoads = []
  app.on('web-contents-created', (_event, contents) => {
    contents.on('did-fail-load', (_event, code, description, url) => {
      if (code !== -3) globalThis.__baizeFailedLoads.push({ code, description, url })
    })
  })
})

const petPage = await until(
  async () => {
    for (const page of electronApp.windows()) {
      if (page.url().endsWith('index.html')) return page
    }
    return null
  },
  20_000,
  'pet window (index.html)',
)

// First launch: the model wizard (settings window) opens automatically.
const settingsPage = await until(
  async () => {
    for (const page of electronApp.windows()) {
      if (page.url().endsWith('settings.html')) return page
    }
    return null
  },
  20_000,
  'settings window (settings.html)',
)

const userData = await electronApp.evaluate(({ app }) => app.getPath('userData'))
console.log(`user-data: ${userData}`)
// safeStorage diagnostics: which backend did Linux select, is it usable?
const storage = await electronApp.evaluate(({ safeStorage }) => ({
  available: safeStorage.isEncryptionAvailable(),
  backend: safeStorage.getSelectedStorageBackend?.() ?? 'unknown',
}))
console.log(`safeStorage: ${JSON.stringify(storage)}`)

// --- 3. canvas alpha readback on the pet ------------------------------------
const pixel = await until(
  async () => {
    return petPage.evaluate(async () => {
      const video = document.querySelector('video')
      if (!video || video.readyState < 2 || video.videoWidth === 0) return null
      const canvas = document.createElement('canvas')
      canvas.width = video.videoWidth
      canvas.height = video.videoHeight
      const ctx = canvas.getContext('2d', { willReadFrequently: true })
      ctx.drawImage(video, 0, 0)
      // Frame center of the placeholder creature — must be inside the body.
      const data = ctx.getImageData(
        Math.floor(video.videoWidth / 2),
        Math.floor(video.videoHeight / 2),
        1,
        1,
      ).data
      return { alpha: data[3], red: data[0] }
    })
  },
  20_000,
  'video frame ready for canvas readback',
)
check(
  'canvas getImageData does not throw (canvas not tainted)',
  pixel !== null && pixel.alpha > 0,
  `center pixel ${JSON.stringify(pixel)}`,
)

// --- 4. click IPC opens the chat window -------------------------------------
await petPage.evaluate(() => window.baize.click())
const chatPage = await until(
  async () => {
    for (const page of electronApp.windows()) {
      if (page.url().endsWith('chat.html')) return page
    }
    return null
  },
  20_000,
  'chat window (chat.html)',
)

// --- 5. wizard test connection against the mock ------------------------------
const draft = {
  providerId: 'deepseek',
  model: 'deepseek-chat',
  baseUrl: mockBaseUrl,
  apiKey: 'sk-smoke-test-key-123',
}
const testResult = await settingsPage.evaluate((draft) => window.baize.wizardTest(draft), draft)
check(
  'wizardTest succeeds against the mock endpoint',
  testResult?.ok === true,
  `result ${JSON.stringify(testResult)}`,
)
await until(() => mock.requests.length > 0, 10_000, 'mock server received a request')
const testRequest = mock.requests.at(-1)
check(
  'test request carries the draft key as Authorization',
  testRequest.authorization === `Bearer ${draft.apiKey}`,
  `authorization ${testRequest.authorization}`,
)
check(
  'test request hits the configured baseUrl path',
  testRequest.url.includes('/chat/completions') && testRequest.body?.model === draft.model,
  `url ${testRequest.url}`,
)

// --- 6. save the wizard, assert no plaintext key on disk ---------------------
const saveResult = await settingsPage.evaluate((draft) => window.baize.wizardSave(draft), draft)
check('wizardSave succeeds', saveResult?.ok === true, `result ${JSON.stringify(saveResult)}`)
const configFile = join(userData, 'config.json')
check('config.json written', existsSync(configFile))
if (existsSync(configFile)) {
  const rawConfig = readFileSync(configFile, 'utf8')
  const config = JSON.parse(rawConfig)
  check(
    'saved modelConfig keeps the mock baseUrl',
    config.modelConfig?.baseUrl === mockBaseUrl,
    config.modelConfig?.baseUrl,
  )
  check(
    'saved config has an encrypted key cipher',
    typeof config.modelConfig?.keyCipher === 'string' && config.modelConfig.keyCipher.length > 0,
  )
  check('plaintext key never touches disk', !rawConfig.includes(draft.apiKey))
}

// --- 7. chat: streamed reply -------------------------------------------------
await until(
  async () => {
    const input = chatPage.locator('input')
    if ((await input.count()) === 0) return null
    return input
  },
  20_000,
  'chat input box',
)
await chatPage.fill('input', '你好，我叫小明')
await chatPage.press('input', 'Enter')

const reply = await until(
  async () => {
    return chatPage.evaluate(() => {
      const bubbles = [...document.querySelectorAll('div')]
        .map((node) => node.textContent ?? '')
        .filter((text) => text.includes('主人！'))
      return bubbles.length > 0 ? bubbles.at(-1) : null
    })
  },
  30_000,
  'streamed assistant reply',
)
check('assistant reply streamed from the mock', Boolean(reply), `reply ${reply}`)

// --- 8. memory: semantic fact + episodic row ---------------------------------
const memoryDb = join(userData, 'memory.sqlite')
check('memory.sqlite created', existsSync(memoryDb))
const memorySeen = await until(
  async () => {
    if (!existsSync(memoryDb)) return null
    const db = new DatabaseSync(memoryDb, { readOnly: true })
    try {
      const semantic = db
        .prepare("SELECT COUNT(*) AS count FROM semantic_facts WHERE source = 'user_name'")
        .get()
      const episodic = db.prepare('SELECT COUNT(*) AS count FROM episodic_events').get()
      if (semantic.count > 0 && episodic.count > 0) {
        return { semantic: semantic.count, episodic: episodic.count }
      }
      return null
    } finally {
      db.close()
    }
  },
  15_000,
  'memory rows for the chat turn',
)
check(
  'chat turn recorded in memory (semantic fact + episodic event)',
  memorySeen !== null,
  JSON.stringify(memorySeen),
)

// --- 9. no page failed to load ----------------------------------------------
const failedLoads = await electronApp.evaluate(() => globalThis.__baizeFailedLoads)
check('no did-fail-load across all windows', failedLoads.length === 0, JSON.stringify(failedLoads))
check('electron process still running', exitError === null, exitError?.message ?? '')

await electronApp.close()
await stopMockOpenAi(mock)
await rmSync(tempHome, { recursive: true, force: true })

if (failures.length > 0) {
  console.error(`\nSMOKE FAILED (${failures.length}): ${failures.join('; ')}`)
  process.exit(1)
}
console.log('\nSMOKE OK — all checks passed')
