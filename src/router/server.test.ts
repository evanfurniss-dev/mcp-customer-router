import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { request as httpRequest, type Server } from 'node:http'
import { RegistryStore } from './registry'
import { createRouterServer } from './server'
import { ConnectionJobs } from './jobs'

const homes: string[] = []
const servers: Server[] = []
async function setup() {
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
  const { server } = createRouterServer({ store, jobs, cliPath: '/opt/router/dist/router-cli.js' })
  servers.push(server)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('No server address')
  const origin = `http://127.0.0.1:${address.port}`
  const session = (await (await fetch(`${origin}/api/session`)).json()) as { token: string }
  const request = (route: string, method = 'GET', body?: unknown) =>
    fetch(`${origin}${route}`, {
      method,
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
