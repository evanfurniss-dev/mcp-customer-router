import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { once } from 'node:events'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'

const exec = promisify(execFile)
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const expectedVersion = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8')).version
if (process.argv.length > 3) throw new Error('Pass one release archive at a time.')
const archive = process.argv[2] ?? path.join(root, `release/mcp-customer-router-${expectedVersion}.tar.gz`)
if (!archive?.endsWith('.tar.gz')) throw new Error('Pass a release .tar.gz file.')
const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'router-install-smoke-'))
const first = path.join(temporary, 'Cellar/router/first/libexec')
const next = path.join(temporary, 'Cellar/router/next/libexec')
const stable = path.join(temporary, 'opt/router')
const stableNode = path.join(temporary, 'opt/node')
const home = path.join(temporary, 'user')
const data = path.join(home, '.mcp-customer-router')
const project = path.join(home, 'project')
const cli = path.join(stable, 'libexec/dist/router-cli.js')
const env = { ...process.env, HOME: home, CODEX_HOME: path.join(home, '.codex'), CLAUDE_CONFIG_DIR: path.join(home, '.claude') }
delete env.NODE_PATH
delete env.NODE_OPTIONS
delete env.CUSTOMER_ROUTER_HOME
let dashboard
let output = ''
let errors = ''

async function command(args, expectedCode = 0) {
  try {
    const result = await exec(stableNode, [cli, ...args], { env, cwd: home, timeout: 15000 })
    assert.equal(expectedCode, 0)
    return result.stdout
  } catch (error) {
    if (expectedCode === 0 || error.code !== expectedCode) throw error
    return error.stdout
  }
}

async function stop() {
  if (!dashboard || dashboard.exitCode !== null) return
  const exited = once(dashboard, 'exit')
  dashboard.kill('SIGTERM')
  const timer = setTimeout(() => dashboard.kill('SIGKILL'), 5000)
  try {
    await exited
  } finally {
    clearTimeout(timer)
  }
}

async function start() {
  output = ''
  errors = ''
  dashboard = spawn(stableNode, [cli, 'dashboard', '--home', data, '--port', '0'], {
    cwd: path.dirname(cli),
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  dashboard.stdout.on('data', (chunk) => {
    output += chunk
  })
  dashboard.stderr.on('data', (chunk) => {
    errors += chunk
  })
  for (let attempt = 0; attempt < 100; attempt++) {
    const origin = output.match(/http:\/\/127\.0\.0\.1:\d+/)?.[0]
    if (origin) return origin
    if (dashboard.exitCode !== null) break
    await delay(100)
  }
  throw new Error(`Packaged dashboard did not start: ${errors}`)
}

async function checkDashboard(origin) {
  const health = await fetch(`${origin}/api/health`)
  assert.equal(health.status, 200)
  assert.equal((await health.json()).service, 'mcp-customer-router')
  const html = await (await fetch(origin)).text()
  assert.match(html, /id="root"/)
  const assets = [...html.matchAll(/(?:src|href)="([^"]+\.(?:js|css))"/g)].map((match) => match[1])
  assert.ok(assets.length >= 3, 'The dashboard must include its JavaScript, stylesheet, and theme script.')
  for (const asset of assets) {
    const response = await fetch(new URL(asset, origin))
    assert.equal(response.status, 200, `Missing asset: ${asset}`)
    assert.doesNotMatch(response.headers.get('content-type') ?? '', /text\/html/)
  }
  return (await (await fetch(`${origin}/api/session`)).json()).token
}

async function preview(origin, token, customerId) {
  const response = await fetch(`${origin}/api/projects/preview`, {
    method: 'POST',
    headers: { origin, 'content-type': 'application/json', 'x-router-token': token },
    body: JSON.stringify({ customerId, projectPath: project }),
  })
  const result = await response.json()
  assert.equal(response.status, 200, JSON.stringify(result))
  const serialized = JSON.stringify(result)
  assert.ok(serialized.includes(cli), 'Client settings must use the stable CLI path.')
  assert.ok(serialized.includes(stableNode), 'Client settings must use the stable Node path.')
  assert.ok(!serialized.includes('/Cellar/'), 'Client settings must survive Cellar cleanup.')
}

try {
  await fs.mkdir(first, { recursive: true })
  await fs.mkdir(path.dirname(stable), { recursive: true })
  await fs.mkdir(project, { recursive: true })
  await exec('tar', ['-xzf', path.resolve(archive), '-C', first, '--strip-components=1'])
  await fs.symlink(path.dirname(first), stable)
  await fs.symlink(process.execPath, stableNode)
  await fs.writeFile(path.join(first, 'dist/install-paths.json'), JSON.stringify({ cliPath: cli, nodePath: stableNode }))
  const manifest = JSON.parse(await fs.readFile(path.join(first, 'package.json'), 'utf8'))
  assert.equal(manifest.version, expectedVersion, 'Check the archive for the current release version.')
  assert.deepEqual(Object.keys(manifest.bin), ['mcp-customer-router'])
  assert.equal(manifest.scripts, undefined)
  assert.equal(manifest.devDependencies, undefined)
  assert.equal((await command(['--version'])).trim(), manifest.version)
  assert.match(await command(['--help']), /service install/)
  assert.equal(await fs.stat(data).catch(() => null), null, 'Help and version must not create user state.')
  assert.deepEqual(JSON.parse(await command(['list'])).customers, [])
  const customer = JSON.parse(await command(['add', '--name', 'Package test', '--business', 'Test', '--org', 'package-test']))
  const check = JSON.parse(await command(['check', '--customer', customer.id], 1))
  assert.equal(check.state, 'unverified', 'The packaged child must start and require sign-in.')
  let origin = await start()
  let token = await checkDashboard(origin)
  await preview(origin, token, customer.id)

  // A live process must keep working after Homebrew switches opt and removes the old keg.
  await fs.cp(first, next, { recursive: true, verbatimSymlinks: true })
  await fs.unlink(stable)
  await fs.symlink(path.dirname(next), stable)
  await fs.rm(path.dirname(first), { recursive: true })
  token = await checkDashboard(origin)
  await preview(origin, token, customer.id)
  const checked = await fetch(`${origin}/api/customers/${customer.id}/check`, {
    method: 'POST',
    headers: { origin, 'content-type': 'application/json', 'x-router-token': token },
    body: '{}',
  })
  assert.equal(checked.status, 202)
  const { jobId } = await checked.json()
  let completed
  for (let attempt = 0; attempt < 100; attempt++) {
    const state = await (await fetch(`${origin}/api/state`, { headers: { 'x-router-token': token } })).json()
    const job = state.jobs.find((item) => item.id === jobId)
    if (job?.state === 'complete' || job?.state === 'failed') {
      completed = state.customers.find((item) => item.id === customer.id)?.lastCheck
      break
    }
    await delay(100)
  }
  assert.ok(completed, 'A child check must finish after the old keg is removed.')
  assert.equal(completed.state, 'unverified', 'The upgraded child must run and require sign-in.')
  await stop()
  origin = await start()
  await checkDashboard(origin)
  assert.equal(JSON.parse(await command(['list'])).customers[0].id, customer.id)
  console.log(
    'PASS: standalone package, CLI, dashboard assets, child process, stable client paths, upgrade and restart; no live credentials used.',
  )
} finally {
  await stop()
  await fs.rm(temporary, { recursive: true, force: true })
}
