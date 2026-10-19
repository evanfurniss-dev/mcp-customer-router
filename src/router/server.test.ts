import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { request as httpRequest, type Server } from 'node:http'
import { RegistryStore } from './registry'
import { createRouterServer } from './server'
import { ConnectionJobs } from './jobs'
import { UserError } from './types'

const homes: string[] = []
const servers: Server[] = []
async function setup(chooseFolder?: (signal: AbortSignal) => Promise<string | null>) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'router-api-'))
  homes.push(home)
  vi.stubEnv('HOME', home)
  vi.stubEnv('CODEX_HOME', path.join(home, '.codex'))
  const store = new RegistryStore(path.join(home, 'state'))
  const runner = vi.fn(async (customer) => ({
    state: 'verified' as const,
    observedOrgId: customer.expectedOrgId,
    checkedAt: new Date().toISOString(),
    message: 'Organization verified.',
  }))
  const jobs = new ConnectionJobs(store, runner)
  const { server } = createRouterServer({ store, jobs, cliPath: '/opt/router/dist/router-cli.js', chooseFolder })
  servers.push(server)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('No server address')
  const origin = `http://127.0.0.1:${address.port}`
  const session = (await (await fetch(`${origin}/api/session`)).json()) as { token: string }
  const request = (route: string, method = 'GET', body?: unknown, signal?: AbortSignal) =>
    fetch(`${origin}${route}`, {
      method,
      signal,
      headers: { 'x-router-token': session.token, 'content-type': 'application/json', origin },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    })
  return { home, store, origin, request, runner }
}
afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
  vi.unstubAllEnvs()
  await Promise.all(homes.splice(0).map((home) => fs.rm(home, { recursive: true, force: true })))
})

describe('local dashboard API', () => {
  it('requires authorization before opening a folder chooser', async () => {
    const chooseFolder = vi.fn(async () => null)
    const { origin, request } = await setup(chooseFolder)
    expect((await fetch(`${origin}/api/projects/choose-folder`, { method: 'POST' })).status).toBe(403)
    expect(
      (await fetch(`${origin}/api/projects/choose-folder`, { method: 'POST', headers: { origin: 'https://evil.invalid' } })).status,
    ).toBe(403)
    expect(chooseFolder).not.toHaveBeenCalled()
    expect((await request('/api/projects/choose-folder', 'POST')).status).toBe(200)
    expect(chooseFolder).toHaveBeenCalledOnce()
  })

  it('returns the chosen folder or cancellation without writing project settings or the registry', async () => {
    const chooseFolder = vi.fn<() => Promise<string | null>>()
    const { home, request } = await setup(chooseFolder)
    const project = path.join(home, 'project')
    await fs.mkdir(project)
    const before = await fs.readdir(home)
    chooseFolder.mockResolvedValueOnce(await fs.realpath(project)).mockResolvedValueOnce(null)

    const selected = await request('/api/projects/choose-folder', 'POST', { prompt: 'Request text must not reach osascript' })
    expect(selected.status).toBe(200)
    expect(await selected.json()).toEqual({ projectPath: await fs.realpath(project) })
    expect(chooseFolder).toHaveBeenNthCalledWith(1, expect.any(AbortSignal))
    const canceled = await request('/api/projects/choose-folder', 'POST')
    expect(canceled.status).toBe(200)
    expect(await canceled.json()).toEqual({ projectPath: null })
    expect(await fs.readdir(home)).toEqual(before)
    expect(await fs.readdir(project)).toEqual([])
  })

  it('allows one chooser at a time and releases it after an error', async () => {
    let rejectPicker!: (error: Error) => void
    const chooseFolder = vi
      .fn<() => Promise<string | null>>()
      .mockImplementationOnce(
        () =>
          new Promise((_resolve, reject) => {
            rejectPicker = reject
          }),
      )
      .mockResolvedValue(null)
    const { request } = await setup(chooseFolder)
    const first = request('/api/projects/choose-folder', 'POST')
    await vi.waitFor(() => expect(chooseFolder).toHaveBeenCalledOnce())
    expect((await request('/api/projects/choose-folder', 'POST')).status).toBe(409)
    expect(chooseFolder).toHaveBeenCalledOnce()
    rejectPicker(new UserError('Choose a folder again, or enter its path.', 500))
    const failed = await first
    expect(failed.status).toBe(500)
    expect(await failed.json()).toEqual({ error: 'Choose a folder again, or enter its path.' })
    expect((await request('/api/projects/choose-folder', 'POST')).status).toBe(200)
    expect(chooseFolder).toHaveBeenCalledTimes(2)
  })

  it('stops an abandoned chooser request and permits the next chooser', async () => {
    let pickerSignal!: AbortSignal
    const chooseFolder = vi
      .fn<(signal: AbortSignal) => Promise<string | null>>()
      .mockImplementationOnce(
        (signal) =>
          new Promise((resolve) => {
            pickerSignal = signal
            signal.addEventListener('abort', () => resolve(null), { once: true })
          }),
      )
      .mockResolvedValue(null)
    const { request } = await setup(chooseFolder)
    const controller = new AbortController()
    const abandoned = request('/api/projects/choose-folder', 'POST', undefined, controller.signal).catch((error: Error) => error.name)
    await vi.waitFor(() => expect(chooseFolder).toHaveBeenCalledOnce())
    controller.abort()
    expect(await abandoned).toBe('AbortError')
    await vi.waitFor(() => expect(pickerSignal.aborted).toBe(true))
    expect((await request('/api/projects/choose-folder', 'POST')).status).toBe(200)
    expect(chooseFolder).toHaveBeenCalledTimes(2)
  })

  it('rejects cross-site requests, hostile Host headers, and missing session tokens', async () => {
    const { origin, store } = await setup()
    expect((await fetch(`${origin}/api/state`)).status).toBe(403)
    expect((await fetch(`${origin}/api/session`, { headers: { origin: 'https://evil.invalid' } })).status).toBe(403)
    const hostileHostStatus = await new Promise<number | undefined>((resolve, reject) => {
      httpRequest(`${origin}/api/session`, { headers: { host: 'evil.invalid' } }, (response) => {
        response.resume()
        resolve(response.statusCode)
      })
        .on('error', reject)
        .end()
    })
    expect(hostileHostStatus).toBe(403)
    expect((await fetch(`${origin}/api/session`, { headers: { 'sec-fetch-site': 'cross-site' } })).status).toBe(403)
    expect((await store.read()).customers).toHaveLength(0)
  })

  it('previews safely, requires identity, and binds both clients without exposing existing secrets', async () => {
    const { home, store, request } = await setup()
    const created = await request('/api/customers', 'POST', { name: 'Acme', business: 'Example', expectedOrgId: 'org-a' })
    expect(created.status).toBe(201)
    const customer = (await created.json()) as { id: string }
    const projectPath = path.join(home, 'project')
    await fs.mkdir(projectPath)
    await fs.writeFile(
      path.join(projectPath, '.mcp.json'),
      JSON.stringify({ mcpServers: { other: { command: 'example', env: { PRIVATE_KEY: 'do-not-expose' } } } }),
    )
    const previewResponse = await request('/api/projects/preview', 'POST', { customerId: customer.id, projectPath })
    expect(previewResponse.status).toBe(200)
    const previewText = await previewResponse.text()
    expect(previewText).not.toContain('do-not-expose')
    const preview = JSON.parse(previewText)
    expect(preview.files).toHaveLength(2)
    expect((await request('/api/projects/apply', 'POST', { planId: preview.planId })).status).toBe(409)
    await store.recordCheck(customer.id, {
      state: 'verified',
      observedOrgId: 'org-a',
      checkedAt: new Date().toISOString(),
      message: 'Verified.',
    })
    expect((await request('/api/projects/apply', 'POST', { planId: preview.planId })).status).toBe(200)
    expect((await store.read()).bindings).toEqual([
      expect.objectContaining({ customerId: customer.id, path: await fs.realpath(projectPath) }),
    ])
    const claude = JSON.parse(await fs.readFile(path.join(projectPath, '.mcp.json'), 'utf8'))
    expect(claude.mcpServers.other.env.PRIVATE_KEY).toBe('do-not-expose')
    expect(claude.mcpServers['customer-glide'].args).toContain(customer.id)
    expect(await fs.readFile(path.join(projectPath, '.codex/config.toml'), 'utf8')).toContain('customer-glide')
    expect((await request('/api/projects/apply', 'POST', { planId: preview.planId })).status).toBe(409)
  })

  it('returns conflict when the client config changes after preview', async () => {
    const { home, store, request } = await setup()
    const customer = await store.add({ name: 'Acme', business: 'Example', expectedOrgId: 'org-a' })
    await store.recordCheck(customer.id, {
      state: 'verified',
      observedOrgId: 'org-a',
      checkedAt: new Date().toISOString(),
      message: 'Verified.',
    })
    const preview = (await (await request('/api/projects/preview', 'POST', { customerId: customer.id, projectPath: home })).json()) as {
      planId: string
    }
    await fs.writeFile(path.join(home, '.mcp.json'), '{"mcpServers":{}}')
    expect((await request('/api/projects/apply', 'POST', { planId: preview.planId })).status).toBe(409)
    expect((await store.read()).bindings).toHaveLength(0)
  })

  it('records completed checks with their verified organization', async () => {
    const { store, request, runner } = await setup()
    const customer = await store.add({ name: 'Acme', business: 'Example', expectedOrgId: 'org-a' })
    expect((await request(`/api/customers/${customer.id}/check`, 'POST', {})).status).toBe(202)
    await vi.waitFor(async () => expect((await store.customer(customer.id)).lastCheck?.state).toBe('verified'))
    expect(runner).toHaveBeenCalledOnce()
  })
})
