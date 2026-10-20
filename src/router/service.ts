import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import net from 'node:net'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { defaultHome } from './registry'
import { UserError } from './types'

const exec = promisify(execFile)
const label = 'dev.evanfurniss.mcp-customer-router'
const marker = 'Managed by mcp-customer-router service'
const xml = (value: string) =>
  value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;')
const shell = (value: string) => `'${value.replaceAll("'", "'\\''")}'`

async function readRegular(file: string): Promise<string | undefined> {
  try {
    const stat = await fs.lstat(file)
    if (!stat.isFile()) throw new UserError(`Expected a regular file: ${file}`)
    if (process.getuid && stat.uid !== process.getuid()) throw new UserError(`This file belongs to another user: ${file}`)
    return await fs.readFile(file, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}

async function writePrivate(file: string, content: string, mode = 0o600): Promise<void> {
  const temporary = `${file}.${randomUUID()}.tmp`
  try {
    await fs.writeFile(temporary, content, { mode, flag: 'wx' })
    await fs.rename(temporary, file)
  } finally {
    await fs.rm(temporary, { force: true })
  }
}

async function available(port: number): Promise<void> {
  const server = net.createServer()
  await new Promise<void>((resolve, reject) => {
    server.once('error', () => reject(new UserError(`Port ${port} is in use. Stop its current process before starting the service.`)))
    server.listen(port, '127.0.0.1', () => server.close(() => resolve()))
  })
}

async function ready(port: number): Promise<boolean> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(1000) })
    return response.ok && (await response.json()).service === 'mcp-customer-router'
  } catch {
    return false
  }
}

interface ServiceOptions {
  cliPath: string
  nodePath: string
  userHome?: string
  dataHome?: string
  port?: number
  uid?: number
  launchctl?: (args: string[]) => Promise<string>
  checkPort?: (port: number) => Promise<void>
  checkReady?: (port: number) => Promise<boolean>
}

/** One dashboard service per macOS user. MCP bridges remain owned by their clients. */
export class RouterService {
  readonly plist: string
  readonly shortcut: string
  readonly url: string
  private readonly domain: string
  private readonly target: string
  private readonly home: string
  private readonly dataHome: string
  private readonly port: number
  private readonly logs: string
  private readonly control: (args: string[]) => Promise<string>
  private readonly checkPort: (port: number) => Promise<void>
  private readonly checkReady: (port: number) => Promise<boolean>

  constructor(private readonly options: ServiceOptions) {
    this.home = options.userHome ?? os.homedir()
    this.dataHome = path.resolve(options.dataHome ?? defaultHome())
    this.port = options.port ?? 4773
    if (!Number.isInteger(this.port) || this.port < 1024 || this.port > 65535)
      throw new UserError('Choose a service port from 1024 to 65535.')
    this.plist = path.join(this.home, 'Library/LaunchAgents', `${label}.plist`)
    this.shortcut = path.join(this.home, '.local/bin/mcp-customer-router')
    this.logs = path.join(this.dataHome, 'logs')
    this.domain = `gui/${options.uid ?? process.getuid?.()}`
    this.target = `${this.domain}/${label}`
    this.url = `http://127.0.0.1:${this.port}`
    this.control =
      options.launchctl ??
      (async (args) => {
        try {
          return (await exec('/bin/launchctl', args, { timeout: 15_000 })).stdout
        } catch (error) {
          const detail = (error as { stderr?: string }).stderr?.trim().slice(0, 400)
          throw new UserError(`launchctl ${args[0]} failed${detail ? `: ${detail}` : '. Check the macOS user session.'}`)
        }
      })
    this.checkPort = options.checkPort ?? available
    this.checkReady = options.checkReady ?? ready
  }

  private contents(): string {
    const args = [this.options.nodePath, this.options.cliPath, 'dashboard', '--home', this.dataHome, '--port', String(this.port)]
    return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<!-- ${marker} -->
<plist version="1.0"><dict>
<key>Label</key><string>${label}</string>
<key>ProgramArguments</key><array>${args.map((arg) => `<string>${xml(arg)}</string>`).join('')}</array>
<key>WorkingDirectory</key><string>${xml(this.dataHome)}</string>
<key>EnvironmentVariables</key><dict><key>HOME</key><string>${xml(this.home)}</string><key>PATH</key><string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string></dict>
<key>RunAtLoad</key><true/><key>KeepAlive</key><true/>
<key>ThrottleInterval</key><integer>10</integer><key>ExitTimeOut</key><integer>10</integer>
<key>Umask</key><integer>63</integer>
<key>StandardOutPath</key><string>${xml(path.join(this.logs, 'dashboard.log'))}</string>
<key>StandardErrorPath</key><string>${xml(path.join(this.logs, 'dashboard-error.log'))}</string>
</dict></plist>
`
  }

  private async owned(required = true): Promise<string | undefined> {
    const current = await readRegular(this.plist)
    if (current === undefined) {
      if (required) throw new UserError('Service is not installed. Run: mcp-customer-router service install')
      return undefined
    }
    if (!current.includes(`<!-- ${marker} -->`) || !current.includes(`<string>${label}</string>`)) {
      throw new UserError(`This service file belongs to another program: ${this.plist}`)
    }
    // Prevent a command run with another registry or port from controlling this installation.
    if (
      !current.includes(`<string>--home</string><string>${xml(this.dataHome)}</string>`) ||
      !current.includes(`<string>--port</string><string>${this.port}</string>`)
    ) {
      throw new UserError('The installed service uses a different data directory or port. Use its --home and --port options.')
    }
    return current
  }

  private async loaded(): Promise<boolean> {
    try {
      await this.control(['print', this.target])
      return true
    } catch {
      return false
    }
  }

  private async waitReady(): Promise<void> {
    for (let attempt = 0; attempt < 40; attempt++) {
      if (await this.checkReady(this.port)) return
      await delay(250)
    }
    throw new UserError(`The service did not respond. Check ${path.join(this.logs, 'dashboard-error.log')}`)
  }

  private async unload(): Promise<void> {
    await this.control(['bootout', this.target])
    // launchctl can return while the service is still being removed from its domain.
    for (let attempt = 0; attempt < 40; attempt++) {
      if (!(await this.loaded())) return
      await delay(250)
    }
    throw new UserError('macOS has not finished stopping the router. Try service status before starting it again.')
  }

  async install(): Promise<void> {
    if (!path.isAbsolute(this.options.cliPath) || !this.options.cliPath.endsWith('.js')) {
      throw new UserError('Build the router first, then run node dist/router-cli.js service install.')
    }
    const current = await this.owned(false)
    const shortcut = await readRegular(this.shortcut)
    if (shortcut !== undefined && !shortcut.includes(`# ${marker}\n`))
      throw new UserError(`A different command already exists: ${this.shortcut}`)
    await fs.access(this.options.nodePath, fs.constants.X_OK)
    await fs.access(this.options.cliPath)
    await fs.access(path.resolve(path.dirname(this.options.cliPath), '../web/dist/index.html'))
    const running = await this.loaded()
    if (!current && running) throw new UserError('A different service is already using the router service label.')
    if (!running) await this.checkPort(this.port)
    for (const directory of [path.dirname(this.plist), path.dirname(this.shortcut), this.dataHome, this.logs]) {
      const stat = await fs.lstat(directory).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT') throw error
      })
      if (stat && (!stat.isDirectory() || stat.isSymbolicLink())) throw new UserError(`Expected a directory: ${directory}`)
      await fs.mkdir(directory, { recursive: true, mode: 0o700 })
    }
    await fs.chmod(this.logs, 0o700)
    for (const name of ['dashboard.log', 'dashboard-error.log']) {
      const file = path.join(this.logs, name)
      await readRegular(file)
      const handle = await fs.open(file, 'a', 0o600)
      await handle.close()
      await fs.chmod(file, 0o600)
    }
    if (current !== this.contents()) {
      if (running) await this.unload()
      await writePrivate(this.plist, this.contents())
    }
    await fs.chmod(this.plist, 0o600)
    await writePrivate(
      this.shortcut,
      `#!/bin/sh\n# ${marker}\nexec ${shell(this.options.nodePath)} ${shell(this.options.cliPath)} "$@"\n`,
      0o700,
    )
    await this.start()
  }

  async start(): Promise<void> {
    await this.owned()
    const loaded = await this.loaded()
    if (!loaded) await this.checkPort(this.port)
    await this.control(['enable', this.target])
    if (!loaded) await this.control(['bootstrap', this.domain, this.plist])
    await this.control(['kickstart', this.target])
    await this.waitReady()
  }

  async stop(): Promise<void> {
    await this.owned()
    await this.control(['disable', this.target])
    if (await this.loaded()) await this.unload()
  }

  async restart(): Promise<void> {
    await this.stop()
    await this.start()
  }

  async uninstall(): Promise<void> {
    await this.owned()
    const shortcut = await readRegular(this.shortcut)
    await this.stop()
    await fs.unlink(this.plist)
    if (shortcut?.includes(`# ${marker}\n`)) await fs.unlink(this.shortcut)
  }

  async status() {
    const installed = !!(await this.owned(false))
    const loaded = installed && (await this.loaded())
    return {
      installed,
      loaded,
      responding: loaded && (await this.checkReady(this.port)),
      url: this.url,
      plist: this.plist,
      logs: this.logs,
    }
  }
}
