#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio'
import { connectionFailure, runCustomerConnection, type ConnectionMode, type ConnectionSpec } from './router/connection'

// Upstream diagnostics can contain OAuth URLs or server responses. This dedicated child emits only our fixed messages.
console.error = () => {}
console.warn = () => {}
console.log = () => {}
console.info = () => {}
console.debug = () => {}

const requestedMode = process.argv[3]
const mode: ConnectionMode | undefined =
  process.argv[2] === '--mode' && ['connect', 'check', 'serve'].includes(requestedMode) ? (requestedMode as ConnectionMode) : undefined
let fatalReported = false
const reportFatal = () => {
  if (fatalReported) return
  fatalReported = true
  const check = connectionFailure(undefined)
  if (mode === 'serve') process.stderr.write(`${check.message}\n`)
  else process.stdout.write(`${JSON.stringify(check)}\n`)
  process.exit(1)
}
process.on('uncaughtException', reportFatal)
process.on('unhandledRejection', reportFatal)
let close = async () => {}
let stopping = false
const stop = async () => {
  if (stopping) return
  stopping = true
  const timer = setTimeout(() => process.exit(0), 1000)
  timer.unref()
  await close()
  process.exit(0)
}
process.once('SIGINT', stop)
process.once('SIGTERM', stop)
if (mode === 'serve') process.stdin.once('end', stop)

// Bound startup even if the dashboard dies or a network operation never answers.
const startupDeadline = setTimeout(
  () => {
    const check = { state: 'error', checkedAt: new Date().toISOString(), message: 'Connection startup timed out. Try again.' }
    if (mode === 'serve') process.stderr.write(`${check.message}\n`)
    else process.stdout.write(`${JSON.stringify(check)}\n`)
    process.exit(1)
  },
  mode === 'connect' ? 240_000 : mode === 'serve' ? 90_000 : 40_000,
)
startupDeadline.unref()

try {
  if (!mode) throw new Error('Invalid mode')
  const spec = JSON.parse(process.env.CUSTOMER_ROUTER_SPEC || '') as ConnectionSpec
  if (!spec || typeof spec.authDir !== 'string' || !spec.customer || typeof spec.customer.serverUrl !== 'string')
    throw new Error('Invalid spec')
  delete process.env.CUSTOMER_ROUTER_SPEC
  const connection = await runCustomerConnection(spec, mode, mode === 'serve' ? new StdioServerTransport() : undefined)
  clearTimeout(startupDeadline)
  close = connection.close
  if (mode !== 'serve') {
    process.stdout.write(`${JSON.stringify(connection.check)}\n`)
    process.exitCode = connection.check.state === 'verified' ? 0 : 1
  }
} catch (error) {
  clearTimeout(startupDeadline)
  const check = connectionFailure(error)
  if (mode === 'serve') process.stderr.write(`${check.message}\n`)
  else process.stdout.write(`${JSON.stringify(check)}\n`)
  process.exitCode = 1
}
