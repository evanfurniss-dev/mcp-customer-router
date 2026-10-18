import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { z } from 'zod'
import { UserError, type ConnectionCheck, type Customer, type Registry } from './types'

const checkSchema = z.object({
  state: z.enum(['verified', 'error', 'mismatch', 'unverified']),
  checkedAt: z.string(),
  observedOrgId: z.string().optional(),
  message: z.string().max(500),
})
const customerInputSchema = z.object({
  name: z.string().trim().min(1).max(100),
  business: z.string().trim().min(1).max(100),
  serverUrl: z.string().url().default('https://mcp.glideapps.dev/mcp'),
  expectedOrgId: z
    .string()
    .trim()
    .regex(/^[a-zA-Z0-9_-]{1,128}$/),
})
const customerSchema = customerInputSchema.extend({
  id: z.string().uuid(),
  callbackPort: z.number().int().min(1024).max(65535),
  createdAt: z.string(),
  updatedAt: z.string(),
  lastCheck: checkSchema.optional(),
})
const registrySchema = z.object({
  version: z.literal(1),
  customers: z.array(customerSchema),
  bindings: z.array(z.object({ path: z.string(), customerId: z.string().uuid(), createdAt: z.string() })),
})

export function defaultHome(): string {
  return path.resolve(process.env.CUSTOMER_ROUTER_HOME || path.join(os.homedir(), '.mcp-customer-router'))
}

async function rejectSymlink(file: string): Promise<void> {
  try {
    if ((await fs.lstat(file)).isSymbolicLink()) throw new UserError('Router data must not use symbolic links.')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
}

async function privateDirectory(directory: string): Promise<void> {
  await rejectSymlink(directory)
  await fs.mkdir(directory, { recursive: true, mode: 0o700 })
  await fs.chmod(directory, 0o700)
}

async function atomicJson(file: string, data: unknown): Promise<void> {
  await rejectSymlink(file)
  const temporary = `${file}.${randomUUID()}.tmp`
  try {
    await fs.writeFile(temporary, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600, flag: 'wx' })
    await fs.rename(temporary, file)
  } finally {
    await fs.rm(temporary, { force: true })
  }
}

export class RegistryStore {
  readonly home: string
  constructor(home = defaultHome()) {
    this.home = path.resolve(home)
  }

  async read(): Promise<Registry> {
    await privateDirectory(this.home)
    const file = path.join(this.home, 'registry.json')
    await rejectSymlink(file)
    try {
      const parsed = registrySchema.safeParse(JSON.parse(await fs.readFile(file, 'utf8')))
      if (!parsed.success) throw new UserError('The customer registry is invalid. Restore its backup before continuing.', 409)
      const registry = parsed.data
      if (
        new Set(registry.customers.map((customer) => customer.id)).size !== registry.customers.length ||
        new Set(registry.customers.map((customer) => customer.callbackPort)).size !== registry.customers.length ||
        new Set(registry.bindings.map((binding) => binding.path)).size !== registry.bindings.length ||
        registry.bindings.some((binding) => !registry.customers.some((customer) => customer.id === binding.customerId))
      ) {
        throw new UserError('The customer registry has conflicting records. Restore its backup before continuing.', 409)
      }
      return registry
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, customers: [], bindings: [] }
      if (error instanceof SyntaxError) throw new UserError('The customer registry is invalid JSON. Restore its backup.', 409)
      throw error
    }
  }

  private async update<T>(operation: (registry: Registry) => Promise<T> | T): Promise<T> {
    await privateDirectory(this.home)
    const lock = path.join(this.home, 'registry.lock')
    let handle: Awaited<ReturnType<typeof fs.open>> | undefined
    for (let attempt = 0; attempt < 30; attempt++) {
      await rejectSymlink(lock)
      try {
        handle = await fs.open(lock, 'wx', 0o600)
        await handle.writeFile(JSON.stringify({ pid: process.pid }))
        break
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
        // A dead owner's lock can survive a crash. Empty/new locks may still be opening.
        try {
          const stat = await fs.stat(lock)
          if (Date.now() - stat.mtimeMs > 2000) {
            const owner = JSON.parse(await fs.readFile(lock, 'utf8')) as { pid: number }
            if (Number.isSafeInteger(owner.pid) && owner.pid > 0) {
              try {
                process.kill(owner.pid, 0)
              } catch (probe) {
                if ((probe as NodeJS.ErrnoException).code === 'ESRCH') {
                  const current = await fs.stat(lock)
                  if (current.ino === stat.ino && current.dev === stat.dev) await fs.unlink(lock)
                }
              }
            }
          }
        } catch {
          // Another writer can release or replace the lock while we inspect it.
        }
        await delay(50)
      }
    }
    if (!handle) throw new UserError('Another router process is saving changes. Try again.', 409)
    try {
      const registry = await this.read()
      const result = await operation(registry)
      try {
        const previous = JSON.parse(await fs.readFile(path.join(this.home, 'registry.json'), 'utf8'))
        await atomicJson(path.join(this.home, 'registry.backup.json'), previous)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
      await atomicJson(path.join(this.home, 'registry.json'), registry)
      return result
    } finally {
      await handle.close()
      await fs.rm(lock, { force: true })
    }
  }

  async customer(id: string): Promise<Customer> {
    const customer = (await this.read()).customers.find((item) => item.id === id)
    if (!customer) throw new UserError('Customer not found.', 404)
    return customer
  }

  authDir(id: string): string {
    if (!z.string().uuid().safeParse(id).success) throw new UserError('Invalid customer ID.')
    return path.join(this.home, 'customers', id, 'auth')
  }

  async add(input: unknown): Promise<Customer> {
    const parsed = customerInputSchema.safeParse(input)
    if (!parsed.success) throw new UserError('Enter a customer name, business, valid organization ID, and MCP URL.')
    const url = new URL(parsed.data.serverUrl)
    const isLocalFixture = url.protocol === 'http:' && url.hostname === '127.0.0.1' && url.pathname === '/mcp'
    if (url.username || url.password || url.hash || url.search || (url.href !== 'https://mcp.glideapps.dev/mcp' && !isLocalFixture)) {
      throw new UserError('This MVP supports https://mcp.glideapps.dev/mcp. Loopback MCP URLs are reserved for local tests.')
    }
    return this.update(async (registry) => {
      if (registry.customers.some((item) => item.serverUrl === url.href && item.expectedOrgId === parsed.data.expectedOrgId)) {
        throw new UserError('This Glide organization already has a saved customer connection.', 409)
      }
      const usedPorts = new Set(registry.customers.map((item) => item.callbackPort))
      let callbackPort = 18200
      while (usedPorts.has(callbackPort)) callbackPort++
      if (callbackPort > 18999) throw new UserError('The router has reached its customer limit.')
      const timestamp = new Date().toISOString()
      const customer: Customer = {
        ...parsed.data,
        serverUrl: url.href,
        id: randomUUID(),
        callbackPort,
        createdAt: timestamp,
        updatedAt: timestamp,
      }
      for (const directory of [path.join(this.home, 'customers'), path.dirname(this.authDir(customer.id)), this.authDir(customer.id)]) {
        await privateDirectory(directory)
      }
      await this.rotateGeneration(customer.id)
      registry.customers.push(customer)
      return customer
    })
  }

  async rotateGeneration(id: string): Promise<void> {
    const directory = this.authDir(id)
    await privateDirectory(directory)
    const marker = path.join(directory, 'router-generation')
    await rejectSymlink(marker)
    const temporary = `${marker}.${randomUUID()}.tmp`
    await fs.writeFile(temporary, `${randomUUID()}\n`, { mode: 0o600, flag: 'wx' })
    await fs.rename(temporary, marker)
  }

  async generation(id: string): Promise<string> {
    const file = path.join(this.authDir(id), 'router-generation')
    await rejectSymlink(file)
    const generation = (await fs.readFile(file, 'utf8')).trim()
    if (!z.string().uuid().safeParse(generation).success) throw new UserError('The customer sign-in marker is invalid.')
    return generation
  }

  async beginConnect(id: string): Promise<string> {
    return this.update(async (registry) => {
      const customer = registry.customers.find((item) => item.id === id)
      if (!customer) throw new UserError('Customer not found.', 404)
      await this.rotateGeneration(id)
      customer.lastCheck = { state: 'unverified', checkedAt: new Date().toISOString(), message: 'Sign-in is in progress.' }
      customer.updatedAt = new Date().toISOString()
      return this.generation(id)
    })
  }

  async recordCheck(id: string, check: ConnectionCheck, expectedGeneration?: string): Promise<void> {
    const parsed = checkSchema.safeParse(check)
    if (!parsed.success) throw new UserError('The connection check returned an invalid result.')
    await this.update(async (registry) => {
      const customer = registry.customers.find((item) => item.id === id)
      if (!customer) throw new UserError('Customer not found.', 404)
      if (expectedGeneration && (await this.generation(id)) !== expectedGeneration) {
        throw new UserError('The customer sign-in changed during this check. Check the connection again.', 409)
      }
      if (parsed.data.state === 'verified' && parsed.data.observedOrgId !== customer.expectedOrgId) {
        throw new UserError('The check did not confirm the expected organization.')
      }
      customer.lastCheck = parsed.data
      customer.updatedAt = new Date().toISOString()
    })
  }

  async bind(
    projectPath: string,
    customerId: string,
    writeConfig: () => Promise<unknown>,
    rollbackConfig?: () => Promise<unknown>,
  ): Promise<void> {
    const canonical = await fs.realpath(projectPath)
    if (!(await fs.stat(canonical)).isDirectory()) throw new UserError('Select an existing project directory.')
    let written = false
    try {
      await this.update(async (registry) => {
        const customer = registry.customers.find((item) => item.id === customerId)
        if (!customer) throw new UserError('Customer not found.', 404)
        if (customer.lastCheck?.state !== 'verified') throw new UserError('Verify this customer connection before binding a project.', 409)
        const existing = registry.bindings.find((item) => item.path === canonical)
        if (existing && existing.customerId !== customerId) throw new UserError('This project is already bound to another customer.', 409)
        if (
          registry.bindings.some(
            (item) =>
              item.customerId !== customerId &&
              (canonical.startsWith(`${item.path}${path.sep}`) || item.path.startsWith(`${canonical}${path.sep}`)),
          )
        ) {
          throw new UserError('Customer project directories must not overlap.', 409)
        }
        await writeConfig()
        written = true
        if (!existing) registry.bindings.push({ path: canonical, customerId, createdAt: new Date().toISOString() })
      })
    } catch (error) {
      if (written && rollbackConfig) {
        try {
          await rollbackConfig()
        } catch {
          throw new UserError(
            'The registry save failed and project files changed during recovery. Review their backups before trying again.',
            409,
          )
        }
      }
      throw error
    }
  }

  async requireBinding(customerId: string, projectPath: string): Promise<Customer> {
    const canonical = await fs.realpath(projectPath)
    const registry = await this.read()
    if (!registry.bindings.some((binding) => binding.customerId === customerId && binding.path === canonical)) {
      throw new UserError('This project is not bound to this customer. Bind it in Customer MCP Router first.', 403)
    }
    const customer = registry.customers.find((item) => item.id === customerId)
    if (!customer) throw new UserError('Customer not found.', 404)
    return customer
  }

  async remove(id: string): Promise<void> {
    await this.update(async (registry) => {
      if (!registry.customers.some((item) => item.id === id)) throw new UserError('Customer not found.', 404)
      if (registry.bindings.some((binding) => binding.customerId === id)) {
        throw new UserError('This customer has bound projects. Keep its connection until those projects are moved.', 409)
      }
      await this.rotateGeneration(id)
      registry.customers = registry.customers.filter((item) => item.id !== id)
      // Keep the protected store for recovery. No external access grant is revoked here.
    })
  }
}
