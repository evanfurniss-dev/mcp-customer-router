#!/usr/bin/env node
import { parseArgs } from 'node:util'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import fs from 'node:fs/promises'
import path from 'node:path'
import open from 'open'
import { RegistryStore, defaultHome } from './router/registry'
import { createRouterServer } from './router/server'
import { connectionEnvironment, forwardSignals, runConnectionCheck } from './router/jobs'
import { UserError } from './router/types'
import { RouterService } from './router/service'
import { resolveRuntimePaths } from './router/runtime-paths'

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      home: { type: 'string' },
      port: { type: 'string' },
      open: { type: 'boolean' },
      customer: { type: 'string' },
      project: { type: 'string' },
      name: { type: 'string' },
      business: { type: 'string' },
      org: { type: 'string' },
      url: { type: 'string' },
      help: { type: 'boolean', short: 'h' },
      version: { type: 'boolean', short: 'v' },
    },
  })
  const [command = 'dashboard'] = positionals
  if (values.help) {
    console.log(
      `Customer MCP Router\n\n  service install [--open]           Start at Mac login; install the CLI shortcut\n  service status                    Show service and dashboard status\n  service start|stop|restart         Control the background dashboard\n  service uninstall                 Remove autostart; keep customer data\n  open                              Start the installed service and open its UI\n  dashboard [--open] [--port 4773]    Run the dashboard in this terminal\n  list                              List saved customers and project bindings\n  add --name NAME --business LABEL --org ID [--url URL]\n  connect --customer ID              Authorize and verify a Glide connection\n  check --customer ID                Check a saved connection without a new sign-in\n  serve --customer ID --project PATH Start the project-bound MCP bridge\n\nAll commands accept --home PATH. Customer data defaults to ~/.mcp-customer-router.\nService commands use the installed --home and --port (default 4773).\nProject settings are previewed and applied from the dashboard.`,
    )
    return
  }
  if (values.version) {
    const metadata = JSON.parse(await fs.readFile(new URL('../package.json', import.meta.url), 'utf8')) as { version: unknown }
    if (typeof metadata.version !== 'string') throw new UserError('The router package version is missing. Reinstall the router.')
    console.log(metadata.version)
    return
  }
  const runtime = resolveRuntimePaths(fileURLToPath(import.meta.url))
  if (command === 'service' || command === 'open') {
    if (process.platform !== 'darwin' || !process.getuid || process.getuid() === 0) {
      throw new UserError('Service commands require a signed-in macOS user. Run dashboard in a terminal on other systems.')
    }
    const action = command === 'open' ? 'start' : positionals[1]
    if (!['install', 'status', 'start', 'stop', 'restart', 'uninstall'].includes(action))
      throw new UserError('Use service install, status, start, stop, restart, or uninstall.')
    const service = new RouterService({
      cliPath: runtime.cliPath,
      nodePath: runtime.nodePath,
      dataHome: values.home,
      port: Number(values.port ?? 4773),
    })
    if (action === 'status') {
      console.log(JSON.stringify(await service.status(), null, 2))
      return
    }
    await service[action as 'install' | 'start' | 'stop' | 'restart' | 'uninstall']()
    console.log(
      action === 'stop'
        ? 'Service stopped. Start it with: mcp-customer-router service start'
        : action === 'uninstall'
          ? 'Service removed. Customer data retained.'
          : `Customer MCP Router: ${service.url}`,
    )
    if (action === 'install') console.log(`CLI: ${service.shortcut}`)
    if ((command === 'open' || values.open) && ['install', 'start', 'restart'].includes(action)) {
      await open(service.url).catch(() => console.error(`Open ${service.url} in your browser.`))
    }
    return
  }
  const store = new RegistryStore(values.home ?? defaultHome())
  if (command === 'dashboard') {
    await store.read()
    const port = Number(values.port ?? 4773)
    if (!Number.isInteger(port) || port < 0 || port > 65535) throw new UserError('Choose a valid local port.')
    const { server } = createRouterServer({ store })
    server.on('error', (error: NodeJS.ErrnoException) => {
      console.error(
        error.code === 'EADDRINUSE'
          ? 'This port is in use. Open the existing router or use --port with another port.'
          : 'Could not start the local dashboard.',
      )
      process.exitCode = 1
    })
    server.listen(port, '127.0.0.1', () => {
      const address = server.address()
      if (!address || typeof address === 'string') return
      const url = `http://127.0.0.1:${address.port}`
      console.log(`Customer MCP Router: ${url}`)
      if (values.open) void open(url).catch(() => console.error('Open the dashboard address in your browser.'))
    })
    const stop = () => {
      server.close()
      server.closeAllConnections()
    }
    process.once('SIGINT', stop)
    process.once('SIGTERM', stop)
    return
  }
  if (command === 'list') {
    console.log(JSON.stringify(await store.read(), null, 2))
    return
  }
  if (command === 'add') {
    console.log(
      JSON.stringify(
        await store.add({ name: values.name, business: values.business, expectedOrgId: values.org, serverUrl: values.url }),
        null,
        2,
      ),
    )
    return
  }
  if (command === 'connect' || command === 'check') {
    if (!values.customer) throw new UserError('Specify --customer with its saved ID.')
    const customer = await store.customer(values.customer)
    const generation = command === 'connect' ? await store.beginConnect(customer.id) : await store.generation(customer.id)
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), command === 'connect' ? 300000 : 45000)
    try {
      const check = await runConnectionCheck(customer, command, store.authDir(customer.id), controller.signal)
      await store.recordCheck(customer.id, check, generation)
      console.log(JSON.stringify(check, null, 2))
      if (check.state !== 'verified') process.exitCode = 1
    } finally {
      clearTimeout(timer)
    }
    return
  }
  if (command === 'serve') {
    if (!values.customer || !values.project) throw new UserError('The bridge needs a saved customer and project binding.')
    const customer = await store.requireBinding(values.customer, values.project)
    const canonicalProject = await fs.realpath(values.project)
    const cwd = await fs.realpath(process.cwd())
    const relative = path.relative(canonicalProject, cwd)
    if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      throw new UserError('Start this connection from its bound project directory.', 403)
    }
    const child = spawn(runtime.nodePath, [runtime.connectionPath, '--mode', 'serve'], {
      cwd: canonicalProject,
      env: connectionEnvironment(customer, store.authDir(customer.id)),
      stdio: 'inherit',
    })
    forwardSignals(child)
    child.once('error', () => {
      console.error('Could not start the customer connection. Rebuild the router.')
      process.exitCode = 1
    })
    child.once('exit', (code) => {
      process.exitCode = code ?? 1
    })
    return
  }
  throw new UserError(`Unknown command: ${command}. Use --help.`)
}

void main().catch((error: unknown) => {
  console.error(error instanceof UserError ? error.message : 'The router could not start. Check its arguments and data directory.')
  process.exitCode = 1
})
