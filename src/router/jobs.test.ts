import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ConnectionJobs } from './jobs'
import { RegistryStore } from './registry'
import type { ConnectionCheck } from './types'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup()
  vi.restoreAllMocks()
})

async function pending(mode: 'connect' | 'check' = 'connect') {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'router-sign-in-'))
  const store = new RegistryStore(home)
  const customer = await store.add({ name: 'Fixture', business: 'Test', expectedOrgId: 'fixture-org' })
  let ready!: (url: string) => Promise<void>
  let finish!: (check: ConnectionCheck) => void
  const jobs = new ConnectionJobs(store, (_customer, _mode, _directory, signal, onReady) => {
    ready = onReady!
    return new Promise((resolve) => {
      finish = resolve
      signal.addEventListener('abort', () => resolve({ state: 'error', checkedAt: new Date().toISOString(), message: 'Stopped.' }), {
        once: true,
      })
    })
  })
  const jobId = await jobs.start(customer.id, mode)
  const url = new URL('https://mcp.glideapps.dev/authorize')
  url.search = new URLSearchParams({
    client_id: 'fixture-client',
    response_type: 'code',
    state: 'fixture-state',
    code_challenge: 'fixture-challenge',
    code_challenge_method: 'S256',
    redirect_uri: `http://localhost:${customer.callbackPort}/oauth/callback`,
  }).toString()
  cleanups.push(async () => {
    jobs.close()
    await vi.waitFor(() => expect(jobs.list().every((job) => !!job.finishedAt)).toBe(true))
    await fs.rm(home, { recursive: true, force: true })
  })
  return { home, store, customer, jobs, ready, finish, url, jobId }
}

describe('dashboard sign-in handoff', () => {
  it('publishes a ready link only in active job memory and removes it when sign-in completes', async () => {
    const { home, jobs, ready, finish, url } = await pending()
    expect((await jobs.snapshot())[0]).toMatchObject({ message: 'Preparing Glide sign-in…' })
    expect((await jobs.snapshot())[0].authorizationUrl).toBeUndefined()
    await ready(url.href)
    expect((await jobs.snapshot())[0].authorizationUrl).toBe(url.href)
    expect(await fs.readFile(path.join(home, 'registry.json'), 'utf8')).not.toContain('fixture-state')
    finish({ state: 'verified', checkedAt: new Date().toISOString(), observedOrgId: 'fixture-org', message: 'Verified.' })
    await vi.waitFor(() => expect(jobs.list()[0].state).toBe('complete'))
    expect((await jobs.snapshot())[0].authorizationUrl).toBeUndefined()
    await ready(url.href)
    expect((await jobs.snapshot())[0].authorizationUrl).toBeUndefined()
  })

  it.each(['host', 'callback', 'token', 'duplicate'])('rejects an invalid %s handoff', async (variant) => {
    const { jobs, ready, url } = await pending()
    if (variant === 'host') url.hostname = 'evil.invalid'
    if (variant === 'callback') url.searchParams.set('redirect_uri', 'http://localhost:18999/oauth/callback')
    if (variant === 'token') url.searchParams.set('access_token', 'must-not-reach-browser')
    if (variant === 'duplicate') url.searchParams.append('redirect_uri', 'https://evil.invalid')
    await ready(url.href)
    expect((await jobs.snapshot())[0].authorizationUrl).toBeUndefined()
  })

  it('removes the old link when another sign-in changes the generation', async () => {
    const { store, customer, jobs, ready, url } = await pending()
    await ready(url.href)
    expect((await jobs.snapshot())[0].authorizationUrl).toBeDefined()
    await store.beginConnect(customer.id)
    expect((await jobs.snapshot())[0].authorizationUrl).toBeUndefined()
    await ready(url.href)
    expect((await jobs.snapshot())[0].authorizationUrl).toBeUndefined()
  })

  it('clears the link immediately on cancellation', async () => {
    const { jobs, ready, url } = await pending()
    await ready(url.href)
    jobs.close()
    expect(jobs.list()[0].authorizationUrl).toBeUndefined()
    await ready(url.href)
    expect((await jobs.snapshot())[0].authorizationUrl).toBeUndefined()
  })

  it('cannot restore a link after the child finishes while saving its result', async () => {
    const { store, jobs, ready, finish, url } = await pending()
    let releaseGeneration!: () => void
    const generationGate = new Promise<void>((resolve) => {
      releaseGeneration = resolve
    })
    let releaseSave!: () => void
    const saveGate = new Promise<void>((resolve) => {
      releaseSave = resolve
    })
    const generation = store.generation.bind(store)
    vi.spyOn(store, 'generation').mockImplementationOnce(async (id) => {
      await generationGate
      return generation(id)
    })
    const saving = vi.spyOn(store, 'recordCheck').mockImplementation(async () => saveGate)
    const lateHandoff = ready(url.href)
    try {
      finish({ state: 'verified', checkedAt: new Date().toISOString(), observedOrgId: 'fixture-org', message: 'Verified.' })
      await vi.waitFor(() => expect(saving).toHaveBeenCalled())
      releaseGeneration()
      await lateHandoff
      expect(jobs.list()[0].authorizationUrl).toBeUndefined()
    } finally {
      releaseGeneration()
      releaseSave()
    }
    await vi.waitFor(() => expect(jobs.list()[0].state).toBe('complete'))
    expect(jobs.list()[0].authorizationUrl).toBeUndefined()
  })

  it('cannot publish interactive sign-in from a check job', async () => {
    const { jobs, ready, url } = await pending('check')
    await ready(url.href)
    expect((await jobs.snapshot())[0].authorizationUrl).toBeUndefined()
  })
})
