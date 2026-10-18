import { afterEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import http from 'node:http'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { spawn, type ChildProcess } from 'node:child_process'
import open from 'open'
import { Client, type Transport } from '@modelcontextprotocol/client'
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio'
import {
  GenerationGuard,
  connectionFailure,
  guardTransport,
  verifyIdentity,
  runCustomerConnection,
  type ConnectionSpec,
} from './connection'
import { getServerUrlHash } from '../lib/utils'

vi.mock('open', () => ({ default: vi.fn() }))

const temporary: string[] = []
const cleanups: Array<() => Promise<unknown>> = []
const endpoint = 'https://mcp.glideapps.dev/mcp'
const identity = (org = 'customer-a', origin = 'https://os.glideapps.dev') => ({
  content: [],
  structuredContent: { projects: [], count: 0, url: `${origin}/o/${org}/projects`, display_url: `${origin}/o/${org}/projects` },
})
async function tempAuth() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'router-connection-'))
  temporary.push(directory)
  await fs.writeFile(path.join(directory, 'router-generation'), `${randomUUID()}\n`)
  return directory
}

afterEach(async () => {
  await Promise.allSettled(cleanups.splice(0).map((cleanup) => cleanup()))
  await Promise.all(temporary.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })))
  vi.restoreAllMocks()
})

describe('authenticated organization identity', () => {
  it('accepts the server citation even when the customer has no projects', () => {
    expect(verifyIdentity(identity(), endpoint, 'customer-a')).toBe('customer-a')
  })

  it('blocks another organization and reports only its ID', () => {
    let failure: unknown
    try {
      verifyIdentity(identity('customer-b'), endpoint, 'customer-a')
    } catch (error) {
      failure = error
    }
    expect(connectionFailure(failure)).toMatchObject({ state: 'mismatch', observedOrgId: 'customer-b' })
  })

  it.each([
    { content: [{ type: 'text', text: JSON.stringify(identity().structuredContent) }] },
    { ...identity(), isError: true },
    { structuredContent: { projects: [{ url: identity().structuredContent.url }], count: 1 } },
    {
      ...identity(),
      structuredContent: { ...identity().structuredContent, display_url: 'https://os.glideapps.dev/o/customer-b/projects' },
    },
    { ...identity(), structuredContent: { ...identity().structuredContent, orgId: 'customer-b' } },
    { ...identity(), structuredContent: { ...identity().structuredContent, count: 1 } },
    identity('customer-a', 'https://os.glideapps.dev.evil.example'),
    identity('customer-a', 'http://os.glideapps.dev'),
  ])('fails closed for missing, conflicting, or untrusted identity', (result) => {
    expect(() => verifyIdentity(result, endpoint, 'customer-a')).toThrow('valid organization identity')
  })

  it('does not expose arbitrary upstream errors', () => {
    expect(JSON.stringify(connectionFailure(new Error('secret access_token=fixture')))).not.toContain('secret')
  })
})

describe('connection generation', () => {
  it('blocks a previously open transport before any request after reconnect', async () => {
    const authDir = await tempAuth()
    const guard = await GenerationGuard.create(authDir)
    const send = vi.fn(async () => {})
    const transport: Transport = { send, start: async () => {}, close: async () => {} }
    guardTransport(transport, guard)
    await transport.send({ jsonrpc: '2.0', id: 1, method: 'tools/list' })
    await fs.writeFile(path.join(authDir, 'router-generation'), `${randomUUID()}\n`)
    await expect(transport.send({ jsonrpc: '2.0', id: 2, method: 'tools/call' })).rejects.toThrow('sign-in changed')
    expect(send).toHaveBeenCalledTimes(1)
  })

  it('orders a reconnect clear after an in-flight old write, then blocks more old writes', async () => {
    const authDir = await tempAuth()
    const oldGuard = await GenerationGuard.create(authDir)
    let release!: () => void
    let started!: () => void
    const entered = new Promise<void>((resolve) => {
      started = resolve
    })
    const hold = new Promise<void>((resolve) => {
      release = resolve
    })
    const file = path.join(authDir, 'fixture-token')
    const oldWrite = oldGuard.mutate(async () => {
      started()
      await hold
      await fs.writeFile(file, 'old')
    })
    const oldRejected = oldWrite.catch((error: unknown) => error)
    await entered
    await fs.writeFile(path.join(authDir, 'router-generation'), `${randomUUID()}\n`)
    const newGuard = await GenerationGuard.create(authDir)
    const replacement = newGuard.mutate(async () => {
      await fs.writeFile(file, 'new')
    })
    release()
    const [failure] = await Promise.all([oldRejected, replacement])
    expect(failure).toBeInstanceOf(Error)
    expect((failure as Error).message).toContain('sign-in changed')
    expect(await fs.readFile(file, 'utf8')).toBe('new')
    await expect(oldGuard.mutate(() => fs.writeFile(file, 'stale'))).rejects.toThrow('sign-in changed')
    expect(await fs.readFile(file, 'utf8')).toBe('new')
  })
})

const entry = fileURLToPath(new URL('../router-connection.ts', import.meta.url))
const childEnv = (spec: ConnectionSpec) => ({
  PATH: process.env.PATH || '',
  HOME: process.env.HOME || '',
  CUSTOMER_ROUTER_SPEC: JSON.stringify(spec),
})
async function checkChild(spec: ConnectionSpec) {
  return await new Promise<{ output: string; stderr: string; code: number | null }>((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', entry, '--mode', 'check'], {
      env: childEnv(spec),
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let output = ''
    let stderr = ''
    child.stdout.on('data', (part) => {
      output += part
    })
    child.stderr.on('data', (part) => {
      stderr += part
    })
    child.once('error', reject)
    child.once('close', (code) => resolve({ output, stderr, code }))
    cleanups.push(async () => {
      child.kill()
    })
  })
}

async function fixture() {
  let origin = ''
  let refreshes = 0
  let revoked = false
  let writes = 0
  let registrations = 0
  let authorizationServerOverride: string | undefined
  let tokenEndpointOverride: string | undefined
  const redirectUris: string[] = []
  const calls: Array<{ org: string; method: string; tool?: string }> = []
  const server = http.createServer(async (request, response) => {
    const json = (value: unknown, status = 200, headers: Record<string, string> = {}) => {
      response.writeHead(status, { 'content-type': 'application/json', ...headers }).end(JSON.stringify(value))
    }
    if (request.url?.startsWith('/.well-known/oauth-protected-resource')) {
      json({ resource: `${origin}/mcp`, authorization_servers: [authorizationServerOverride || origin], scopes_supported: ['mcp:tools'] })
      return
    }
    if (request.url?.startsWith('/.well-known/')) {
      json({
        issuer: origin,
        authorization_endpoint: `${origin}/authorize`,
        token_endpoint: tokenEndpointOverride || `${origin}/token`,
        registration_endpoint: `${origin}/register`,
        response_types_supported: ['code'],
        grant_types_supported: ['authorization_code', 'refresh_token'],
        token_endpoint_auth_methods_supported: ['none'],
        code_challenge_methods_supported: ['S256'],
      })
      return
    }
    if (request.url === '/register') {
      registrations++
      let body = ''
      for await (const part of request) body += part
      json({ ...JSON.parse(body), client_id: 'fixture', token_endpoint_auth_method: 'none' }, 201)
      return
    }
    if (request.url?.startsWith('/authorize?')) {
      const authorization = new URL(request.url, origin)
      const redirect = authorization.searchParams.get('redirect_uri') || ''
      redirectUris.push(redirect)
      const callback = new URL(redirect)
      callback.searchParams.set('code', 'fixture-code')
      callback.searchParams.set('state', authorization.searchParams.get('state') || '')
      response.writeHead(302, { location: callback.href }).end()
      return
    }
    if (request.url === '/token') {
      let body = ''
      for await (const part of request) body += part
      const params = new URLSearchParams(body)
      if (params.get('grant_type') === 'authorization_code' && params.get('code') === 'fixture-code') {
        json({
          access_token: 'fresh-customer-a',
          token_type: 'Bearer',
          expires_in: 3600,
          refresh_token: 'refresh-customer-a',
          scope: 'mcp:tools',
        })
        return
      }
      if (params.get('grant_type') !== 'refresh_token') {
        json({ error: 'unsupported_grant_type' }, 400)
        return
      }
      refreshes++
      if (revoked) {
        json({ error: 'invalid_grant' }, 400)
        return
      }
      await new Promise((resolve) => setTimeout(resolve, 100))
      const org = params.get('refresh_token')?.replace('refresh-', '') || 'unknown'
      json({ access_token: `fresh-${org}`, token_type: 'Bearer', expires_in: 3600, refresh_token: `refresh-${org}`, scope: 'mcp:tools' })
      return
    }
    const authorization = request.headers.authorization || ''
    if (revoked || !authorization.startsWith('Bearer fresh-')) {
      json({ error: 'unauthorized' }, 401, {
        'www-authenticate': `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp"`,
      })
      return
    }
    if (request.method !== 'POST') {
      response.writeHead(405).end()
      return
    }
    let body = ''
    for await (const part of request) body += part
    const message = JSON.parse(body)
    const org = authorization.replace('Bearer fresh-', '')
    calls.push({ org, method: message.method, tool: message.params?.name })
    if (message.id === undefined) {
      response.writeHead(202).end()
      return
    }
    const reply = (result: unknown) => json({ jsonrpc: '2.0', id: message.id, result })
    if (message.method === 'initialize') {
      reply({ protocolVersion: '2025-11-25', capabilities: { tools: {} }, serverInfo: { name: 'fixture', version: '1' } })
    } else if (message.method === 'tools/list') {
      reply({ tools: [{ name: 'echo', description: 'Read the fixture identity.', inputSchema: { type: 'object' } }] })
    } else if (message.method === 'tools/call' && message.params.name === 'project_list') {
      reply(identity(org, origin))
    } else if (message.method === 'tools/call' && message.params.name === 'write_once') {
      writes++
      response.destroy()
    } else if (message.method === 'tools/call' && message.params.name === 'write_then_404') {
      writes++
      json({ error: 'Session not found' }, 404)
    } else if (message.method === 'tools/call' && message.params.name === 'echo') {
      reply({ content: [{ type: 'text', text: org }] })
    } else {
      json({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Method not found' } })
    }
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  cleanups.push(async () => {
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })
  const spec = async (org: string, expired = false): Promise<ConnectionSpec> => {
    const authDir = await tempAuth()
    const serverUrl = `${origin}/mcp`
    const directory = path.join(authDir, 'mcp-remote-v1')
    await fs.mkdir(directory)
    const hash = getServerUrlHash(serverUrl)
    await fs.writeFile(
      path.join(directory, `${hash}_client_info.json`),
      JSON.stringify({
        client_id: 'fixture',
        issuer: origin,
        token_endpoint_auth_method: 'none',
        redirect_uris: ['http://localhost:18400/oauth/callback'],
      }),
    )
    await fs.writeFile(
      path.join(directory, `${hash}_tokens.json`),
      JSON.stringify({
        access_token: `${expired ? 'expired' : 'fresh'}-${org}`,
        token_type: 'Bearer',
        expires_in: 3600,
        expires_at: expired ? Date.now() - 1000 : Date.now() + 3600000,
        refresh_token: `refresh-${org}`,
        scope: 'mcp:tools',
        requested_scope: 'mcp:tools',
        issuer: origin,
      }),
    )
    return { authDir, customer: { id: randomUUID(), name: org, expectedOrgId: org, serverUrl, callbackPort: 18400 } }
  }
  const client = async (configuration: ConnectionSpec) => {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ['--import', 'tsx', entry, '--mode', 'serve'],
      env: childEnv(configuration),
      stderr: 'pipe',
    })
    let stderr = ''
    transport.stderr?.on('data', (part) => {
      stderr += part
    })
    const connected = new Client({ name: 'test-client', version: '1' }, { capabilities: {} })
    cleanups.push(async () => {
      await connected.close()
      await transport.close()
    })
    await connected.connect(transport, { timeout: 15000 })
    return { client: connected, stderr: () => stderr }
  }
  return {
    spec,
    client,
    calls,
    refreshes: () => refreshes,
    writes: () => writes,
    registrations: () => registrations,
    redirectUris,
    origin: () => origin,
    changeAuthorizationServer: (issuer: string) => {
      authorizationServerOverride = issuer
    },
    changeTokenEndpoint: (tokenUrl: string) => {
      tokenEndpointOverride = tokenUrl
    },
    revoke: () => {
      revoked = true
    },
  }
}

describe('real SDK clients against a local OAuth fixture', () => {
  it('completes explicit fresh sign-in on the assigned callback port using only the selected customer store', async () => {
    const remote = await fixture()
    const configuration = await remote.spec('customer-b')
    configuration.customer.expectedOrgId = 'customer-a'
    const unused = await remote.spec('customer-b')
    const before = await fs.readFile(
      path.join(unused.authDir, 'mcp-remote-v1', `${getServerUrlHash(unused.customer.serverUrl)}_tokens.json`),
      'utf8',
    )
    const portProbe = http.createServer()
    await new Promise<void>((resolve) => portProbe.listen(0, '127.0.0.1', resolve))
    configuration.customer.callbackPort = (portProbe.address() as { port: number }).port
    await new Promise<void>((resolve) => portProbe.close(() => resolve()))
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const browserRequests: Promise<unknown>[] = []
    vi.mocked(open).mockImplementation(async (target) => {
      browserRequests.push(fetch(String(target)).then((response) => response.text()))
      return {} as ChildProcess
    })
    const prior = process.env.MCP_REMOTE_CONFIG_DIR
    try {
      const connection = await runCustomerConnection(configuration, 'connect')
      expect(connection.check).toMatchObject({ state: 'verified', observedOrgId: 'customer-a' })
      expect(remote.redirectUris).toEqual([`http://localhost:${configuration.customer.callbackPort}/oauth/callback`])
      expect(remote.registrations()).toBe(1)
      expect(open).toHaveBeenCalledTimes(1)
      const hash = getServerUrlHash(configuration.customer.serverUrl)
      const cache = path.join(configuration.authDir, 'mcp-remote-v1')
      expect(JSON.parse(await fs.readFile(path.join(cache, `${hash}_tokens.json`), 'utf8')).issuer).toBe(remote.origin())
      expect(JSON.parse(await fs.readFile(path.join(cache, `${hash}_client_info.json`), 'utf8')).issuer).toBe(remote.origin())
      await Promise.all(browserRequests)
      expect(
        await fs.readFile(path.join(unused.authDir, 'mcp-remote-v1', `${getServerUrlHash(unused.customer.serverUrl)}_tokens.json`), 'utf8'),
      ).toBe(before)
    } finally {
      if (prior === undefined) delete process.env.MCP_REMOTE_CONFIG_DIR
      else process.env.MCP_REMOTE_CONFIG_DIR = prior
    }
  }, 15000)

  it('shares one refreshed customer grant between two clients and preserves each downstream handshake', async () => {
    const remote = await fixture()
    const spec = await remote.spec('customer-a', true)
    const [first, second] = await Promise.all([remote.client(spec), remote.client(spec)])
    expect(await first.client.callTool({ name: 'echo', arguments: {} })).toMatchObject({ content: [{ text: 'customer-a' }] })
    expect(await second.client.callTool({ name: 'echo', arguments: {} })).toMatchObject({ content: [{ text: 'customer-a' }] })
    expect(remote.refreshes()).toBe(1)
    const refreshed = JSON.parse(
      await fs.readFile(path.join(spec.authDir, 'mcp-remote-v1', `${getServerUrlHash(spec.customer.serverUrl)}_tokens.json`), 'utf8'),
    )
    expect(refreshed.issuer).toBe(remote.origin())
    expect(remote.calls.filter((call) => call.tool === 'project_list')).toHaveLength(2)
    expect(remote.calls.filter((call) => call.method === 'initialize')).toHaveLength(4)
    expect(first.stderr() + second.stderr()).toBe('')
    await fs.writeFile(path.join(spec.authDir, 'router-generation'), `${randomUUID()}\n`)
    await expect(first.client.callTool({ name: 'echo', arguments: {} })).rejects.toThrow('sign-in changed')
    expect(remote.calls.filter((call) => call.tool === 'echo')).toHaveLength(2)
  }, 25000)

  it.each(['authorization-server', 'token-endpoint'])(
    'does not send saved credentials to a changed %s',
    async (change) => {
      const trusted = await fixture()
      const other = await fixture()
      const configuration = await trusted.spec('customer-a', true)
      if (change === 'authorization-server') trusted.changeAuthorizationServer(other.origin())
      else trusted.changeTokenEndpoint(`${other.origin()}/token`)
      const result = await checkChild(configuration)
      expect(JSON.parse(result.output)).toMatchObject({
        state: 'unverified',
        message: 'The authorization server identity is missing or changed. Tools are blocked.',
      })
      expect(other.refreshes()).toBe(0)
      expect(other.registrations()).toBe(0)
      expect(trusted.refreshes()).toBe(0)
      expect(trusted.calls).toHaveLength(0)
      expect(result.stderr).toBe('')
    },
    15000,
  )

  it('rejects an unstamped saved grant before any refresh request', async () => {
    const remote = await fixture()
    const configuration = await remote.spec('customer-a', true)
    const file = path.join(configuration.authDir, 'mcp-remote-v1', `${getServerUrlHash(configuration.customer.serverUrl)}_tokens.json`)
    const stored = JSON.parse(await fs.readFile(file, 'utf8'))
    delete stored.issuer
    await fs.writeFile(file, JSON.stringify(stored))
    const result = await checkChild(configuration)
    expect(JSON.parse(result.output)).toMatchObject({ state: 'unverified' })
    expect(remote.refreshes()).toBe(0)
    expect(remote.calls).toHaveLength(0)
  }, 15000)

  it('keeps the same server URL isolated across two customer stores', async () => {
    const remote = await fixture()
    const [a, b] = await Promise.all([remote.spec('customer-a'), remote.spec('customer-b')])
    const [first, second] = await Promise.all([remote.client(a), remote.client(b)])
    expect(await first.client.callTool({ name: 'echo', arguments: {} })).toMatchObject({ content: [{ text: 'customer-a' }] })
    expect(await second.client.callTool({ name: 'echo', arguments: {} })).toMatchObject({ content: [{ text: 'customer-b' }] })
    const wrong = await checkChild({ ...a, customer: { ...a.customer, expectedOrgId: 'customer-b' } })
    expect(JSON.parse(wrong.output)).toMatchObject({ state: 'mismatch', observedOrgId: 'customer-a' })
    expect(wrong.stderr).toBe('')
  }, 25000)

  it.each(['write_once', 'write_then_404'])(
    'does not replay an uncertain tool outcome: %s',
    async (tool) => {
      const remote = await fixture()
      const configuration = await remote.spec('customer-a')
      const connected = await remote.client(configuration)
      await expect(connected.client.callTool({ name: tool, arguments: {} }, { timeout: 3000 })).rejects.toThrow('tool outcome is unknown')
      expect(remote.writes()).toBe(1)
      expect(remote.calls.filter((call) => call.tool === tool)).toHaveLength(1)
      // Another request succeeds without replaying the uncertain operation.
      expect(await connected.client.callTool({ name: 'echo', arguments: {} })).toMatchObject({ content: [{ text: 'customer-a' }] })
      expect(remote.writes()).toBe(1)
    },
    15000,
  )

  it('blocks interactive reauthorization after a running connection loses its grant', async () => {
    const remote = await fixture()
    const configuration = await remote.spec('customer-a')
    const connected = await remote.client(configuration)
    remote.revoke()
    await expect(connected.client.callTool({ name: 'echo', arguments: {} })).rejects.toThrow('Sign in from the customer dashboard')
    expect(remote.calls.filter((call) => call.tool === 'echo')).toHaveLength(0)
    expect(remote.registrations()).toBe(0)
    expect(connected.stderr()).toBe('')
  }, 15000)

  it('returns an unsigned state without starting login when no credential exists', async () => {
    const remote = await fixture()
    const spec = await remote.spec('customer-a')
    await fs.rm(path.join(spec.authDir, 'mcp-remote-v1'), { recursive: true })
    const result = await checkChild(spec)
    expect(JSON.parse(result.output)).toMatchObject({ state: 'unverified' })
    expect(result.stderr).toBe('')
    expect(remote.calls).toHaveLength(0)
    expect(remote.refreshes()).toBe(0)
  }, 15000)
})
