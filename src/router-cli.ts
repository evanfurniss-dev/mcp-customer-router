#!/usr/bin/env node
import { parseArgs } from 'node:util'
import { spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'
import open from 'open'
import { RegistryStore, defaultHome } from './router/registry'
import { createRouterServer } from './router/server'
import { connectionEntry, connectionEnvironment, forwardSignals, runConnectionCheck } from './router/jobs'
import { UserError } from './router/types'

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
    },
  })
  const [command = 'dashboard'] = positionals
  if (values.help) {
    console.log(
      `Customer MCP Router\n\n  dashboard [--open] [--port 4773]    Open customer connection management\n  list                              List saved customers and project bindings\n  add --name NAME --business LABEL --org ID [--url URL]\n  connect --customer ID              Authorize and verify a Glide connection\n  check --customer ID                Check a saved connection without a new sign-in\n  serve --customer ID --project PATH Start the project-bound MCP bridge\n\nAll commands accept --home PATH. Customer data defaults to ~/.mcp-customer-router.\nProject settings are previewed and applied from the dashboard.`,
    )
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
    const child = spawn(process.execPath, [connectionEntry(), '--mode', 'serve'], {
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
