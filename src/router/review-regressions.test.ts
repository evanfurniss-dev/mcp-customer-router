import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { RegistryStore } from './registry'
import { ConnectionJobs } from './jobs'
import { applyProjectConfig, planProjectConfig, rollbackProjectConfig } from './project-config'

const homes: string[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  await Promise.all(homes.splice(0).map((home) => fs.rm(home, { recursive: true, force: true })))
})

async function fixture() {
  const home = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'router-review-')))
  homes.push(home)
  vi.stubEnv('CLAUDE_CONFIG_DIR', path.join(home, 'claude'))
  vi.stubEnv('CODEX_HOME', path.join(home, 'codex'))
  return { home, store: new RegistryStore(path.join(home, 'state')) }
}

describe('review regressions', () => {
  it('enforces the four-job cap when different customer reads finish together', async () => {
    const { store } = await fixture()
    const customers = []
    for (let index = 0; index < 5; index++) {
      customers.push(await store.add({ name: `Customer ${index}`, business: 'Test', expectedOrgId: `org-${index}` }))
    }
    let release!: () => void
    const ready = new Promise<void>((resolve) => {
      release = resolve
    })
    let arrived = 0
    const readCustomer = store.customer.bind(store)
    vi.spyOn(store, 'customer').mockImplementation(async (id) => {
      const customer = await readCustomer(id)
      arrived++
      if (arrived === 5) release()
      await ready
      return customer
    })
    const jobs = new ConnectionJobs(
      store,
      (_customer, _mode, _authDir, signal) =>
        new Promise((resolve) => {
          signal.addEventListener(
            'abort',
            () => resolve({ state: 'error', checkedAt: new Date().toISOString(), message: 'Stopped test.' }),
            { once: true },
          )
        }),
    )
    try {
      const starts = await Promise.allSettled(customers.map((customer) => jobs.start(customer.id, 'check')))
      expect(starts.filter((result) => result.status === 'fulfilled')).toHaveLength(4)
      expect(jobs.list().filter((job) => job.state === 'running')).toHaveLength(4)
    } finally {
      jobs.close()
      await vi.waitFor(() => expect(jobs.list().every((job) => job.state !== 'running')).toBe(true))
    }
  })

  it('restores actual client files when saving the registry fails after their update', async () => {
    const { home, store } = await fixture()
    const customer = await store.add({ name: 'Customer', business: 'Test', expectedOrgId: 'org-a' })
    await store.recordCheck(customer.id, {
      state: 'verified',
      checkedAt: new Date().toISOString(),
      observedOrgId: customer.expectedOrgId,
      message: 'Verified.',
    })
    const projectPath = path.join(home, 'project')
    await fs.mkdir(path.join(projectPath, '.codex'), { recursive: true })
    await fs.writeFile(path.join(projectPath, '.mcp.json'), '{}\n')
    await fs.writeFile(path.join(projectPath, '.codex', 'config.toml'), '# original\n')
    const plan = await planProjectConfig({
      projectPath,
      customerId: customer.id,
      home: store.home,
      cliPath: '/fixture/router-cli.js',
      nodePath: process.execPath,
    })
    const originalRename = fs.rename.bind(fs)
    vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
      if (to === path.join(store.home, 'registry.json')) throw Object.assign(new Error('Simulated disk failure'), { code: 'EIO' })
      return originalRename(from, to)
    })
    await expect(
      store.bind(
        projectPath,
        customer.id,
        () => applyProjectConfig(plan),
        () => rollbackProjectConfig(plan),
      ),
    ).rejects.toThrow('Simulated disk failure')
    expect((await store.read()).bindings).toEqual([])
    expect(await fs.readFile(plan.files[0].path, 'utf8')).toBe(plan.files[0].before)
    expect(await fs.readFile(plan.files[1].path, 'utf8')).toBe(plan.files[1].before)
  })
})
