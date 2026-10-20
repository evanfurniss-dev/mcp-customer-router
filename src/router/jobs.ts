import { spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { RegistryStore } from './registry'
import { UserError, type ConnectionCheck, type ConnectionJob, type Customer } from './types'
import { resolveRuntimePaths } from './runtime-paths'

export function connectionEnvironment(customer: Customer, authDir: string): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {}
  for (const key of [
    'PATH',
    'HOME',
    'USER',
    'TMPDIR',
    'TEMP',
    'SystemRoot',
    'NODE_EXTRA_CA_CERTS',
    'HTTPS_PROXY',
    'HTTP_PROXY',
    'NO_PROXY',
  ]) {
    if (process.env[key]) environment[key] = process.env[key]
  }
  environment.CUSTOMER_ROUTER_SPEC = JSON.stringify({ customer, authDir })
  environment.MCP_REMOTE_CONFIG_DIR = authDir
  return environment
}

type JobRunner = (
  customer: Customer,
  mode: 'connect' | 'check',
  authDir: string,
  signal: AbortSignal,
  onAuthorizationReady?: (url: string) => Promise<void>,
) => Promise<ConnectionCheck>

function authorizationUrl(customer: Customer, value: string): string | undefined {
  if (value.length > 8192) return
  try {
    const url = new URL(value)
    if (url.origin !== new URL(customer.serverUrl).origin || url.username || url.password || url.hash) return
    const params = url.searchParams
    for (const key of ['client_id', 'state', 'code_challenge', 'code_challenge_method', 'response_type', 'redirect_uri']) {
      if (params.getAll(key).length !== 1 || !params.get(key)) return
    }
    if (
      params.get('response_type') !== 'code' ||
      params.get('code_challenge_method') !== 'S256' ||
      params.get('redirect_uri') !== `http://localhost:${customer.callbackPort}/oauth/callback` ||
      ['code', 'access_token', 'refresh_token', 'client_secret', 'code_verifier'].some((key) => params.has(key))
    )
      return
    return url.href
  } catch {
    return
  }
}

export const runConnectionCheck: JobRunner = (customer, mode, authDir, signal, onAuthorizationReady = async () => {}) =>
  new Promise((resolve, reject) => {
    const runtime = resolveRuntimePaths()
    const child = spawn(runtime.nodePath, [runtime.connectionPath, '--mode', mode], {
      cwd: authDir,
      env: connectionEnvironment(customer, authDir),
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      signal,
    })
    if (!child.stdout || !child.stderr) {
      child.kill()
      reject(new UserError('Could not open the connection check channels. Restart the router.'))
      return
    }
    let output = ''
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      output += chunk
      if (output.length > 16000) child.kill()
    })
    // Raw OAuth output can contain codes or token details. It never enters API responses or logs.
    child.stderr.resume()
    child.on('message', (message) => {
      if (mode !== 'connect' || !message || typeof message !== 'object' || !('type' in message) || message.type !== 'authorization_ready')
        return
      if ('url' in message && typeof message.url === 'string') void onAuthorizationReady(message.url).catch(() => {})
    })
    child.once('error', () => reject(new UserError('Could not start the connection check. Build the router and try again.')))
    child.once('close', () => {
      try {
        const parsed = JSON.parse(output.trim()) as ConnectionCheck
        if (!['verified', 'error', 'mismatch', 'unverified'].includes(parsed.state) || typeof parsed.message !== 'string') throw new Error()
        resolve(parsed)
      } catch {
        reject(new UserError('The connection check ended before it returned a result. Try connecting again.'))
      }
    })
  })

export class ConnectionJobs {
  private readonly entries = new Map<string, ConnectionJob>()
  private readonly controllers = new Map<string, AbortController>()
  private readonly generations = new Map<string, string>()

  constructor(
    private readonly store: RegistryStore,
    private readonly run: JobRunner = runConnectionCheck,
  ) {}

  list(): ConnectionJob[] {
    return [...this.entries.values()]
  }

  async snapshot(): Promise<ConnectionJob[]> {
    await Promise.all(
      this.list().map(async (job) => {
        if (!job.authorizationUrl) return
        const current = await this.store.generation(job.customerId).catch(() => undefined)
        if (job.state !== 'running' || current !== this.generations.get(job.id)) delete job.authorizationUrl
      }),
    )
    return this.list()
  }

  isRunning(customerId: string): boolean {
    return this.list().some((job) => job.customerId === customerId && job.state === 'running')
  }

  async start(customerId: string, mode: 'connect' | 'check'): Promise<string> {
    if (this.isRunning(customerId)) throw new UserError('A connection check is already running for this customer.', 409)
    if (this.controllers.size >= 4) throw new UserError('Four checks are already running. Wait for one to finish.', 429)
    const customer = await this.store.customer(customerId)
    // Recheck after the asynchronous read before reserving this customer.
    if (this.isRunning(customerId)) throw new UserError('A connection check is already running for this customer.', 409)
    if (this.controllers.size >= 4) throw new UserError('Four checks are already running. Wait for one to finish.', 429)
    const job: ConnectionJob = {
      id: randomUUID(),
      customerId,
      state: 'running',
      message: mode === 'connect' ? 'Preparing Glide sign-in…' : 'Checking the saved connection.',
      startedAt: new Date().toISOString(),
    }
    const controller = new AbortController()
    this.entries.set(job.id, job)
    this.controllers.set(job.id, controller)
    let generation: string
    try {
      generation = mode === 'connect' ? await this.store.beginConnect(customerId) : await this.store.generation(customerId)
    } catch (error) {
      this.entries.delete(job.id)
      this.controllers.delete(job.id)
      throw error
    }
    this.generations.set(job.id, generation)
    let acceptsAuthorization = true
    controller.signal.addEventListener(
      'abort',
      () => {
        acceptsAuthorization = false
        delete job.authorizationUrl
      },
      { once: true },
    )
    const timer = setTimeout(() => controller.abort(), mode === 'connect' ? 300000 : 45000)
    timer.unref()
    void this.run(customer, mode, this.store.authDir(customerId), controller.signal, async (value) => {
      if (mode !== 'connect' || !acceptsAuthorization || controller.signal.aborted || job.state !== 'running') return
      const url = authorizationUrl(customer, value)
      if (!url || (await this.store.generation(customerId)) !== generation) return
      if (!acceptsAuthorization || controller.signal.aborted || job.state !== 'running') return
      job.authorizationUrl = url
      job.message = 'Glide sign-in is ready. Open the sign-in page, choose this customer’s organization, then return here.'
    })
      .then(async (check) => {
        acceptsAuthorization = false
        delete job.authorizationUrl
        await this.store.recordCheck(customerId, check, generation)
        job.state = check.state === 'verified' ? 'complete' : 'failed'
        job.message = check.message
      })
      .catch(async () => {
        acceptsAuthorization = false
        delete job.authorizationUrl
        job.state = 'failed'
        job.message = controller.signal.aborted ? 'The check timed out or was stopped. Try again.' : 'Connection failed. Try Connect again.'
        await this.store
          .recordCheck(customerId, { state: 'error', checkedAt: new Date().toISOString(), message: job.message }, generation)
          .catch(() => {})
      })
      .finally(() => {
        acceptsAuthorization = false
        delete job.authorizationUrl
        clearTimeout(timer)
        job.finishedAt = new Date().toISOString()
        this.controllers.delete(job.id)
        this.generations.delete(job.id)
        for (const [id, entry] of this.entries) {
          if (this.entries.size <= 100) break
          if (entry.state !== 'running') this.entries.delete(id)
        }
      })
    return job.id
  }

  close(): void {
    for (const controller of this.controllers.values()) controller.abort()
  }
}

export function forwardSignals(child: ChildProcess): void {
  for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => child.kill(signal))
  process.once('exit', () => child.kill('SIGTERM'))
}
