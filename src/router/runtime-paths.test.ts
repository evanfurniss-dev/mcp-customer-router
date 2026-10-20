import { execFile } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'
import { generateProjectConfigEntry } from './project-config'
import { resolveRuntimePaths } from './runtime-paths'
import { RouterService } from './service'

const exec = promisify(execFile)
const roots: string[] = []
const projectRoot = fileURLToPath(new URL('../../', import.meta.url))

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'router-install-paths-'))
  roots.push(root)
  const directory = path.join(root, 'checkout/dist')
  await fs.mkdir(directory, { recursive: true })
  return { root, directory, cliPath: path.join(directory, 'router-cli.js'), manifest: path.join(directory, 'install-paths.json') }
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })))
})

describe('installed runtime paths', () => {
  it('keeps checkout paths when no installer file exists', async () => {
    const f = await fixture()
    const nodePath = path.join(f.root, 'source-node')
    await fs.writeFile(nodePath, 'source runtime fixture')
    expect(resolveRuntimePaths(f.cliPath, nodePath)).toEqual({
      cliPath: f.cliPath,
      nodePath,
      connectionPath: path.join(f.directory, 'router-connection.js'),
      webPath: path.join(f.root, 'checkout/web/dist'),
    })
  })

  it.each([
    ['broken JSON', '{'],
    ['null', 'null'],
    ['array', '[]'],
    ['missing executable', JSON.stringify({ cliPath: '/opt/router/dist/router-cli.js' })],
    ['relative executable', JSON.stringify({ cliPath: '/opt/router/dist/router-cli.js', nodePath: 'node' })],
    ['relative CLI', JSON.stringify({ cliPath: 'dist/router-cli.js', nodePath: '/opt/node/bin/node' })],
    ['invalid CLI type', JSON.stringify({ cliPath: 42, nodePath: '/opt/node/bin/node' })],
    ['non-JavaScript CLI', JSON.stringify({ cliPath: '/opt/router/bin/router', nodePath: '/opt/node/bin/node' })],
    ['control character', JSON.stringify({ cliPath: '/opt/router/dist/router-cli.js', nodePath: '/opt/node\n/bin/node' })],
  ])('fails closed for %s instead of using checkout paths', async (_name, content) => {
    const f = await fixture()
    await fs.writeFile(f.manifest, content)
    expect(() => resolveRuntimePaths(f.cliPath)).toThrow('The router installation paths are invalid. Reinstall the router.')
  })

  it('fails closed when the installer file cannot be read as a file', async () => {
    const f = await fixture()
    await fs.mkdir(f.manifest)
    expect(() => resolveRuntimePaths(f.cliPath)).toThrow('Could not read the router installation paths. Reinstall the router.')
  })

  it('keeps project settings and the service usable after opt switches and the old version is removed', async () => {
    const f = await fixture()
    const opt = path.join(f.root, 'opt')
    const routerLink = path.join(opt, 'mcp-customer-router')
    const nodePath = path.join(opt, 'node/bin/node')
    const cliPath = path.join(routerLink, 'libexec/dist/router-cli.js')
    const installed = { cliPath, nodePath }
    await fs.mkdir(path.dirname(nodePath), { recursive: true })
    await fs.symlink(process.execPath, nodePath)
    const versions = ['1', '2'].map((version) => path.join(f.root, 'Cellar/mcp-customer-router', version))
    for (const [index, version] of versions.entries()) {
      const dist = path.join(version, 'libexec/dist')
      const web = path.join(version, 'libexec/web/dist')
      await fs.mkdir(dist, { recursive: true })
      await fs.mkdir(web, { recursive: true })
      await fs.writeFile(path.join(dist, 'install-paths.json'), JSON.stringify(installed))
      await fs.writeFile(path.join(dist, 'router-cli.js'), `console.log('cli-${index + 1}')\n`)
      await fs.writeFile(path.join(dist, 'router-connection.js'), `console.log('connection-${index + 1}')\n`)
      await fs.writeFile(path.join(web, 'index.html'), `web-${index + 1}`)
    }
    await fs.symlink(versions[0], routerLink)
    const originalCli = path.join(versions[0], 'libexec/dist/router-cli.js')
    const runtime = resolveRuntimePaths(originalCli)
    expect(runtime.cliPath).toBe(cliPath)
    expect(runtime.nodePath).toBe(nodePath)
    const config = generateProjectConfigEntry({
      ...runtime,
      projectPath: path.join(f.root, 'project'),
      home: path.join(f.root, 'data'),
      customerId: '11111111-1111-4111-8111-111111111111',
    })
    expect(config.claude.command).toBe(nodePath)
    expect(config.codex.args[0]).toBe(cliPath)
    expect(JSON.stringify(config)).not.toContain('/Cellar/')
    let loaded = false
    const service = new RouterService({
      ...runtime,
      userHome: path.join(f.root, 'user'),
      dataHome: path.join(f.root, 'data'),
      uid: 501,
      launchctl: async (args) => {
        if (args[0] === 'print' && !loaded) throw new Error('Fixture is not loaded')
        if (args[0] === 'bootstrap') loaded = true
        return ''
      },
      checkPort: async () => {},
      checkReady: async () => true,
    })
    await service.install()
    expect(await fs.readFile(service.plist, 'utf8')).not.toContain('/Cellar/')
    expect((await exec(runtime.nodePath, [runtime.connectionPath])).stdout.trim()).toBe('connection-1')
    await fs.unlink(routerLink)
    await fs.symlink(versions[1], routerLink)
    await fs.rm(versions[0], { recursive: true })
    expect(resolveRuntimePaths(originalCli)).toEqual(runtime)
    expect(resolveRuntimePaths(path.join(versions[1], 'libexec/dist/router-cli.js'))).toEqual(runtime)
    expect((await exec(config.codex.command, config.codex.args)).stdout.trim()).toBe('cli-2')
    expect((await exec(service.shortcut, ['--version'])).stdout.trim()).toBe('cli-2')
    expect((await exec(runtime.nodePath, [runtime.connectionPath])).stdout.trim()).toBe('connection-2')
    expect(await fs.readFile(path.join(runtime.webPath, 'index.html'), 'utf8')).toBe('web-2')
  })
})

describe('CLI information commands', () => {
  it.each(['--help', '--version', '-v'])('prints %s without creating customer data', async (flag) => {
    const f = await fixture()
    const dataHome = path.join(f.root, 'never-created')
    const { stdout, stderr } = await exec(
      process.execPath,
      ['--import', 'tsx', path.join(projectRoot, 'src/router-cli.ts'), flag, '--home', dataHome],
      { cwd: projectRoot },
    )
    const metadata = JSON.parse(await fs.readFile(path.join(projectRoot, 'package.json'), 'utf8'))
    const helpOutput = expect.stringContaining('Customer MCP Router')
    const expected = flag === '--help' ? helpOutput : metadata.version
    expect(stdout.trim()).toEqual(expected)
    expect(stderr).toBe('')
    await expect(fs.stat(dataHome)).rejects.toMatchObject({ code: 'ENOENT' })
  })
})
