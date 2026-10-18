import fs from 'node:fs/promises'
import path from 'node:path'
import { EventEmitter } from 'node:events'
import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import {
  Client,
  StreamableHTTPClientTransport,
  createFetchWithInit,
  type Transport,
  type OAuthClientInformationContext,
  type OAuthDiscoveryState,
} from '@modelcontextprotocol/client'
import { NodeOAuthClientProvider, OAuthTokensWithExpiresAtSchema } from '../lib/node-oauth-client-provider'
import { readJsonFile } from '../lib/mcp-auth-config'
import { createLazyAuthCoordinator, hasUsableTokens } from '../lib/coordination'
import { connectToRemoteServer, discoverOAuthServerInfo, fetchWithMcpHeaders, getServerUrlHash, mcpProxy } from '../lib/utils'
import type { OAuthProviderOptions } from '../lib/types'
import type { ConnectionCheck, Customer } from './types'

export type ConnectionMode = 'connect' | 'check' | 'serve'
export interface ConnectionSpec {
  customer: Pick<Customer, 'id' | 'name' | 'serverUrl' | 'expectedOrgId' | 'callbackPort'>
  authDir: string
}

class ConnectionError extends Error {
  constructor(
    readonly state: ConnectionCheck['state'],
    message: string,
    readonly observedOrgId?: string,
  ) {
    super(message)
  }
}

export function connectionFailure(error: unknown): ConnectionCheck {
  return {
    state: error instanceof ConnectionError ? error.state : 'error',
    checkedAt: new Date().toISOString(),
    ...(error instanceof ConnectionError && error.observedOrgId ? { observedOrgId: error.observedOrgId } : {}),
    message: error instanceof ConnectionError ? error.message : 'The connection failed. Check the service and try again.',
  }
}

const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const orgIdPattern = /^[a-zA-Z0-9_-]{2,128}$/

function dashboardOrigin(serverUrl: string): string {
  const endpoint = new URL(serverUrl)
  if (endpoint.username || endpoint.password || endpoint.search || endpoint.hash || endpoint.pathname !== '/mcp') {
    throw new ConnectionError('error', 'The MCP address is not supported.')
  }
  if (endpoint.origin === 'https://mcp.glideapps.dev') return 'https://os.glideapps.dev'
  // A loopback endpoint exists only for local fixture testing. No arbitrary remote identity origins.
  if (endpoint.protocol === 'http:' && endpoint.hostname === '127.0.0.1' && endpoint.port) return endpoint.origin
  throw new ConnectionError('error', 'The MCP address is not supported.')
}

/** Read only the server-owned citation on project_list. Project content cannot establish identity. */
export function verifyIdentity(result: unknown, serverUrl: string, expectedOrgId: string): string {
  const missing = () => new ConnectionError('unverified', 'The server did not provide a valid organization identity. Tools are blocked.')
  const origin = dashboardOrigin(serverUrl)
  if (!orgIdPattern.test(expectedOrgId) || !record(result) || result.isError === true || !record(result.structuredContent)) throw missing()
  const data = result.structuredContent
  if (!Array.isArray(data.projects) || !Number.isInteger(data.count) || data.count !== data.projects.length) throw missing()
  if (typeof data.url !== 'string' || data.display_url !== data.url) throw missing()
  let citation: URL
  try {
    citation = new URL(data.url)
  } catch {
    throw missing()
  }
  const match = /^\/o\/([a-zA-Z0-9_-]{2,128})\/projects$/.exec(citation.pathname)
  if (citation.origin !== origin || citation.username || citation.password || citation.search || citation.hash || !match) throw missing()
  const observed = match[1]
  if ('orgId' in data && data.orgId !== observed) throw missing()
  if (observed !== expectedOrgId) {
    throw new ConnectionError('mismatch', 'This sign-in belongs to a different organization. Tools are blocked.', observed)
  }
  return observed
}

/** A fresh explicit sign-in invalidates every existing connection to this customer. */
export class GenerationGuard {
  private constructor(
    readonly authDir: string,
    private readonly generation: string,
  ) {}

  static async create(authDir: string): Promise<GenerationGuard> {
    if (!path.isAbsolute(authDir)) throw new ConnectionError('error', 'The customer credential directory is invalid.')
    const metadata = await fs.lstat(authDir)
    if (!metadata.isDirectory() || metadata.isSymbolicLink())
      throw new ConnectionError('error', 'The customer credential directory is invalid.')
    const generation = await GenerationGuard.read(authDir)
    return new GenerationGuard(authDir, generation)
  }

  private static async read(authDir: string): Promise<string> {
    const file = path.join(authDir, 'router-generation')
    if ((await fs.lstat(file)).isSymbolicLink()) throw new ConnectionError('unverified', 'The customer sign-in marker is invalid.')
    const value = (await fs.readFile(file, 'utf8')).trim()
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) {
      throw new ConnectionError('unverified', 'The customer sign-in marker is invalid.')
    }
    return value
  }

  async assertCurrent(): Promise<void> {
    let current: string
    try {
      current = await GenerationGuard.read(this.authDir)
    } catch {
      throw new ConnectionError('unverified', 'The customer sign-in changed. Restart this connection.')
    }
    if (current !== this.generation) throw new ConnectionError('unverified', 'The customer sign-in changed. Restart this connection.')
  }

  /** Serializes cache replacement with old refresh writes. A stopped owner cannot hold the lock forever. */
  async mutate<T>(operation: () => Promise<T>): Promise<T> {
    const lock = path.join(this.authDir, 'router-auth-write.lock')
    const owner = `${process.pid}:${randomUUID()}`
    let handle: Awaited<ReturnType<typeof fs.open>> | undefined
    for (let attempt = 0; attempt < 100; attempt++) {
      await this.assertCurrent()
      try {
        handle = await fs.open(lock, 'wx', 0o600)
        await handle.writeFile(owner)
        break
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
        try {
          const prior = await fs.readFile(lock, 'utf8')
          const ownerPid = Number(prior.split(':')[0])
          if (Number.isSafeInteger(ownerPid) && ownerPid > 0) {
            try {
              process.kill(ownerPid, 0)
            } catch (probeError) {
              if ((probeError as NodeJS.ErrnoException).code === 'ESRCH' && (await fs.readFile(lock, 'utf8')) === prior) {
                await fs.unlink(lock)
              }
            }
          }
        } catch (readError) {
          if ((readError as NodeJS.ErrnoException).code !== 'ENOENT') throw readError
        }
        await delay(50)
      }
    }
    if (!handle) throw new ConnectionError('error', 'The customer credential store is busy. Try again.')
    try {
      await this.assertCurrent()
      const result = await operation()
      await this.assertCurrent()
      return result
    } finally {
      await handle.close()
      if ((await fs.readFile(lock, 'utf8').catch(() => '')) === owner) await fs.unlink(lock)
    }
  }
}

class CustomerOAuthProvider extends NodeOAuthClientProvider {
  private readonly expectedIssuer: string
  constructor(
    options: OAuthProviderOptions,
    private readonly guard: GenerationGuard,
    private readonly allowLogin: boolean,
  ) {
    super(options)
    // This router supports Glide's same-origin OAuth service and the equivalent local fixture only.
    this.expectedIssuer = new URL(options.resourceServerUrl || options.serverUrl).origin
    this.assertEndpoint(options.serverUrl)
    this.assertMetadata(options.authorizationServerMetadata)
  }

  private assertIssuer(issuer: unknown): void {
    if (issuer !== this.expectedIssuer) {
      throw new ConnectionError('unverified', 'The authorization server identity is missing or changed. Tools are blocked.')
    }
  }

  private assertEndpoint(endpoint: unknown): void {
    try {
      if (typeof endpoint !== 'string') throw new Error()
      const url = new URL(endpoint)
      if (url.origin !== this.expectedIssuer || url.username || url.password || url.hash) throw new Error()
    } catch {
      throw new ConnectionError('unverified', 'The authorization server identity is missing or changed. Tools are blocked.')
    }
  }

  private assertMetadata(metadata: OAuthProviderOptions['authorizationServerMetadata']): void {
    this.assertIssuer(metadata?.issuer)
    this.assertEndpoint(metadata?.token_endpoint)
    if (metadata?.authorization_endpoint) this.assertEndpoint(metadata.authorization_endpoint)
    if (metadata?.registration_endpoint) this.assertEndpoint(metadata.registration_endpoint)
  }

  override async getAuthorizationServerMetadata() {
    const metadata = await super.getAuthorizationServerMetadata()
    this.assertMetadata(metadata)
    return metadata
  }

  override async saveDiscoveryState(state: OAuthDiscoveryState) {
    this.assertEndpoint(state.authorizationServerUrl)
    this.assertMetadata(state.authorizationServerMetadata)
    await super.saveDiscoveryState(state)
  }

  override async clientInformation(context?: OAuthClientInformationContext) {
    await this.guard.assertCurrent()
    if (context) this.assertIssuer(context.issuer)
    const information = await super.clientInformation(context)
    if (information) this.assertIssuer(information.issuer)
    return information
  }

  override async tokens(context?: OAuthClientInformationContext) {
    await this.guard.assertCurrent()
    if (context) this.assertIssuer(context.issuer)
    // super.tokens() may refresh before the SDK's issuer checks, so validate the persisted stamp first.
    const stored = await readJsonFile<Parameters<NodeOAuthClientProvider['saveTokens']>[0]>(
      this.options.serverUrlHash,
      'tokens.json',
      OAuthTokensWithExpiresAtSchema,
    )
    if (stored) this.assertIssuer(stored.issuer)
    const tokens = await super.tokens()
    await this.guard.assertCurrent()
    // The inherited proactive refresh returns the token response, which does not carry a local issuer stamp.
    return tokens ? { ...tokens, issuer: this.expectedIssuer } : undefined
  }

  override async saveTokens(tokens: Parameters<NodeOAuthClientProvider['saveTokens']>[0], context?: OAuthClientInformationContext) {
    await this.guard.mutate(async () => {
      if (context) this.assertIssuer(context.issuer)
      if (tokens.issuer !== undefined) this.assertIssuer(tokens.issuer)
      else {
        const prior = await readJsonFile<Parameters<NodeOAuthClientProvider['saveTokens']>[0]>(
          this.options.serverUrlHash,
          'tokens.json',
          OAuthTokensWithExpiresAtSchema,
        )
        this.assertIssuer(prior?.issuer)
      }
      await super.saveTokens({ ...tokens, issuer: this.expectedIssuer })
    })
  }

  override async saveClientInformation(
    info: Parameters<NodeOAuthClientProvider['saveClientInformation']>[0] & { issuer?: string },
    context?: OAuthClientInformationContext,
  ) {
    await this.guard.mutate(async () => {
      if (context) this.assertIssuer(context.issuer)
      this.assertIssuer(info.issuer)
      await super.saveClientInformation(info)
    })
  }

  override async saveCodeVerifier(verifier: string) {
    if (!this.allowLogin) throw new ConnectionError('unverified', 'Sign in from the customer dashboard, then restart this connection.')
    await this.guard.mutate(() => super.saveCodeVerifier(verifier))
  }

  override async invalidateCredentials(scope: Parameters<NodeOAuthClientProvider['invalidateCredentials']>[0]) {
    await this.guard.mutate(() => super.invalidateCredentials(scope))
  }

  override async redirectToAuthorization(url: URL) {
    await this.guard.assertCurrent()
    if (!this.allowLogin) throw new ConnectionError('unverified', 'Sign in from the customer dashboard, then restart this connection.')
    await super.redirectToAuthorization(url)
  }
}

export function guardTransport(transport: Transport, guard: GenerationGuard): void {
  const send = transport.send.bind(transport)
  transport.send = async (...args) => {
    await guard.assertCurrent()
    try {
      await send(...args)
    } catch (error) {
      // A failed response does not prove a tool failed to execute. Do not let the proxy replay it.
      if ('method' in args[0] && args[0].method === 'tools/call' && !(error instanceof ConnectionError)) {
        throw new ConnectionError(
          'error',
          'The tool outcome is unknown because the connection failed. Check the result before repeating a write.',
        )
      }
      throw error
    }
  }
}

/** Must run in a dedicated child process: the upstream auth store uses one process-wide directory. */
export async function runCustomerConnection(spec: ConnectionSpec, mode: ConnectionMode, local?: Transport) {
  const { customer, authDir } = spec
  dashboardOrigin(customer.serverUrl)
  if (
    !orgIdPattern.test(customer.expectedOrgId) ||
    !Number.isInteger(customer.callbackPort) ||
    customer.callbackPort < 1024 ||
    customer.callbackPort > 65535
  ) {
    throw new ConnectionError('error', 'The customer connection settings are invalid.')
  }
  const guard = await GenerationGuard.create(authDir)
  process.env.MCP_REMOTE_CONFIG_DIR = authDir
  const allowLogin = mode === 'connect'
  if (allowLogin) {
    await guard.mutate(() => fs.rm(path.join(authDir, 'mcp-remote-v1'), { recursive: true, force: true }))
  }
  const hash = getServerUrlHash(customer.serverUrl)
  if (!allowLogin && !(await hasUsableTokens(hash))) {
    throw new ConnectionError('unverified', 'Sign in from the customer dashboard, then check this connection.')
  }
  const coordinator = createLazyAuthCoordinator(hash, '/oauth/callback', customer.callbackPort, new EventEmitter(), 180_000, true)
  const probe = new Client(
    { name: 'customer-router-identity', version: '0.1.0' },
    { capabilities: {}, versionNegotiation: { mode: 'auto' } },
  )
  let remote: Transport | undefined
  let closed = false
  const close = async () => {
    if (closed) return
    closed = true
    await Promise.allSettled([probe.close(), coordinator.release(), ...(remote ? [remote.close()] : []), ...(local ? [local.close()] : [])])
  }
  try {
    const discovery = await discoverOAuthServerInfo(customer.serverUrl, {})
    await guard.assertCurrent()
    const provider = new CustomerOAuthProvider(
      {
        serverUrl: discovery.authorizationServerUrl,
        resourceServerUrl: customer.serverUrl,
        callbackPath: '/oauth/callback',
        callbackPort: customer.callbackPort,
        host: 'localhost',
        clientName: 'MCP Customer Router',
        fetchFn: createFetchWithInit(fetchWithMcpHeaders, {}),
        serverUrlHash: hash,
        authorizationServerMetadata: discovery.authorizationServerMetadata,
        protectedResourceMetadata: discovery.protectedResourceMetadata,
        wwwAuthenticateScope: discovery.wwwAuthenticateScope,
      },
      guard,
      allowLogin,
    )
    const initializeAuth = async (options?: { forceRefresh?: boolean }) => {
      await guard.assertCurrent()
      if (!allowLogin) throw new ConnectionError('unverified', 'Sign in from the customer dashboard, then restart this connection.')
      const auth = await coordinator.initializeAuth(options)
      if (auth.actualPort !== customer.callbackPort) throw new ConnectionError('error', 'The assigned sign-in port is unavailable.')
      return { waitForAuthCode: auth.waitForAuthCode, skipBrowserAuth: auth.skipBrowserAuth }
    }
    if (allowLogin) await initializeAuth()
    await connectToRemoteServer(probe, customer.serverUrl, provider, {}, initializeAuth, 'http-only', 'auto')
    await coordinator.release()
    await guard.assertCurrent()
    const result = await probe.callTool({ name: 'project_list', arguments: {} })
    const observedOrgId = verifyIdentity(result, customer.serverUrl, customer.expectedOrgId)
    await guard.assertCurrent()
    await probe.close()
    const check: ConnectionCheck = {
      state: 'verified',
      checkedAt: new Date().toISOString(),
      observedOrgId,
      message: 'Organization verified.',
    }
    if (mode !== 'serve') {
      await close()
      return { check, close }
    }
    if (!local) throw new ConnectionError('error', 'The local MCP transport is missing.')
    // This fresh transport has no handshake yet. The downstream client owns its initialize/discover.
    remote = new StreamableHTTPClientTransport(new URL(customer.serverUrl), { authProvider: provider, fetch: fetchWithMcpHeaders })
    guardTransport(remote, guard)
    mcpProxy({ transportToClient: local, transportToServer: remote, protocolMode: 'auto' })
    await remote.start()
    await local.start()
    return { check, close }
  } catch (error) {
    await close()
    throw error
  }
}
