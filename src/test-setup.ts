import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeEach } from 'vitest'

// Upstream argument-parsing tests can create a default auth directory. Keep all defaults disposable.
const originalHome = process.env.HOME
const originalAuth = process.env.MCP_REMOTE_CONFIG_DIR
const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'customer-router-suite-'))
process.env.HOME = temporary
process.env.MCP_REMOTE_CONFIG_DIR = path.join(temporary, 'auth')

beforeEach(() => {
  if (!process.env.MCP_REMOTE_CONFIG_DIR) process.env.MCP_REMOTE_CONFIG_DIR = path.join(temporary, 'auth')
})

afterAll(async () => {
  if (originalHome === undefined) delete process.env.HOME
  else process.env.HOME = originalHome
  if (originalAuth === undefined) delete process.env.MCP_REMOTE_CONFIG_DIR
  else process.env.MCP_REMOTE_CONFIG_DIR = originalAuth
  await fs.rm(temporary, { recursive: true, force: true })
})
