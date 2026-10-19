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
import { NodeOAuthClientProvider } from '../lib/node-oauth-client-provider'
import * as browser from '../lib/open-browser'

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

  it('accepts the one-character organization ID 1 and still blocks a different expected ID', () => {
    expect(verifyIdentity(identity('1'), endpoint, '1')).toBe('1')
    expect(() => verifyIdentity(identity('1'), endpoint, '2')).toThrow('different organization')
    expect(() => verifyIdentity(identity('1'), endpoint, '')).toThrow('valid organization identity')
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

async function fixture({ holdIdentity = false } = {}) {
  let releaseIdentity!: () => void
  let markIdentityRequested!: () => void
  const identityReleased = new Promise<void>((resolve) => {
    releaseIdentity = resolve
  })
  const identityRequested = new Promise<void>((resolve) => {
    markIdentityRequested = resolve
  })
  if (!holdIdentity) releaseIdentity()
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
      markIdentityRequested()
      await identityReleased
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
    releaseIdentity()
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
    identityRequested,
    releaseIdentity,
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

async function rawClient(configuration: ConnectionSpec) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ['--import', 'tsx', entry, '--mode', 'serve'],
    env: childEnv(configuration),
    stderr: 'pipe',
  })
  const messages: Array<Parameters<Transport['send']>[0]> = []
  const errors: string[] = []
  let closed = false
  let stderr = ''
  transport.onmessage = (message) => {
    messages.push(message)
  }
  transport.onerror = (error) => {
    errors.push(error.message)
  }
  transport.onclose = () => {
    closed = true
  }
  transport.stderr?.on('data', (part) => {
    stderr += part
  })
  cleanups.push(() => transport.close())
  await transport.start()
  return {
    transport,
    messages,
    errors,
    closed: () => closed,
    stderr: () => stderr,
    response: async (id: string) => {
      await vi.waitFor(() => expect(messages.some((message) => 'id' in message && message.id === id)).toBe(true), { timeout: 5000 })
      return messages.find((message) => 'id' in message && message.id === id)
    },
  }
}

async function freeCallbackPort() {
  const server = http.createServer()
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as { port: number }).port
  await new Promise<void>((resolve) => server.close(() => resolve()))
  return port
}

describe('real SDK clients against a local OAuth fixture', () => {
  it('answers discovery while identity is held, then completes the legacy handshake and exposes tools once verified', async () => {
    const remote = await fixture({ holdIdentity: true })
    const configuration = await remote.spec('customer-a')
    const raw = await rawClient(configuration)
    const probeId = 'server-discover-probe-1'
    await raw.transport.send({ jsonrpc: '2.0', id: probeId, method: 'server/discover', params: {} })
    expect(await raw.response(probeId)).toMatchObject({ id: probeId, error: { code: -32601 } })
    await raw.transport.send({
      jsonrpc: '2.0',
      id: 'client-initialize',
      method: 'initialize',
      params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'held-identity-client', version: '1' } },
    })
    await remote.identityRequested
    expect(raw.messages).toHaveLength(1)
    expect(remote.calls.filter((call) => call.method === 'initialize')).toHaveLength(1)
    expect(remote.calls.filter((call) => call.method === 'tools/call').map((call) => call.tool)).toEqual(['project_list'])
    expect(remote.calls.filter((call) => call.method === 'tools/list')).toHaveLength(0)

    remote.releaseIdentity()
    expect(await raw.response('client-initialize')).toMatchObject({ result: { capabilities: { tools: {} } } })
    await raw.transport.send({ jsonrpc: '2.0', method: 'notifications/initialized' })
    await raw.transport.send({ jsonrpc: '2.0', id: 'client-tools', method: 'tools/list', params: {} })
    expect(await raw.response('client-tools')).toMatchObject({ result: { tools: [{ name: 'echo' }] } })
    await raw.transport.send({ jsonrpc: '2.0', id: 'client-echo', method: 'tools/call', params: { name: 'echo', arguments: {} } })
    expect(await raw.response('client-echo')).toMatchObject({ result: { content: [{ text: 'customer-a' }] } })
    expect(raw.messages.filter((message) => 'id' in message && message.id === probeId)).toHaveLength(1)
    expect(remote.calls.filter((call) => call.method === 'initialize')).toHaveLength(2)
    expect(raw.errors).toEqual([])
    expect(raw.stderr()).toBe('')
  }, 15000)

  it('closes without forwarding queued requests when the held identity belongs to another customer', async () => {
    const remote = await fixture({ holdIdentity: true })
    const configuration = await remote.spec('customer-b')
    configuration.customer.expectedOrgId = 'customer-a'
    const raw = await rawClient(configuration)
    const probeId = 'server-discover-probe-1'
    await raw.transport.send({ jsonrpc: '2.0', id: probeId, method: 'server/discover', params: {} })
    expect(await raw.response(probeId)).toMatchObject({ id: probeId, error: { code: -32601 } })
    await raw.transport.send({
      jsonrpc: '2.0',
      id: 'client-initialize',
      method: 'initialize',
      params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'mismatched-identity-client', version: '1' } },
    })
    await raw.transport.send({ jsonrpc: '2.0', id: 'queued-echo', method: 'tools/call', params: { name: 'echo', arguments: {} } })
    await remote.identityRequested
    expect(remote.calls.filter((call) => call.method === 'tools/call').map((call) => call.tool)).toEqual(['project_list'])

    remote.releaseIdentity()
    await vi.waitFor(() => expect(raw.closed()).toBe(true), { timeout: 5000 })
    expect(raw.messages).toHaveLength(1)
    expect(remote.calls.filter((call) => call.method === 'initialize')).toHaveLength(1)
    expect(remote.calls.filter((call) => call.method === 'tools/call').map((call) => call.tool)).toEqual(['project_list'])
    expect(raw.stderr()).toBe('This sign-in belongs to a different organization. Tools are blocked.\n')
  }, 15000)

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

  it('provides a usable sign-in link before an unsuccessful browser launch', async () => {
    const remote = await fixture()
    const configuration = await remote.spec('customer-a')
    configuration.customer.callbackPort = await freeCallbackPort()
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const launch = vi.spyOn(browser, 'openBrowser').mockResolvedValue(false)
    const browserRequests: Promise<unknown>[] = []
    const onAuthorizationUrl = vi.fn((url: string) => {
      expect(launch).not.toHaveBeenCalled()
      browserRequests.push(fetch(url).then((response) => response.text()))
    })
    const prior = process.env.MCP_REMOTE_CONFIG_DIR
    try {
      const connection = await runCustomerConnection(configuration, 'connect', undefined, onAuthorizationUrl)
      expect(connection.check).toMatchObject({ state: 'verified', observedOrgId: 'customer-a' })
      expect(onAuthorizationUrl).toHaveBeenCalledTimes(1)
      expect(launch).toHaveBeenCalledWith(onAuthorizationUrl.mock.calls[0][0])
      expect(remote.redirectUris).toEqual([`http://localhost:${configuration.customer.callbackPort}/oauth/callback`])
      await Promise.all(browserRequests)
    } finally {
      if (prior === undefined) delete process.env.MCP_REMOTE_CONFIG_DIR
      else process.env.MCP_REMOTE_CONFIG_DIR = prior
    }
  }, 15000)

  it('delivers the child IPC link when its browser cannot start and keeps stdout limited to the final check', async () => {
    const remote = await fixture()
    const configuration = await remote.spec('customer-a')
    configuration.customer.callbackPort = await freeCallbackPort()
    const loader = path.join(configuration.authDir, 'blocked-browser-loader.mjs')
    const bootstrap = path.join(configuration.authDir, 'register-loader.mjs')
    await fs.writeFile(
      loader,
      `export function resolve(name, context, next) {
      if (name === 'open') return {
        url: 'data:text/javascript,export default async function() { throw new Error("fixture browser unavailable") }',
        shortCircuit: true
      }
      return next(name, context)
    }`,
    )
    await fs.writeFile(bootstrap, `import { register } from 'node:module'; register('./blocked-browser-loader.mjs', import.meta.url)`)
    const messages: unknown[] = []
    const browserRequests: Promise<unknown>[] = []
    const result = await new Promise<{ output: string; stderr: string; code: number | null }>((resolve, reject) => {
      const child = spawn(process.execPath, ['--import', 'tsx', '--import', bootstrap, entry, '--mode', 'connect'], {
        env: childEnv(configuration),
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      })
      let output = ''
      let stderr = ''
      const deadline = setTimeout(() => {
        child.kill()
        reject(new Error('The child sign-in fixture timed out.'))
      }, 12000)
      child.stdout?.on('data', (part) => {
        output += part
      })
      child.stderr?.on('data', (part) => {
        stderr += part
      })
      child.on('message', (message) => {
        messages.push(message)
        const event = message as { type?: string; url?: string }
        if (event.type === 'authorization_ready' && typeof event.url === 'string') {
          browserRequests.push(fetch(event.url).then((response) => response.text()))
        }
      })
      child.once('error', reject)
      child.once('close', (code) => {
        clearTimeout(deadline)
        resolve({ output, stderr, code })
      })
      cleanups.push(async () => {
        clearTimeout(deadline)
        child.kill()
      })
    })
    await Promise.all(browserRequests)
    expect(messages).toEqual([{ type: 'authorization_ready', url: expect.stringContaining(`${remote.origin()}/authorize?`) }])
    expect(result.code).toBe(0)
    expect(result.output.trim().split('\n')).toHaveLength(1)
    expect(JSON.parse(result.output)).toMatchObject({ state: 'verified', observedOrgId: 'customer-a' })
    expect(result.output).not.toContain('authorization_ready')
    expect(result.stderr).toBe('')
    expect(remote.redirectUris).toEqual([`http://localhost:${configuration.customer.callbackPort}/oauth/callback`])
  }, 15000)

  it.each(['endpoint', 'redirect', 'duplicate-redirect', 'generation'])(
    'does not publish or open a sign-in link after its %s changes',
    async (change) => {
      const remote = await fixture()
      const configuration = await remote.spec('customer-a')
      configuration.customer.callbackPort = await freeCallbackPort()
      vi.spyOn(console, 'error').mockImplementation(() => {})
      const launch = vi.spyOn(browser, 'openBrowser').mockResolvedValue(false)
      const onAuthorizationUrl = vi.fn()
      const redirect = NodeOAuthClientProvider.prototype.redirectToAuthorization
      vi.spyOn(NodeOAuthClientProvider.prototype, 'redirectToAuthorization').mockImplementation(async function (
        this: NodeOAuthClientProvider,
        url: URL,
      ) {
        if (change === 'endpoint') url.pathname = '/untrusted'
        else if (change === 'redirect') url.searchParams.set('redirect_uri', 'https://untrusted.example/callback')
        else if (change === 'duplicate-redirect') url.searchParams.append('redirect_uri', 'https://untrusted.example/callback')
        else await fs.writeFile(path.join(configuration.authDir, 'router-generation'), `${randomUUID()}\n`)
        await redirect.call(this, url)
      })
      const prior = process.env.MCP_REMOTE_CONFIG_DIR
      try {
        await expect(runCustomerConnection(configuration, 'connect', undefined, onAuthorizationUrl)).rejects.toThrow('sign-in')
        expect(onAuthorizationUrl).not.toHaveBeenCalled()
        expect(launch).not.toHaveBeenCalled()
        expect(remote.redirectUris).toHaveLength(0)
      } finally {
        if (prior === undefined) delete process.env.MCP_REMOTE_CONFIG_DIR
        else process.env.MCP_REMOTE_CONFIG_DIR = prior
      }
    },
    15000,
  )

  it.each(['check', 'serve'] as const)(
    'never publishes a sign-in link during %s when a grant is revoked',
    async (mode) => {
      const remote = await fixture()
      const configuration = await remote.spec('customer-a')
      remote.revoke()
      vi.spyOn(console, 'error').mockImplementation(() => {})
      const launch = vi.spyOn(browser, 'openBrowser').mockResolvedValue(false)
      const onAuthorizationUrl = vi.fn()
      const prior = process.env.MCP_REMOTE_CONFIG_DIR
      try {
        await expect(runCustomerConnection(configuration, mode, undefined, onAuthorizationUrl)).rejects.toThrow(
          'Sign in from the customer dashboard',
        )
        expect(onAuthorizationUrl).not.toHaveBeenCalled()
        expect(launch).not.toHaveBeenCalled()
        expect(remote.redirectUris).toHaveLength(0)
      } finally {
        if (prior === undefined) delete process.env.MCP_REMOTE_CONFIG_DIR
        else process.env.MCP_REMOTE_CONFIG_DIR = prior
      }
    },
    15000,
  )

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
    const [a, b] = await Promise.all([remote.spec('1'), remote.spec('customer-b')])
    const [first, second] = await Promise.all([remote.client(a), remote.client(b)])
    expect(await first.client.callTool({ name: 'echo', arguments: {} })).toMatchObject({ content: [{ text: '1' }] })
    expect(await second.client.callTool({ name: 'echo', arguments: {} })).toMatchObject({ content: [{ text: 'customer-b' }] })
    const wrong = await checkChild({ ...a, customer: { ...a.customer, expectedOrgId: 'customer-b' } })
    expect(JSON.parse(wrong.output)).toMatchObject({ state: 'mismatch', observedOrgId: '1' })
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
