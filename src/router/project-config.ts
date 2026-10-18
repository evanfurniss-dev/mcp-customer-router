import { constants } from 'node:fs'
import fs from 'node:fs/promises'
import { createHash, randomUUID } from 'node:crypto'
import os from 'node:os'
import path from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { parse as parseToml } from 'smol-toml'

const SERVER_NAME = 'customer-glide'
const MAX_CONFIG_BYTES = 4 * 1024 * 1024

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
}

export interface ProjectConfigPlan {
  projectPath: string
  files: ProjectConfigFile[]
  warnings: string[]
}

export interface ProjectConfigApplyResult {
  files: { path: string; changed: boolean; backupPath: string | null }[]
  warnings: string[]
}

function digest(value: string | null): string | null {
  return value === null ? null : createHash('sha256').update(value).digest('hex')
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

function otherGlideWarnings(servers: ConfigObject, location: string, skipManagedEntry = true): string[] {
  return Object.entries(servers)
    .filter(([name, entry]) => {
      if (name === SERVER_NAME && skipManagedEntry) return false
      if (/glide/i.test(name)) return true
      if (!isObject(entry)) return false
      const candidates = [entry.url, ...(Array.isArray(entry.args) ? entry.args : [])]
      return candidates.some((candidate) => {
        if (typeof candidate !== 'string') return false
        try {
          const hostname = new URL(candidate).hostname.toLowerCase()
          return hostname === 'glideapps.dev' || hostname.endsWith('.glideapps.dev') || hostname.endsWith('.glideapps.com')
        } catch {
          return false
        }
      })
    })
    .map(
      ([name]) =>
        `Other Glide MCP entry ${JSON.stringify(name)} is configured in ${location}. Review its effective scope; it was left unchanged.`,
    )
}

async function globalWarnings(projectPath: string): Promise<string[]> {
  const claudePath = process.env.CLAUDE_CONFIG_DIR
    ? path.join(process.env.CLAUDE_CONFIG_DIR, '.claude.json')
    : path.join(os.homedir(), '.claude.json')
  const codexPath = path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'config.toml')
  const warnings: string[] = []
  for (const [filePath, kind] of [
    [claudePath, 'claude'],
    [codexPath, 'codex'],
  ] as const) {
    try {
      const { content } = await readConfigFile(filePath)
      if (content === null) continue
      const config = parseConfig(content, kind, filePath)
      warnings.push(...otherGlideWarnings(serversIn(config, kind), filePath, false))
      if (kind === 'claude' && isObject(config.projects)) {
        const localProject = config.projects[projectPath]
        if (isObject(localProject)) warnings.push(...otherGlideWarnings(serversIn(localProject, kind), `${filePath} (this project)`, false))
      }
    } catch {
      warnings.push(`Could not inspect MCP entries in ${filePath}. Check that file before enabling this connection.`)
    }
  }
  return warnings
}

function tomlSnippet(entry: { command: string; args: string[] }): string {
  return `# Managed by mcp-customer-router\n[mcp_servers."${SERVER_NAME}"]\ncommand = ${JSON.stringify(entry.command)}\nargs = ${JSON.stringify(entry.args)}\n`
}

/** Plan project settings without writing files or changing client trust. */
export async function planProjectConfig(options: ProjectConfigOptions): Promise<ProjectConfigPlan> {
  validateOptions(options)
  const projectPath = await canonicalProject(options.projectPath)
  await assertConfigParents(projectPath)
  const entries = generateProjectConfigEntry({ ...options, projectPath })
  const files: ProjectConfigFile[] = []
  const warnings: string[] = []
  for (const kind of ['claude', 'codex'] as const) {
    const filePath = path.join(projectPath, kind === 'claude' ? '.mcp.json' : '.codex/config.toml')
    const { content: before } = await readConfigFile(filePath)
    const config = parseConfig(before, kind, filePath)
    const servers = serversIn(config, kind)
    const entry = entries[kind]
    const present = Object.hasOwn(servers, SERVER_NAME)
    if (present && !configEqual(servers[SERVER_NAME], entry)) {
      throw new Error(`The ${SERVER_NAME} entry in ${filePath} differs from this connection. Review the collision before changing it.`)
    }
    warnings.push(...otherGlideWarnings(servers, filePath))
    const generatedSnippet =
      kind === 'claude' ? `${JSON.stringify({ mcpServers: { [SERVER_NAME]: entry } }, null, 2)}\n` : tomlSnippet(entries.codex)
    let after = before ?? ''
    if (!present) {
      if (kind === 'claude') {
        const indentation = before?.match(/\n([\t ]+)"/)?.[1] ?? '  '
        after = `${JSON.stringify({ ...config, mcpServers: { ...servers, [SERVER_NAME]: entry } }, null, indentation)}\n`
      } else {
        after = `${before ?? ''}${before ? (before.endsWith('\n') ? '\n' : '\n\n') : ''}${generatedSnippet}`
      }
      const result = parseConfig(after, kind, filePath)
      if (!configEqual(serversIn(result, kind)[SERVER_NAME], entry)) throw new Error(`Could not safely add the MCP entry to ${filePath}.`)
      const key = kind === 'claude' ? 'mcpServers' : 'mcp_servers'
      const expected = { ...config, [key]: { ...servers, [SERVER_NAME]: entry } }
      if (!configEqual(result, expected)) throw new Error(`Adding the MCP entry would alter other settings in ${filePath}.`)
    }
    files.push({ path: filePath, kind, before, after, sha256: digest(before), generatedSnippet })
  }
  warnings.push(...(await globalWarnings(projectPath)))
  return { projectPath, files, warnings }
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
  }
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
  if (!path.isAbsolute(plan.projectPath) || plan.files.length !== 2) throw new Error('Invalid project configuration plan.')
  for (const [index, file] of plan.files.entries()) {
    if (file.path !== expected[index] || digest(file.before) !== file.sha256) throw new Error('Invalid project configuration plan.')
    parseConfig(file.after, index === 0 ? 'claude' : 'codex', file.path)
  }
}

/** Apply a reviewed in-memory plan with conflict detection, backups, and rollback on a handled failure. */
export async function applyProjectConfig(plan: ProjectConfigPlan): Promise<ProjectConfigApplyResult> {
  validatePlan(plan)
  await assertConfigParents(plan.projectPath)
  const lockPath = path.join(plan.projectPath, '.customer-glide-config.lock')
  let lock
  try {
    lock = await fs.open(lockPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
  } catch {
    throw new Error('Could not acquire the project configuration lock. Another update or an interrupted update may need review.')
  }
  const staged: { file: ProjectConfigFile; temporaryPath: string; backupPath: string | null; mode: number; committed: boolean }[] = []
  let createdCodexDirectory = false
  try {
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
    await assertConfigParents(plan.projectPath)
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
      await assertConfigParents(plan.projectPath)
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
        await assertConfigParents(plan.projectPath)
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
    await lock.close()
    await fs.unlink(lockPath)
  }
}

/** Restore a plan after a later transaction step fails. Leave backups and later user edits intact. */
export async function rollbackProjectConfig(plan: ProjectConfigPlan): Promise<void> {
  validatePlan(plan)
  await assertConfigParents(plan.projectPath)
  const lockPath = path.join(plan.projectPath, '.customer-glide-config.lock')
  let lock
  try {
    lock = await fs.open(lockPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
  } catch {
    throw new Error('Could not lock the project for rollback. Review its saved configuration backups.')
  }
  const staged: { file: ProjectConfigFile; temporaryPath: string | null }[] = []
  try {
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
      await assertConfigParents(plan.projectPath)
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
    await lock.close()
    await fs.unlink(lockPath)
  }
}
