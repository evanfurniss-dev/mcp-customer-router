import { execFile } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { RouterService } from './service'

const exec = promisify(execFile)
const homes: string[] = []
const target = 'gui/501/dev.evanfurniss.mcp-customer-router'

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'router-service-'))
  homes.push(root)
  const userHome = path.join(root, "User's & home")
  const dataHome = path.join(root, "Customer's & data")
  const cliPath = path.join(root, "Router's & install", 'dist/router-cli.js')
  const nodePath = path.join(root, "Node's & executable")
  await fs.mkdir(path.dirname(cliPath), { recursive: true })
  await fs.mkdir(path.resolve(path.dirname(cliPath), '../web/dist'), { recursive: true })
  await fs.writeFile(cliPath, 'process.stdout.write(JSON.stringify(process.argv.slice(2)))\n')
  await fs.writeFile(path.resolve(path.dirname(cliPath), '../web/dist/index.html'), '<!doctype html><title>Fixture</title>')
  await fs.symlink(process.execPath, nodePath)
  let loaded = false
  const control = vi.fn(async (args: string[]) => {
    if (args[0] === 'print' && !loaded) throw new Error('Service is not loaded')
    if (args[0] === 'bootstrap') loaded = true
    if (args[0] === 'bootout') loaded = false
    return ''
  })
  const checkPort = vi.fn(async (_port: number) => {})
  const checkReady = vi.fn(async (_port: number) => true)
  const options = { userHome, dataHome, cliPath, nodePath, uid: 501, launchctl: control, checkPort, checkReady }
  const service = new RouterService(options)
  return { root, userHome, dataHome, cliPath, nodePath, control, checkPort, checkReady, options, service }
}

afterEach(async () => {
  await Promise.all(homes.splice(0).map((home) => fs.rm(home, { recursive: true, force: true })))
})

describe('per-user dashboard service', () => {
  it.skipIf(process.platform !== 'darwin')('installs valid literal plist arguments and a quoted shortcut with private files', async () => {
    const f = await fixture()
    await f.service.install()
    const { stdout } = await exec('/usr/bin/plutil', ['-convert', 'json', '-o', '-', f.service.plist])
    const plist = JSON.parse(stdout)
    expect(plist.Label).toBe('dev.evanfurniss.mcp-customer-router')
    expect(plist.ProgramArguments).toEqual([f.nodePath, f.cliPath, 'dashboard', '--home', f.dataHome, '--port', '4773'])
    expect(plist.WorkingDirectory).toBe(f.dataHome)
    expect(plist.EnvironmentVariables.HOME).toBe(f.userHome)
    expect(plist.KeepAlive).toBe(true)
    expect(plist.Umask).toBe(0o077)
    expect(plist.ExitTimeOut).toBeGreaterThan(0)
    const literalArgs = ['list', '--name', "literal & apostrophe's $HOME `whoami`"]
    expect(JSON.parse((await exec(f.service.shortcut, literalArgs)).stdout)).toEqual(literalArgs)
    expect((await fs.stat(f.service.plist)).mode & 0o777).toBe(0o600)
    expect((await fs.stat(f.service.shortcut)).mode & 0o777).toBe(0o700)
    expect((await fs.stat(path.join(f.dataHome, 'logs'))).mode & 0o777).toBe(0o700)
    for (const name of ['dashboard.log', 'dashboard-error.log']) {
      expect((await fs.stat(path.join(f.dataHome, 'logs', name))).mode & 0o777).toBe(0o600)
    }
    expect(f.control.mock.calls.map(([args]) => args[0])).toEqual(['print', 'print', 'enable', 'bootstrap', 'kickstart'])
    expect(f.checkReady).toHaveBeenCalledWith(4773)
  })

  it('reinstalls the same service without unloading it or changing its plist', async () => {
    const f = await fixture()
    await f.service.install()
    const before = await fs.stat(f.service.plist)
    const contents = await fs.readFile(f.service.plist, 'utf8')
    await fs.chmod(f.service.plist, 0o644)
    f.control.mockClear()
    f.checkPort.mockClear()
    await f.service.install()
    expect(await fs.readFile(f.service.plist, 'utf8')).toBe(contents)
    expect((await fs.stat(f.service.plist)).ino).toBe(before.ino)
    expect((await fs.stat(f.service.plist)).mode & 0o777).toBe(0o600)
    expect(f.control.mock.calls.map(([args]) => args[0])).toEqual(['print', 'print', 'enable', 'kickstart'])
    expect(f.checkPort).not.toHaveBeenCalled()
  })

  it('disables before unloading, then enables before loading on start', async () => {
    const f = await fixture()
    await f.service.install()
    f.control.mockClear()
    await f.service.stop()
    expect(f.control.mock.calls.map(([args]) => args)).toEqual([
      ['disable', target],
      ['print', target],
      ['bootout', target],
      ['print', target],
    ])
    f.control.mockClear()
    f.checkPort.mockClear()
    await f.service.start()
    expect(f.control.mock.calls.map(([args]) => args)).toEqual([
      ['print', target],
      ['enable', target],
      ['bootstrap', 'gui/501', f.service.plist],
      ['kickstart', target],
    ])
    expect(f.checkPort).toHaveBeenCalledExactlyOnceWith(4773)
  })

  it('restarts only its exact service and checks readiness after the new start', async () => {
    const f = await fixture()
    await f.service.install()
    f.control.mockClear()
    f.checkReady.mockClear()
    await f.service.restart()
    expect(f.control.mock.calls.map(([args]) => args)).toEqual([
      ['disable', target],
      ['print', target],
      ['bootout', target],
      ['print', target],
      ['print', target],
      ['enable', target],
      ['bootstrap', 'gui/501', f.service.plist],
      ['kickstart', target],
    ])
    expect(f.checkReady).toHaveBeenCalledExactlyOnceWith(4773)
  })

  it('waits for delayed launchd removal before enabling and starting the service again', async () => {
    const f = await fixture()
    await f.service.install()
    const run = f.control.getMockImplementation()!
    let removing = false
    let removalPrints = 0
    let confirmRemoval!: () => void
    let reachedRemovalCheck!: () => void
    const removalAllowed = new Promise<void>((resolve) => {
      confirmRemoval = resolve
    })
    const removalCheck = new Promise<void>((resolve) => {
      reachedRemovalCheck = resolve
    })
    f.control.mockClear()
    f.control.mockImplementation(async (args) => {
      if (args[0] === 'bootout') {
        removing = true
        return ''
      }
      if (args[0] === 'print' && removing) {
        removalPrints++
        if (removalPrints === 1) return ''
        reachedRemovalCheck()
        await removalAllowed
        removing = false
        await run(['bootout', target])
        throw new Error('Service removal is complete')
      }
      if (removing && ['enable', 'bootstrap', 'kickstart'].includes(args[0])) {
        throw new Error('Tried to start before removal completed')
      }
      return run(args)
    })
    const restarted = f.service.restart()
    try {
      await removalCheck
      expect(f.control.mock.calls.map(([args]) => args[0])).toEqual(['disable', 'print', 'bootout', 'print', 'print'])
      expect(f.checkPort).toHaveBeenCalledTimes(2)
    } finally {
      confirmRemoval()
      await restarted
    }
    expect(f.control.mock.calls.map(([args]) => args[0])).toEqual([
      'disable',
      'print',
      'bootout',
      'print',
      'print',
      'print',
      'enable',
      'bootstrap',
      'kickstart',
    ])
    expect(removalPrints).toBe(2)
  })

  it('refuses an occupied port before creating service files or controlling a process', async () => {
    const f = await fixture()
    await fs.mkdir(f.dataHome)
    const registry = path.join(f.dataHome, 'registry.json')
    await fs.writeFile(registry, 'existing customer data')
    f.checkPort.mockRejectedValue(new Error('Port is occupied'))
    await expect(f.service.install()).rejects.toThrow('Port is occupied')
    expect(await fs.readFile(registry, 'utf8')).toBe('existing customer data')
    expect(await fs.readdir(f.dataHome)).toEqual(['registry.json'])
    await expect(fs.stat(f.service.plist)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(fs.stat(f.service.shortcut)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(f.control.mock.calls.map(([args]) => args[0])).toEqual(['print'])
  })

  it('does not enable a stopped service when another process occupies its port', async () => {
    const f = await fixture()
    await f.service.install()
    await f.service.stop()
    const plist = await fs.readFile(f.service.plist, 'utf8')
    const shortcut = await fs.readFile(f.service.shortcut, 'utf8')
    f.control.mockClear()
    f.checkPort.mockRejectedValue(new Error('Port is occupied'))
    await expect(f.service.start()).rejects.toThrow('Port is occupied')
    expect(await fs.readFile(f.service.plist, 'utf8')).toBe(plist)
    expect(await fs.readFile(f.service.shortcut, 'utf8')).toBe(shortcut)
    expect(f.control.mock.calls.map(([args]) => args[0])).toEqual(['print'])
  })

  it.each([
    ['plist', 'unrelated plist'],
    ['plist', ''],
    ['shortcut', 'unrelated command'],
    ['shortcut', ''],
  ] as const)('preserves an unowned %s file, including empty files (%j)', async (kind, contents) => {
    const f = await fixture()
    const file = f.service[kind]
    await fs.mkdir(path.dirname(file), { recursive: true })
    await fs.writeFile(file, contents)
    await expect(f.service.install()).rejects.toThrow(kind === 'plist' ? 'another program' : 'different command')
    expect(await fs.readFile(file, 'utf8')).toBe(contents)
    expect(f.control).not.toHaveBeenCalled()
  })

  it.each(['plist', 'shortcut'] as const)('refuses a symbolic link at the %s path', async (kind) => {
    const f = await fixture()
    const outside = path.join(f.root, 'untouched-file')
    await fs.writeFile(outside, 'keep this content')
    await fs.mkdir(path.dirname(f.service[kind]), { recursive: true })
    await fs.symlink(outside, f.service[kind])
    await expect(f.service.install()).rejects.toThrow('regular file')
    expect(await fs.readFile(outside, 'utf8')).toBe('keep this content')
    expect((await fs.lstat(f.service[kind])).isSymbolicLink()).toBe(true)
    expect(f.control).not.toHaveBeenCalled()
  })

  it.each(['dataHome', 'port'] as const)('refuses to control an installation with a different %s', async (setting) => {
    const f = await fixture()
    await f.service.install()
    f.control.mockClear()
    const other = new RouterService({
      ...f.options,
      ...(setting === 'dataHome' ? { dataHome: path.join(f.root, 'another-registry') } : { port: 4774 }),
    })
    for (const action of ['install', 'start', 'stop', 'restart', 'uninstall', 'status'] as const) {
      await expect(other[action]()).rejects.toThrow('different data directory or port')
    }
    expect(f.control).not.toHaveBeenCalled()
    expect(await fs.readFile(f.service.plist, 'utf8')).toContain('4773')
  })

  it('refuses a loaded service with no owned plist', async () => {
    const f = await fixture()
    f.control.mockResolvedValue('')
    await expect(f.service.install()).rejects.toThrow('different service')
    expect(f.control.mock.calls.map(([args]) => args[0])).toEqual(['print'])
    await expect(fs.stat(f.service.plist)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('uninstalls only its service files and keeps saved customer data and logs', async () => {
    const f = await fixture()
    await f.service.install()
    const registry = path.join(f.dataHome, 'registry.json')
    const customerFile = path.join(f.dataHome, 'customers', 'fixture', 'saved.json')
    await fs.mkdir(path.dirname(customerFile), { recursive: true })
    await fs.writeFile(registry, 'saved registry')
    await fs.writeFile(customerFile, 'synthetic saved connection')
    f.control.mockClear()
    await f.service.uninstall()
    expect(await fs.readFile(registry, 'utf8')).toBe('saved registry')
    expect(await fs.readFile(customerFile, 'utf8')).toBe('synthetic saved connection')
    expect((await fs.stat(path.join(f.dataHome, 'logs/dashboard.log'))).isFile()).toBe(true)
    await expect(fs.stat(f.service.plist)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(fs.stat(f.service.shortcut)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(f.control.mock.calls.map(([args]) => args[0])).toEqual(['disable', 'print', 'bootout', 'print'])
  })

  it('preserves a replacement command during uninstall', async () => {
    const f = await fixture()
    await f.service.install()
    await fs.writeFile(f.service.shortcut, 'a different command')
    await f.service.uninstall()
    expect(await fs.readFile(f.service.shortcut, 'utf8')).toBe('a different command')
  })

  it('reports health independently from whether launchd has loaded the service', async () => {
    const f = await fixture()
    expect(await f.service.status()).toMatchObject({ installed: false, loaded: false, responding: false })
    expect(f.control).not.toHaveBeenCalled()
    await f.service.install()
    f.checkReady.mockResolvedValue(false)
    expect(await f.service.status()).toMatchObject({ installed: true, loaded: true, responding: false })
    await f.service.stop()
    f.checkReady.mockClear()
    expect(await f.service.status()).toMatchObject({ installed: true, loaded: false, responding: false })
    expect(f.checkReady).not.toHaveBeenCalled()
  })
})
