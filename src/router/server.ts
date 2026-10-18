import express, { type NextFunction, type Request, type Response } from 'express'
import { createServer } from 'node:http'
import { randomUUID, timingSafeEqual } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import fs from 'node:fs/promises'
import { RegistryStore } from './registry'
import { ConnectionJobs } from './jobs'
import { UserError } from './types'
import {
  applyProjectConfig,
  rollbackProjectConfig,
  planProjectConfig,
  projectConfigPreview,
  type ProjectConfigPlan,
} from './project-config'

interface ServerOptions {
  store: RegistryStore
  jobs?: ConnectionJobs
  cliPath?: string
  webPath?: string
}

export function createRouterServer(options: ServerOptions) {
  const app = express()
  const server = createServer(app)
  const jobs = options.jobs ?? new ConnectionJobs(options.store)
  const token = randomUUID()
  const plans = new Map<string, { plan: ProjectConfigPlan; customerId: string; expiresAt: number }>()
  const cliPath = options.cliPath ?? fileURLToPath(new URL('./router-cli.js', import.meta.url))
  const nodePath = (async () => {
    // Homebrew's versioned executable can disappear after an upgrade. Prefer its stable link when it is this runtime.
    const actual = await fs.realpath(process.execPath)
    for (const candidate of ['/opt/homebrew/bin/node', '/usr/local/bin/node', '/usr/bin/node']) {
      try {
        if ((await fs.realpath(candidate)) === actual) return candidate
      } catch {
        /* Try the next installed location. */
      }
    }
    return process.execPath
  })()

  app.disable('x-powered-by')
  app.use((request, response, next) => {
    const address = server.address()
    const expectedHost = typeof address === 'object' && address ? `127.0.0.1:${address.port}` : ''
    const expectedOrigin = `http://${expectedHost}`
    response.set({
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'Content-Security-Policy':
        "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    })
    if (
      request.headers.host !== expectedHost ||
      (request.headers.origin && request.headers.origin !== expectedOrigin) ||
      request.headers['sec-fetch-site'] === 'cross-site'
    ) {
      response.status(403).json({ error: 'Open the router from its local dashboard address.' })
      return
    }
    next()
  })

  app.get('/api/session', (_request, response) => {
    response.json({ token })
  })
  app.use('/api', (request, response, next) => {
    const supplied = request.headers['x-router-token']
    if (
      typeof supplied !== 'string' ||
      Buffer.byteLength(supplied) !== Buffer.byteLength(token) ||
      !timingSafeEqual(Buffer.from(supplied), Buffer.from(token))
    ) {
      response.status(403).json({ error: 'Reload the dashboard to start a new local session.' })
      return
    }
    if (request.method !== 'GET' && request.method !== 'DELETE' && !request.is('application/json')) {
      response.status(415).json({ error: 'Use a JSON request.' })
      return
    }
    next()
  })
  app.use(express.json({ limit: '16kb' }))

  const route =
    (handler: (request: Request, response: Response) => Promise<unknown>) => (request: Request, response: Response, next: NextFunction) => {
      // oxlint-disable-next-line promise/no-callback-in-promise -- Express 4 needs rejected routes forwarded to its error middleware.
      void handler(request, response).catch(next)
    }

  app.get(
    '/api/state',
    route(async (_request, response) => {
      const registry = await options.store.read()
      response.json({ ...registry, jobs: jobs.list() })
    }),
  )
  app.post(
    '/api/customers',
    route(async (request, response) => {
      response.status(201).json(await options.store.add(request.body))
    }),
  )
  app.delete(
    '/api/customers/:id',
    route(async (request, response) => {
      const id = String(request.params.id)
      if (jobs.isRunning(id)) throw new UserError('Wait for the connection check to finish.', 409)
      await options.store.remove(id)
      response.json({ ok: true })
    }),
  )
  for (const mode of ['connect', 'check'] as const) {
    app.post(
      `/api/customers/:id/${mode}`,
      route(async (request, response) => {
        response.status(202).json({ jobId: await jobs.start(String(request.params.id), mode) })
      }),
    )
  }

  app.post(
    '/api/projects/preview',
    route(async (request, response) => {
      const { customerId, projectPath } = request.body ?? {}
      if (typeof customerId !== 'string' || typeof projectPath !== 'string') throw new UserError('Choose a customer and project directory.')
      await options.store.customer(customerId)
      let plan: ProjectConfigPlan
      try {
        plan = await planProjectConfig({ projectPath, customerId, home: options.store.home, cliPath, nodePath: await nodePath })
      } catch (error) {
        // Adapter errors are intentionally constructed without parser source excerpts.
        throw new UserError(error instanceof Error ? error.message : 'Could not prepare the project settings.')
      }
      const binding = (await options.store.read()).bindings.find((item) => item.path === plan.projectPath)
      if (binding && binding.customerId !== customerId) throw new UserError('This project is already bound to another customer.', 409)
      for (const [id, entry] of plans) if (entry.expiresAt < Date.now()) plans.delete(id)
      if (plans.size >= 50) throw new UserError('Too many open previews. Wait ten minutes and try again.', 429)
      const planId = randomUUID()
      plans.set(planId, { plan, customerId, expiresAt: Date.now() + 600000 })
      const preview = projectConfigPreview(plan)
      response.json({
        planId,
        projectPath: plan.projectPath,
        files: preview.files.map((file) => ({ path: file.path, content: file.generatedSnippet, changed: file.changed })),
        warnings: plan.warnings,
      })
    }),
  )

  app.post(
    '/api/projects/apply',
    route(async (request, response) => {
      const planId = request.body?.planId
      const prepared = typeof planId === 'string' ? plans.get(planId) : undefined
      if (!prepared || prepared.expiresAt < Date.now())
        throw new UserError('This preview expired. Preview the project settings again.', 409)
      const customer = await options.store.customer(prepared.customerId)
      if (customer.lastCheck?.state !== 'verified' || jobs.isRunning(customer.id)) {
        throw new UserError('Verify this customer connection before applying its project settings.', 409)
      }
      plans.delete(planId)
      try {
        await options.store.bind(
          prepared.plan.projectPath,
          prepared.customerId,
          () => applyProjectConfig(prepared.plan),
          () => rollbackProjectConfig(prepared.plan),
        )
      } catch (error) {
        throw new UserError(error instanceof Error ? error.message : 'Could not apply project settings.', 409)
      }
      response.json({ ok: true, projectPath: prepared.plan.projectPath })
    }),
  )

  app.use('/api', (_request, response) => {
    response.status(404).json({ error: 'Unknown router action.' })
  })
  const webPath = options.webPath ?? fileURLToPath(new URL('../web/dist/', import.meta.url))
  app.use(express.static(webPath, { etag: false, cacheControl: false }))
  app.get('/', (_request, response) => {
    response.status(503).type('text').send('The dashboard is not built. Run pnpm build in the router project, then restart.')
  })
  app.use((error: unknown, _request: Request, response: Response, _next: NextFunction) => {
    if (error instanceof UserError) {
      response.status(error.status).json({ error: error.message })
    } else {
      response.status(500).json({ error: 'The router could not complete this action. Check that its data directory is writable.' })
    }
  })
  server.on('close', () => jobs.close())
  return { server, jobs }
}
