import { constants } from 'node:fs'
import fs from 'node:fs/promises'
import { createHash, randomUUID } from 'node:crypto'
import os from 'node:os'
import path from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { parse as parseToml } from 'smol-toml'

const SERVER_NAME = 'customer-glide'
const MAX_CONFIG_BYTES = 4 * 1024 * 1024
const preparedPlans = new WeakSet<ProjectConfigPlan>()

export interface ProjectConfigOptions {
  projectPath: string
  customerId: string
  home: string
  cliPath: string
  nodePath: string
}

type ConfigKind = 'claude' | 'codex'
type ConfigObject = Record<string, unknown>

interface ProjectConfigFile {
  path: string
  kind: ConfigKind
  /** Private configuration content. Never send before/after to a browser or log. */
  before: string | null
  after: string
  /** null means that the file did not exist when the plan was made. */
  sha256: string | null
  generatedSnippet: string
  /** Canonical parent of an existing user configuration file. */
  parentRealPath?: string
}

interface ExistingConnection {
  id: string
  name: string
  filePath: string
  scope: 'project' | 'user' | 'project-private'
  client: ConfigKind
  removable: boolean
  reason?: string
}

interface ConnectionAction {
  id: string
  action: 'remove' | 'ignore'
}

export interface ProjectConfigPlan {
  projectPath: string
  files: ProjectConfigFile[]
  warnings: string[]
  connections: ExistingConnection[]
  /** Private snapshots used only when a reviewed connection is removed. */
  connectionFiles: ProjectConfigFile[]
}

export interface ProjectConfigApplyResult {
  files: { path: string; changed: boolean; backupPath: string | null }[]
  warnings: string[]
}

function digest(value: string | null): string | null {
  return value === null ? null : createHash('sha256').update(value).digest('hex')
}

function freezePlan(plan: ProjectConfigPlan): ProjectConfigPlan {
  for (const file of [...plan.files, ...plan.connectionFiles]) Object.freeze(file)
  for (const connection of plan.connections) Object.freeze(connection)
  Object.freeze(plan.files)
  Object.freeze(plan.connectionFiles)
  Object.freeze(plan.connections)
  Object.freeze(plan.warnings)
  preparedPlans.add(plan)
  return Object.freeze(plan)
}

function isObject(value: unknown): value is ConfigObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function normalizeConfig(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalizeConfig)
  if (isObject(value) && (Object.getPrototypeOf(value) === null || Object.getPrototypeOf(value) === Object.prototype)) {
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, normalizeConfig(child)]))
  }
  return value
}

function configEqual(left: unknown, right: unknown): boolean {
  // smol-toml uses null-prototype tables; compare their values with generated plain objects.
  return isDeepStrictEqual(normalizeConfig(left), normalizeConfig(right))
}

function errorCode(error: unknown): string | undefined {
  return isObject(error) && typeof error.code === 'string' ? error.code : undefined
}

function validateOptions(options: ProjectConfigOptions): void {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(options.customerId)) {
    throw new Error('The customer ID must be a UUID.')
  }
  for (const key of ['projectPath', 'home', 'cliPath', 'nodePath'] as const) {
    if (!path.isAbsolute(options[key]) || Array.from(options[key]).some((character) => character.charCodeAt(0) < 32)) {
      throw new Error(`${key} must be an absolute path without control characters.`)
    }
  }
}

/** Build only the new entry. This value contains no existing client settings or credentials. */
export function generateProjectConfigEntry(options: ProjectConfigOptions): {
  claude: { type: 'stdio'; command: string; args: string[] }
  codex: { command: string; args: string[] }
} {
  validateOptions(options)
  const args = [options.cliPath, 'serve', '--customer', options.customerId, '--project', options.projectPath, '--home', options.home]
  return {
    claude: { type: 'stdio', command: options.nodePath, args: [...args] },
    codex: { command: options.nodePath, args: [...args] },
  }
}

function parseConfig(content: string | null, kind: ConfigKind, filePath: string): ConfigObject {
  if (content === null) return {}
  try {
    const parsed: unknown = kind === 'claude' ? JSON.parse(content) : parseToml(content)
    if (!isObject(parsed)) throw new Error('Expected an object')
    return parsed
  } catch {
    // Parser errors can contain source lines, including credentials.
    throw new Error(`Cannot parse ${kind === 'claude' ? 'JSON' : 'TOML'} configuration at ${filePath}. No settings were changed.`)
  }
}

async function canonicalProject(projectPath: string): Promise<string> {
  const canonical = await fs.realpath(projectPath)
  if (!(await fs.stat(canonical)).isDirectory()) throw new Error('The project path must be an existing directory.')
  return canonical
}

async function assertProjectUnchanged(projectPath: string): Promise<void> {
  if ((await canonicalProject(projectPath)) !== projectPath) throw new Error('The project path changed or became a symbolic link.')
}

async function assertConfigParents(projectPath: string): Promise<void> {
  await assertProjectUnchanged(projectPath)
  try {
    const info = await fs.lstat(path.join(projectPath, '.codex'))
    if (info.isSymbolicLink() || !info.isDirectory())
      throw new Error('The project .codex path must be a directory without a symbolic link.')
  } catch (error) {
    if (errorCode(error) !== 'ENOENT') throw error
  }
}

async function readConfigFile(filePath: string): Promise<{ content: string | null; mode: number }> {
  let handle
  try {
    handle = await fs.open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW)
    const info = await handle.stat()
    if (!info.isFile()) throw new Error(`Configuration path is not a regular file: ${filePath}`)
    if (info.size > MAX_CONFIG_BYTES) throw new Error(`Configuration exceeds the ${MAX_CONFIG_BYTES} byte limit: ${filePath}`)
    return { content: await handle.readFile('utf8'), mode: info.mode & 0o777 }
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return { content: null, mode: 0o600 }
    if (errorCode(error) === 'ELOOP') throw new Error(`Refusing symbolic link configuration: ${filePath}`, { cause: error })
    throw error
  } finally {
    await handle?.close()
  }
}

function serversIn(config: ConfigObject, kind: ConfigKind): ConfigObject {
  const key = kind === 'claude' ? 'mcpServers' : 'mcp_servers'
  const value = config[key]
  if (value === undefined) return {}
  if (!isObject(value)) throw new Error(`${key} must be an object. No settings were changed.`)
  return value
}

function isGlideEntry(name: string, entry: unknown): boolean {
  if (/glide/i.test(name)) return true
  if (!isObject(entry)) return false
  return [entry.url, ...(Array.isArray(entry.args) ? entry.args : [])].some((candidate) => {
    if (typeof candidate !== 'string') return false
    try {
      const host = new URL(candidate).hostname.toLowerCase()
      return ['glideapps.dev', 'glideapps.com'].some((domain) => host === domain || host.endsWith(`.${domain}`))
    } catch {
      return false
    }
  })
}

/** Find real table headers, ignoring header-like text inside multiline strings. */
function tomlSections(content: string) {
  const lines = content.match(/[^\n]*\n|[^\n]+$/g) ?? []
  const headers: { line: number; keys: string[] }[] = []
  const comments = new Set<number>()
  let quote: string | null = null
  for (const [lineNumber, line] of lines.entries()) {
    if (quote === null) {
      if (/^\s*(?:#[^\n]*)?\s*$/.test(line)) comments.add(lineNumber)
      if (/^\s*\[/.test(line)) {
        try {
          const marker = '__router_section_path__'
          let table: unknown = parseToml(`${line}\n${marker} = true\n`)
          const keys: string[] = []
          while (table && typeof table === 'object') {
            if (Array.isArray(table)) {
              table = table[0]
              continue
            }
            if (Object.hasOwn(table, marker)) break
            const entries = Object.entries(table)
            if (entries.length !== 1) throw new Error('Ambiguous table header')
            keys.push(entries[0][0])
            table = entries[0][1]
          }
          if (isObject(table) && table[marker] === true) headers.push({ line: lineNumber, keys })
        } catch {
          /* An array value can start with '['. Only parsed headers matter. */
        }
      }
    }
    for (let index = 0; index < line.length; index++) {
      const character = line[index]
      if (quote === null) {
        if (character === '#') break
        if (character === '"' || character === "'") {
          const triple = character.repeat(3)
          if (line.slice(index, index + 3) === triple) {
            quote = triple
            index += 2
          } else quote = character
        }
      } else if (quote.startsWith('"') && character === '\\') index++
      else if (quote.length === 3 && line.slice(index, index + 3) === quote) {
        index += 2
        while (line[index + 1] === character) index++
        quote = null
      } else if (quote.length === 1 && character === quote) quote = null
    }
  }
  return { lines, headers, comments }
}

function withoutTomlServer(content: string, name: string, filePath: string): string {
  const before = parseConfig(content, 'codex', filePath)
  const { lines, headers, comments } = tomlSections(content)
  const remove = new Set<number>()
  for (const [index, header] of headers.entries()) {
    if (header.keys[0] !== 'mcp_servers' || header.keys[1] !== name) continue
    let end = headers[index + 1]?.line ?? lines.length
    while (end > header.line + 1 && comments.has(end - 1)) end--
    for (let line = header.line; line < end; line++) remove.add(line)
  }
  if (remove.size === 0) throw new Error('This TOML entry uses a layout that requires manual editing.')
  const after = lines.filter((_line, index) => !remove.has(index)).join('')
  const expectedServers = { ...serversIn(before, 'codex') }
  delete expectedServers[name]
  const expected: ConfigObject = { ...before, mcp_servers: expectedServers }
  const actual = parseConfig(after, 'codex', filePath)
  if (!Object.hasOwn(actual, 'mcp_servers') && Object.keys(expectedServers).length === 0) delete expected.mcp_servers
  if (!configEqual(actual, expected)) throw new Error('This TOML entry cannot be removed without changing other settings.')
  return after
}

function withoutConnection(content: string, connection: ExistingConnection, projectPath: string): string {
  if (connection.client === 'codex') return withoutTomlServer(content, connection.name, connection.filePath)
  const config = parseConfig(content, 'claude', connection.filePath)
  let owner = config
  if (connection.scope === 'project-private') {
    if (!isObject(config.projects) || !isObject(config.projects[projectPath])) throw new Error('The private project settings changed.')
    owner = config.projects[projectPath]
  }
  const servers = serversIn(owner, 'claude')
  if (!Object.hasOwn(servers, connection.name)) throw new Error('The existing connection changed. Create a new preview.')
  delete servers[connection.name]
  const indentation = content.match(/\n([\t ]+)"/)?.[1] ?? '  '
  return `${JSON.stringify(config, null, indentation)}\n`
}

function findConnections(file: ProjectConfigFile, projectPath: string, scope: ExistingConnection['scope']): ExistingConnection[] {
  const config = parseConfig(file.before, file.kind, file.path)
  const owner = scope === 'project-private' ? (isObject(config.projects) ? config.projects[projectPath] : undefined) : config
  if (!isObject(owner)) return []
  return Object.entries(serversIn(owner, file.kind)).flatMap(([name, entry]) => {
    if ((scope === 'project' && name === SERVER_NAME) || !isGlideEntry(name, entry)) return []
    const connection: ExistingConnection = { id: randomUUID(), name, filePath: file.path, scope, client: file.kind, removable: true }
    try {
      withoutConnection(file.before!, connection, projectPath)
    } catch {
      connection.removable = false
      connection.reason = 'This entry needs a manual edit to preserve the other settings in this file.'
    }
    return [connection]
  })
}

async function inspectUserConnections(projectPath: string) {
  const claudePath = path.join(process.env.CLAUDE_CONFIG_DIR || os.homedir(), '.claude.json')
  const codexPath = path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'config.toml')
  const files: ProjectConfigFile[] = []
  const connections: ExistingConnection[] = []
  const warnings: string[] = []
  const sources: [string, ConfigKind][] = [
    [claudePath, 'claude'],
    [codexPath, 'codex'],
  ]
  if (process.platform === 'darwin')
    sources.push([path.join(os.homedir(), 'Library/Application Support/Claude/claude_desktop_config.json'), 'claude'])
  for (const [filePath, kind] of sources) {
    try {
      if (!path.isAbsolute(filePath)) throw new Error('Client config directory must be absolute')
      const { content } = await readConfigFile(filePath)
      if (content === null) continue
      const projectConfigPath = path.join(projectPath, kind === 'claude' ? '.mcp.json' : '.codex/config.toml')
      // CODEX_HOME can be the selected project's .codex directory.
      const projectRealPath = await fs.realpath(projectConfigPath).catch(() => undefined)
      if (projectRealPath && (await fs.realpath(filePath)) === projectRealPath) continue
      const file: ProjectConfigFile = {
        path: filePath,
        kind,
        before: content,
        after: content,
        sha256: digest(content),
        generatedSnippet: '',
        parentRealPath: await fs.realpath(path.dirname(filePath)),
      }
      const found = findConnections(file, projectPath, 'user')
      if (kind === 'claude') found.push(...findConnections(file, projectPath, 'project-private'))
      if (found.length > 0) {
        files.push(file)
        connections.push(...found)
      }
    } catch {
      warnings.push(`Could not inspect MCP entries in ${filePath}. Check that file before enabling this connection.`)
    }
  }
  return { files, connections, warnings }
}

function tomlSnippet(entry: { command: string; args: string[] }): string {
  return `# Managed by mcp-customer-router\n[mcp_servers."${SERVER_NAME}"]\ncommand = ${JSON.stringify(entry.command)}\nargs = ${JSON.stringify(entry.args)}\n`
}

/** Only relocate a previously generated entry; never change its customer binding or extra settings. */
function canUpdateRuntimePaths(current: unknown, generated: { command: string; args: string[] }): boolean {
  if (
    !isObject(current) ||
    typeof current.command !== 'string' ||
    !path.isAbsolute(current.command) ||
    !['node', 'node.exe'].includes(path.basename(current.command)) ||
    !Array.isArray(current.args) ||
    typeof current.args[0] !== 'string' ||
    !path.isAbsolute(current.args[0]) ||
    path.basename(current.args[0]) !== 'router-cli.js'
  )
    return false
  return configEqual({ ...current, command: generated.command, args: [generated.args[0], ...current.args.slice(1)] }, generated)
}

/** Plan project settings without writing files or changing client trust. */
export async function planProjectConfig(options: ProjectConfigOptions): Promise<ProjectConfigPlan> {
  validateOptions(options)
  const projectPath = await canonicalProject(options.projectPath)
  await assertConfigParents(projectPath)
  const entries = generateProjectConfigEntry({ ...options, projectPath })
  const files: ProjectConfigFile[] = []
  const warnings: string[] = []
  const connections: ExistingConnection[] = []
  for (const kind of ['claude', 'codex'] as const) {
    const filePath = path.join(projectPath, kind === 'claude' ? '.mcp.json' : '.codex/config.toml')
    const { content: before } = await readConfigFile(filePath)
    const config = parseConfig(before, kind, filePath)
    const servers = serversIn(config, kind)
    const entry = entries[kind]
    const present = Object.hasOwn(servers, SERVER_NAME)
    const needsUpdate = !present || !configEqual(servers[SERVER_NAME], entry)
    if (present && needsUpdate && !canUpdateRuntimePaths(servers[SERVER_NAME], entry)) {
      throw new Error(`The ${SERVER_NAME} entry in ${filePath} differs from this connection. Review the collision before changing it.`)
    }
    const generatedSnippet =
      kind === 'claude' ? `${JSON.stringify({ mcpServers: { [SERVER_NAME]: entry } }, null, 2)}\n` : tomlSnippet(entries.codex)
    let after = before ?? ''
    if (needsUpdate) {
      if (kind === 'claude') {
        const indentation = before?.match(/\n([\t ]+)"/)?.[1] ?? '  '
        after = `${JSON.stringify({ ...config, mcpServers: { ...servers, [SERVER_NAME]: entry } }, null, indentation)}\n`
      } else {
        const retained = present ? withoutTomlServer(before!, SERVER_NAME, filePath) : (before ?? '')
        after = `${retained}${retained ? (retained.endsWith('\n') ? '\n' : '\n\n') : ''}${generatedSnippet}`
      }
      const result = parseConfig(after, kind, filePath)
      if (!configEqual(serversIn(result, kind)[SERVER_NAME], entry)) throw new Error(`Could not safely add the MCP entry to ${filePath}.`)
      const key = kind === 'claude' ? 'mcpServers' : 'mcp_servers'
      const expected = { ...config, [key]: { ...servers, [SERVER_NAME]: entry } }
      if (!configEqual(result, expected)) throw new Error(`Adding the MCP entry would alter other settings in ${filePath}.`)
    }
    const file = { path: filePath, kind, before, after, sha256: digest(before), generatedSnippet }
    files.push(file)
    connections.push(...findConnections(file, projectPath, 'project'))
  }
  const userConnections = await inspectUserConnections(projectPath)
  warnings.push(...userConnections.warnings)
  connections.push(...userConnections.connections)
  return freezePlan({ projectPath, files, warnings, connections, connectionFiles: userConnections.files })
}

/** Safe preview for a UI or CLI. Existing settings can contain secrets and are deliberately omitted. */
export function projectConfigPreview(plan: ProjectConfigPlan) {
  return {
    projectPath: plan.projectPath,
    files: plan.files.map((file) => ({
      path: file.path,
      action: file.before === file.after ? 'unchanged' : file.before === null ? 'create' : 'update',
      changed: file.before !== file.after,
      sha256: file.sha256,
      generatedSnippet: file.generatedSnippet,
    })),
    warnings: [...plan.warnings],
    connections: plan.connections.map((connection) => ({ ...connection })),
  }
}

/** Resolve explicit dashboard choices against a frozen, server-owned preview. */
export function reviewProjectConnections(plan: ProjectConfigPlan, input: unknown): ProjectConfigPlan {
  validatePlan(plan)
  const actions = input ?? []
  if (!Array.isArray(actions)) throw new Error('Choose Remove or Ignore for each existing connection.')
  const selected = new Map<string, ConnectionAction['action']>()
  for (const action of actions) {
    if (
      !isObject(action) ||
      Object.keys(action).some((key) => key !== 'id' && key !== 'action') ||
      typeof action.id !== 'string' ||
      (action.action !== 'remove' && action.action !== 'ignore') ||
      selected.has(action.id)
    ) {
      throw new Error('Invalid connection choices. Create a new preview.')
    }
    const connection = plan.connections.find((entry) => entry.id === action.id)
    if (!connection) throw new Error('That connection is not part of this preview. Create a new preview.')
    if (action.action === 'remove' && !connection.removable) throw new Error(`The ${connection.name} connection requires a manual edit.`)
    selected.set(action.id, action.action)
  }
  if (selected.size !== plan.connections.length) throw new Error('Choose Remove or Ignore for each existing connection.')
  const files = plan.files.map((file) => ({ ...file }))
  for (const connection of plan.connections) {
    if (selected.get(connection.id) !== 'remove') continue
    let file = files.find((entry) => entry.path === connection.filePath)
    if (!file) {
      const source = plan.connectionFiles.find((entry) => entry.path === connection.filePath)
      if (!source) throw new Error('Invalid connection source. Create a new preview.')
      file = { ...source }
      files.push(file)
    }
    file.after = withoutConnection(file.after, connection, plan.projectPath)
  }
  return freezePlan({ ...plan, files })
}

async function writeExclusive(filePath: string, content: string, mode: number): Promise<void> {
  const handle = await fs.open(filePath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, mode)
  try {
    await handle.writeFile(content, 'utf8')
    await handle.sync()
  } finally {
    await handle.close()
  }
}

function validatePlan(plan: ProjectConfigPlan): void {
  const expected = [path.join(plan.projectPath, '.mcp.json'), path.join(plan.projectPath, '.codex/config.toml')]
  if (!preparedPlans.has(plan) || !path.isAbsolute(plan.projectPath) || plan.files.length < 2)
    throw new Error('Invalid project configuration plan.')
  for (const [index, file] of plan.files.entries()) {
    const source = index < 2 ? undefined : plan.connectionFiles.find((entry) => entry.path === file.path && entry.kind === file.kind)
    if ((index < 2 ? file.path !== expected[index] : !source || file.before !== source.before) || digest(file.before) !== file.sha256)
      throw new Error('Invalid project configuration plan.')
    parseConfig(file.after, file.kind, file.path)
  }
}

async function assertPlanParents(plan: ProjectConfigPlan): Promise<void> {
  await assertConfigParents(plan.projectPath)
  for (const file of plan.files) {
    if (file.parentRealPath && (await fs.realpath(path.dirname(file.path))) !== file.parentRealPath)
      throw new Error(`The configuration directory changed after preview: ${path.dirname(file.path)}. Create a new preview.`)
  }
}

async function lockUserFiles(plan: ProjectConfigPlan): Promise<{ path: string; handle: Awaited<ReturnType<typeof fs.open>> }[]> {
  const locks: { path: string; handle: Awaited<ReturnType<typeof fs.open>> }[] = []
  try {
    for (const file of plan.files.filter((item) => item.parentRealPath).sort((a, b) => a.path.localeCompare(b.path))) {
      const lockPath = `${file.path}.customer-glide.lock`
      locks.push({
        path: lockPath,
        handle: await fs.open(lockPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600),
      })
    }
    return locks
  } catch {
    for (const lock of locks) {
      await lock.handle.close()
      await fs.unlink(lock.path)
    }
    throw new Error('Could not acquire a user configuration lock. Another update or an interrupted update may need review.')
  }
}

/** Apply a reviewed in-memory plan with conflict detection, backups, and rollback on a handled failure. */
export async function applyProjectConfig(plan: ProjectConfigPlan): Promise<ProjectConfigApplyResult> {
  validatePlan(plan)
  await assertPlanParents(plan)
  const lockPath = path.join(plan.projectPath, '.customer-glide-config.lock')
  let lock
  try {
    lock = await fs.open(lockPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
  } catch {
    throw new Error('Could not acquire the project configuration lock. Another update or an interrupted update may need review.')
  }
  const staged: { file: ProjectConfigFile; temporaryPath: string; backupPath: string | null; mode: number; committed: boolean }[] = []
  let createdCodexDirectory = false
  let userLocks: Awaited<ReturnType<typeof lockUserFiles>> = []
  try {
    userLocks = await lockUserFiles(plan)
    await assertPlanParents(plan)
    const current = await Promise.all(plan.files.map((file) => readConfigFile(file.path)))
    if (current.every((value, index) => value.content === plan.files[index].after)) {
      return { files: plan.files.map((file) => ({ path: file.path, changed: false, backupPath: null })), warnings: [...plan.warnings] }
    }
    for (const [index, file] of plan.files.entries()) {
      if (digest(current[index].content) !== file.sha256)
        throw new Error(`Configuration changed after preview: ${file.path}. Create a new preview.`)
    }
    const codexDirectory = path.join(plan.projectPath, '.codex')
    try {
      await fs.mkdir(codexDirectory, { mode: 0o700 })
      createdCodexDirectory = true
    } catch (error) {
      if (errorCode(error) !== 'EEXIST') throw error
    }
    await assertPlanParents(plan)
    for (const [index, file] of plan.files.entries()) {
      if (file.before === file.after) continue
      const suffix = randomUUID()
      const item = {
        file,
        temporaryPath: `${file.path}.customer-glide-${suffix}.tmp`,
        backupPath: file.before === null ? null : `${file.path}.customer-glide-${suffix}.bak`,
        mode: current[index].mode,
        committed: false,
      }
      staged.push(item)
      await writeExclusive(item.temporaryPath, file.after, item.mode)
      if (item.backupPath !== null) await writeExclusive(item.backupPath, file.before!, 0o600)
    }
    for (const item of staged) {
      await assertPlanParents(plan)
      if (digest((await readConfigFile(item.file.path)).content) !== item.file.sha256) {
        throw new Error(`Configuration changed during update: ${item.file.path}. Create a new preview.`)
      }
      await fs.rename(item.temporaryPath, item.file.path)
      item.committed = true
    }
    return {
      files: plan.files.map((file) => {
        const item = staged.find((candidate) => candidate.file === file)
        return { path: file.path, changed: item !== undefined, backupPath: item?.backupPath ?? null }
      }),
      warnings: [...plan.warnings],
    }
  } catch (error) {
    const rollbackFailures: string[] = []
    for (let index = staged.length - 1; index >= 0; index--) {
      const item = staged[index]
      if (!item.committed) continue
      try {
        await assertPlanParents(plan)
        if ((await readConfigFile(item.file.path)).content !== item.file.after) throw new Error('Changed after commit', { cause: error })
        if (item.file.before === null) {
          await fs.unlink(item.file.path)
        } else {
          const restorePath = `${item.file.path}.customer-glide-${randomUUID()}.tmp`
          try {
            await writeExclusive(restorePath, item.file.before, item.mode)
            await fs.rename(restorePath, item.file.path)
          } finally {
            await fs.unlink(restorePath).catch(() => undefined)
          }
        }
      } catch {
        rollbackFailures.push(item.file.path)
      }
    }
    if (rollbackFailures.length) {
      const backups = staged.flatMap((item) => (item.backupPath === null ? [] : [item.backupPath]))
      throw new Error(
        `Project update failed and some files changed during rollback: ${rollbackFailures.join(', ')}. Review backups: ${backups.join(', ')}`,
        { cause: error },
      )
    }
    if (staged.some((item) => item.committed))
      throw new Error('Project configuration update failed. The files changed by this update were restored.', { cause: error })
    throw error
  } finally {
    for (const item of staged) await fs.unlink(item.temporaryPath).catch(() => undefined)
    if (createdCodexDirectory) await fs.rmdir(path.join(plan.projectPath, '.codex')).catch(() => undefined)
    for (const userLock of userLocks) {
      await userLock.handle.close()
      await fs.unlink(userLock.path)
    }
    await lock.close()
    await fs.unlink(lockPath)
  }
}

/** Restore a plan after a later transaction step fails. Leave backups and later user edits intact. */
export async function rollbackProjectConfig(plan: ProjectConfigPlan): Promise<void> {
  validatePlan(plan)
  await assertPlanParents(plan)
  const lockPath = path.join(plan.projectPath, '.customer-glide-config.lock')
  let lock
  try {
    lock = await fs.open(lockPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
  } catch {
    throw new Error('Could not lock the project for rollback. Review its saved configuration backups.')
  }
  const staged: { file: ProjectConfigFile; temporaryPath: string | null }[] = []
  let userLocks: Awaited<ReturnType<typeof lockUserFiles>> = []
  try {
    userLocks = await lockUserFiles(plan)
    await assertPlanParents(plan)
    const current = await Promise.all(plan.files.map((file) => readConfigFile(file.path)))
    for (const [index, file] of plan.files.entries()) {
      if (current[index].content !== file.before && current[index].content !== file.after) {
        throw new Error(`Refusing to overwrite a later edit during rollback: ${file.path}. Review its saved configuration backups.`)
      }
    }
    for (const [index, file] of plan.files.entries()) {
      if (current[index].content === file.before) continue
      const temporaryPath = file.before === null ? null : `${file.path}.customer-glide-${randomUUID()}.tmp`
      staged.push({ file, temporaryPath })
      if (temporaryPath !== null) await writeExclusive(temporaryPath, file.before!, current[index].mode)
    }
    for (let index = staged.length - 1; index >= 0; index--) {
      const { file, temporaryPath } = staged[index]
      await assertPlanParents(plan)
      if ((await readConfigFile(file.path)).content !== file.after) {
        throw new Error(`Configuration changed during rollback: ${file.path}. Review its saved configuration backups.`)
      }
      if (temporaryPath === null) await fs.unlink(file.path)
      else await fs.rename(temporaryPath, file.path)
    }
  } finally {
    for (const item of staged) {
      if (item.temporaryPath !== null) await fs.unlink(item.temporaryPath).catch(() => undefined)
    }
    for (const userLock of userLocks) {
      await userLock.handle.close()
      await fs.unlink(userLock.path)
    }
    await lock.close()
    await fs.unlink(lockPath)
  }
}
