import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import { RegistryStore } from './registry'

const temporary: string[] = []
async function fixture() {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'router-registry-'))
  temporary.push(home)
  return new RegistryStore(home)
}
const customer = (org: string) => ({ name: `Customer ${org}`, business: 'Test business', expectedOrgId: org })
afterEach(async () => {
  await Promise.all(temporary.splice(0).map((home) => fs.rm(home, { recursive: true, force: true })))
})

describe('customer registry', () => {
  it('keeps same-URL customer stores and callback ports separate with private permissions', async () => {
    const store = await fixture()
    const [a, b] = await Promise.all([store.add(customer('org-a')), store.add(customer('org-b'))])
    expect(a.serverUrl).toBe(b.serverUrl)
    expect(store.authDir(a.id)).not.toBe(store.authDir(b.id))
    expect(a.callbackPort).not.toBe(b.callbackPort)
    expect((await store.read()).customers).toHaveLength(2)
    expect((await fs.stat(path.join(store.home, 'registry.json'))).mode & 0o777).toBe(0o600)
    expect((await fs.stat(store.authDir(a.id))).mode & 0o777).toBe(0o700)
    expect(await fs.readFile(path.join(store.authDir(a.id), 'router-generation'), 'utf8')).not.toBe(
      await fs.readFile(path.join(store.authDir(b.id), 'router-generation'), 'utf8'),
    )
  })

  it('rejects duplicate orgs, unsupported endpoints, credentials in URLs, and path-like IDs', async () => {
    const store = await fixture()
    await store.add(customer('org-a'))
    await expect(store.add(customer('org-a'))).rejects.toThrow('already')
    for (const serverUrl of [
      'https://evil.invalid/mcp',
      'https://secret@mcp.glideapps.dev/mcp',
      'https://mcp.glideapps.dev/mcp?org=org-a',
    ]) {
      await expect(store.add({ ...customer('org-b'), serverUrl })).rejects.toThrow('MVP supports')
    }
    await expect(store.add(customer('../../elsewhere'))).rejects.toThrow('valid organization')
    expect(() => store.authDir('../../elsewhere')).toThrow('Invalid customer')
  })

  it('requires verified identity and preserves project ownership through nested paths', async () => {
    const store = await fixture()
    const a = await store.add(customer('org-a'))
    const b = await store.add(customer('org-b'))
    const project = path.join(store.home, 'project')
    await fs.mkdir(path.join(project, 'nested'), { recursive: true })
    await expect(store.bind(project, a.id, async () => {})).rejects.toThrow('Verify')
    await expect(
      store.recordCheck(a.id, { state: 'verified', checkedAt: new Date().toISOString(), observedOrgId: 'org-b', message: 'ready' }),
    ).rejects.toThrow('expected organization')
    for (const item of [a, b])
      await store.recordCheck(item.id, {
        state: 'verified',
        checkedAt: new Date().toISOString(),
        observedOrgId: item.expectedOrgId,
        message: 'ready',
      })
    await store.bind(project, a.id, async () => {})
    await expect(store.requireBinding(a.id, project)).resolves.toMatchObject({ id: a.id })
    await expect(store.requireBinding(b.id, project)).rejects.toThrow('not bound')
    await expect(store.bind(project, b.id, async () => {})).rejects.toThrow('already bound')
    await expect(store.bind(path.join(project, 'nested'), b.id, async () => {})).rejects.toThrow('overlap')
    await expect(store.remove(a.id)).rejects.toThrow('bound projects')
  })

  it('does not save a binding when writing project settings fails', async () => {
    const store = await fixture()
    const a = await store.add(customer('org-a'))
    await store.recordCheck(a.id, {
      state: 'verified',
      checkedAt: new Date().toISOString(),
      observedOrgId: a.expectedOrgId,
      message: 'ready',
    })
    await expect(
      store.bind(store.home, a.id, async () => {
        throw new Error('disk full')
      }),
    ).rejects.toThrow('disk full')
    expect((await store.read()).bindings).toEqual([])
  })

  it('rotates only the selected generation and never silently resets a corrupt registry', async () => {
    const store = await fixture()
    const a = await store.add(customer('org-a'))
    const b = await store.add(customer('org-b'))
    const marker = (id: string) => fs.readFile(path.join(store.authDir(id), 'router-generation'), 'utf8')
    const beforeA = await marker(a.id)
    const beforeB = await marker(b.id)
    await store.rotateGeneration(a.id)
    expect(await marker(a.id)).not.toBe(beforeA)
    expect(await marker(b.id)).toBe(beforeB)
    await fs.writeFile(path.join(store.home, 'registry.json'), '{broken')
    await expect(store.read()).rejects.toThrow('invalid JSON')
    await expect(store.add(customer('org-c'))).rejects.toThrow('invalid JSON')
  })

  it('refuses a registry symlink without touching the target', async () => {
    const store = await fixture()
    const target = path.join(store.home, 'target')
    await fs.writeFile(target, 'do not change')
    await fs.symlink(target, path.join(store.home, 'registry.json'))
    await expect(store.add(customer('org-a'))).rejects.toThrow('symbolic links')
    expect(await fs.readFile(target, 'utf8')).toBe('do not change')
  })

  it('discards a late result from an older login after reconnect starts', async () => {
    const store = await fixture()
    const a = await store.add(customer('org-a'))
    const oldGeneration = await store.generation(a.id)
    const nextGeneration = await store.beginConnect(a.id)
    expect(nextGeneration).not.toBe(oldGeneration)
    const verified = { state: 'verified' as const, observedOrgId: 'org-a', checkedAt: new Date().toISOString(), message: 'Verified.' }
    await expect(store.recordCheck(a.id, verified, oldGeneration)).rejects.toThrow('sign-in changed')
    expect((await store.customer(a.id)).lastCheck?.state).toBe('unverified')
    await store.recordCheck(a.id, verified, nextGeneration)
    expect((await store.customer(a.id)).lastCheck?.state).toBe('verified')
  })
})
