// SPDX-License-Identifier: AGPL-3.0-only
// Rig art pipeline — image generation through the tzcode.top relay
// (OpenAI-compatible POST /v1/images/edits, model gpt-image-2.5).
//
// The API key is read ONLY from the environment variable BAIZE_IMAGE_API_KEY
// and is passed to curl via stdin config (`curl -K -`) so it never appears in
// argv, process listings, log files, or error messages. We only ever log the
// curl exit code and the tail of curl's stderr (network diagnostics).
//
// CLI:
//   node gen-image.cjs one --out OUT.png [--size WxH] [--ref REF.png]...
//        [--mask MASK.png] [--prompt-file F | --prompt TEXT] [--force]
//   node gen-image.cjs batch --jobs JOBS.json [--concurrency N] [--force]
//        JOBS.json = [{ "out", "prompt" | "promptFile", "refs": [], "size", "mask" }]
//        (all paths relative to the process working directory)
//
// Resumable: a job whose output already exists as a valid alpha PNG is skipped
// unless --force. Exit code 0 iff every requested image is present and valid.

const { spawn } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')

const BASE = 'https://tzcode.top/v1/images/edits'
const MODEL = 'gpt-image-2.5'
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const MAX_ATTEMPTS = 8

// Param negotiation: the upstream may reject optional OpenAI params; remember
// what it accepted for the rest of the run and degrade gracefully.
const accept = { background: true, outputFormat: true, mask: true }
let maskUnsupportedReason = null

function fatal(msg) {
  console.error(`FATAL: ${msg}`)
  process.exit(2)
}

function keyFromEnv() {
  const k = process.env.BAIZE_IMAGE_API_KEY
  if (!k || k.length < 16) fatal('BAIZE_IMAGE_API_KEY is not set or too short')
  return k
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

function run(args, input) {
  return new Promise((resolve) => {
    const p = spawn('curl', args, { stdio: ['pipe', 'pipe', 'pipe'] })
    const out = []
    const err = []
    p.stdout.on('data', (d) => out.push(d))
    p.stderr.on('data', (d) => err.push(d))
    if (input !== undefined) p.stdin.write(input)
    p.stdin.end()
    p.on('error', (e) =>
      resolve({ code: -1, out: Buffer.alloc(0), err: Buffer.from(String(e), 'utf8') }),
    )
    p.on('close', (code) => resolve({ code, out: Buffer.concat(out), err: Buffer.concat(err) }))
  })
}

function hasAlpha(file) {
  try {
    return execSipsHasAlpha(file)
  } catch {
    return false
  }
}

function execSipsHasAlpha(file) {
  const { execFileSync } = require('node:child_process')
  return execFileSync('sips', ['-g', 'hasAlpha', file]).toString().includes('hasAlpha: yes')
}

function validPng(file) {
  try {
    if (!fs.existsSync(file) || fs.statSync(file).size < 1024) return false
    const head = fs.readFileSync(file).subarray(0, 8)
    if (!head.equals(PNG_MAGIC)) return false
    return hasAlpha(file)
  } catch {
    return false
  }
}

// One generation attempt. Throws Error with .fatal=true when retrying cannot
// help (bad local ref path). Never includes the key in any thrown message.
async function curlEdits({ prompt, refs, dest, size, mask }) {
  const form = [`model=${MODEL}`, `prompt=${prompt}`, `size=${size}`, 'quality=high']
  if (accept.background) form.push('background=transparent')
  if (accept.outputFormat) form.push('output_format=png')
  for (const r of refs || []) {
    if (!fs.existsSync(r)) {
      const e = new Error(`ref file not found: ${r} (curl exit 26 guard)`)
      e.fatal = true
      throw e
    }
    form.push(`image[]=@${path.resolve(r)}`)
  }
  if (mask) {
    if (!fs.existsSync(mask)) {
      const e = new Error(`mask file not found: ${mask}`)
      e.fatal = true
      throw e
    }
    form.push(`mask=@${path.resolve(mask)}`)
  }
  const args = ['-s', '--http1.1', '-m', '420', BASE, '-K', '-']
  for (const f of form) args.push('-F', f)
  // Auth header via stdin config so the key stays out of argv.
  const authConfig = `header = "Authorization: Bearer ${keyFromEnv()}"\n`
  const r = await run(args, authConfig)
  const body = r.out.toString('utf8')
  if (r.code !== 0 && !body) {
    const e = new Error(`curl exit ${r.code} stderr: ${r.err.toString('utf8').slice(-200)}`)
    e.transient = r.code === 56 || r.code === 28 || r.code === 7 || r.code === 18
    throw e
  }
  if (body.includes('"error"') && !body.includes('"url"')) {
    const low = body.toLowerCase()
    if (low.includes('mask') && accept.mask) {
      accept.mask = false
      maskUnsupportedReason = body.slice(0, 200)
      const e = new Error('upstream rejected mask param -> disabling mask (F3 fallback)')
      e.transient = false
      throw e
    }
    if (low.includes('background') && accept.background) {
      accept.background = false
      const e = new Error('upstream rejected background param -> disabling')
      e.transient = false
      throw e
    }
    if (low.includes('output_format') && accept.outputFormat) {
      accept.outputFormat = false
      const e = new Error('upstream rejected output_format param -> disabling')
      e.transient = false
      throw e
    }
    const e = new Error(`api error: ${body.slice(0, 300)}`)
    e.transient = true
    throw e
  }
  let j
  try {
    j = JSON.parse(body)
  } catch {
    const e = new Error(`bad json from api: ${body.slice(0, 200)}`)
    e.transient = true
    throw e
  }
  const d = j?.data?.[0]
  fs.mkdirSync(path.dirname(path.resolve(dest)), { recursive: true })
  if (d?.url) {
    const dl = await run(['-s', '--http1.1', '-m', '300', '-L', d.url, '-o', dest])
    if (dl.code !== 0 || !fs.existsSync(dest)) throw new Error(`download failed exit ${dl.code}`)
  } else if (d?.b64_json) {
    fs.writeFileSync(dest, Buffer.from(d.b64_json, 'base64'))
  } else {
    const e = new Error(`no image in response: ${body.slice(0, 200)}`)
    e.transient = true
    throw e
  }
  if (!validPng(dest)) {
    // Bad/absent alpha: delete so a retry starts clean, then treat as transient.
    try {
      fs.unlinkSync(dest)
    } catch {}
    const e = new Error('no alpha channel (checkerboard or solid bg)')
    e.transient = true
    throw e
  }
}

async function generate(job, force) {
  const { out } = job
  if (!force && validPng(out)) {
    console.log(`SKIP ${out} (exists and valid)`)
    return true
  }
  const prompt = job.promptFile ? fs.readFileSync(job.promptFile, 'utf8').trim() : job.prompt
  if (!prompt) throw new Error(`job has no prompt: ${out}`)
  const size = job.size || '1024x1536'
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      await curlEdits({ prompt, refs: job.refs, dest: out, size, mask: job.mask })
      const kb = Math.round(fs.statSync(out).size / 1024)
      console.log(`OK ${out} attempt=${attempt} ${kb}KB size=${size}`)
      return true
    } catch (e) {
      if (e.fatal) {
        console.error(`FAIL ${out} fatal: ${e.message}`)
        return false
      }
      const backoff = Math.min(120000, 5000 * 2 ** (attempt - 1))
      console.log(
        'RETRY ' +
          out +
          ' #' +
          attempt +
          ' in ' +
          Math.round(backoff / 1000) +
          's: ' +
          e.message.slice(0, 160),
      )
      if (!e.transient && attempt >= 2) {
        console.error(`FAIL ${out} non-transient: ${e.message.slice(0, 200)}`)
        return false
      }
      await sleep(backoff)
    }
  }
  console.error(`FAIL ${out} after ${MAX_ATTEMPTS} attempts`)
  return false
}

async function pool(jobs, concurrency, worker) {
  let i = 0
  let ok = 0
  const runners = Array.from(
    { length: Math.max(1, Math.min(concurrency, jobs.length)) },
    async () => {
      while (i < jobs.length) {
        const mine = jobs[i++]
        if (await worker(mine)) ok++
      }
    },
  )
  await Promise.all(runners)
  return ok
}

async function main() {
  const argv = process.argv.slice(2)
  const mode = argv[0]
  if (mode === 'one') await runOne(argv.slice(1))
  else if (mode === 'batch') await runBatch(argv.slice(1))
  else fatal('usage: gen-image.cjs one|batch ...')
}

async function runOne(argv) {
  const opt = parseArgs(argv)
  if (!opt.out) fatal('one: --out required')
  const job = {
    out: opt.out,
    prompt: opt.prompt,
    promptFile: opt['prompt-file'],
    refs: opt.ref ? (Array.isArray(opt.ref) ? opt.ref : [opt.ref]) : [],
    size: opt.size || '1024x1536',
    mask: opt.mask,
  }
  const ok = await generate(job, opt.force === 'true')
  console.log(maskUnsupportedReason ? `NOTE mask unsupported: ${maskUnsupportedReason}` : '')
  process.exit(ok ? 0 : 1)
}

async function runBatch(argv) {
  const opt = parseArgs(argv)
  if (!opt.jobs) fatal('batch: --jobs required')
  const jobs = JSON.parse(fs.readFileSync(opt.jobs, 'utf8'))
  const concurrency = parseInt(opt.concurrency || '2', 10)
  const force = opt.force === 'true'
  console.log(`BATCH start jobs=${jobs.length} concurrency=${concurrency}`)
  const ok = await pool(jobs, concurrency, (j) => generate(j, force))
  console.log(`BATCH done ok=${ok}/${jobs.length}`)
  if (maskUnsupportedReason) console.log(`NOTE mask unsupported: ${maskUnsupportedReason}`)
  process.exit(ok === jobs.length ? 0 : 1)
}

function parseArgs(argv) {
  const opt = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a.startsWith('--')) {
      const name = a.slice(2)
      if (argv[i + 1] && !argv[i + 1].startsWith('--')) {
        if (opt[name] === undefined) opt[name] = argv[++i]
        else if (name === 'ref') {
          if (!Array.isArray(opt.ref)) opt.ref = opt.ref ? [opt.ref] : []
          opt.ref.push(argv[++i])
        } else opt[name] = argv[++i]
      } else opt[name] = 'true'
    }
  }
  return opt
}

main().catch((e) => fatal(e?.message))
