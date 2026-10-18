import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { parse as parseToml } from 'smol-toml'
import {
  applyProjectConfig,
  generateProjectConfigEntry,
  planProjectConfig,
  projectConfigPreview,
  rollbackProjectConfig,
  type ProjectConfigOptions,
} from './project-config'

const customerId = '53b4c035-d4ad-4861-ab89-675b164363d2'
let temporary: string
let options: ProjectConfigOptions
let claudeGlobal: string
let codexGlobal: string

beforeEach(async () => {
  temporary = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'customer-project-config-')))
  const projectPath = path.join(temporary, 'project with spaces')
  await fs.mkdir(projectPath)
  claudeGlobal = path.join(temporary, 'claude-global')
  codexGlobal = path.join(temporary, 'codex-global')
  await fs.mkdir(claudeGlobal)
  await fs.mkdir(codexGlobal)
  vi.stubEnv('CLAUDE_CONFIG_DIR', claudeGlobal)
  vi.stubEnv('CODEX_HOME', codexGlobal)
  options = {
    projectPath,
    customerId,
    home: path.join(temporary, 'router-home'),
    cliPath: path.join(temporary, 'app', 'dist', 'router-cli.js'),
    nodePath: process.execPath,
  }
})

afterEach(async () => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  await fs.rm(temporary, { recursive: true, force: true })
})

async function writeProject(claude: string, codex: string): Promise<void> {
  await fs.writeFile(path.join(options.projectPath, '.mcp.json'), claude)
  await fs.mkdir(path.join(options.projectPath, '.codex'), { recursive: true })
  await fs.writeFile(path.join(options.projectPath, '.codex', 'config.toml'), codex)
}

describe('project configuration plans', () => {
  it('uses canonical project paths and argument arrays for both clients without writing during preview', async () => {
    const aliasPath = path.join(temporary, 'project-link')
    await fs.symlink(options.projectPath, aliasPath)
    const plan = await planProjectConfig({ ...options, projectPath: aliasPath })
    const expectedArgs = [options.cliPath, 'serve', '--customer', customerId, '--project', options.projectPath, '--home', options.home]
    expect(plan.projectPath).toBe(options.projectPath)
    expect(JSON.parse(plan.files[0].after).mcpServers['customer-glide']).toEqual({
      type: 'stdio',
      command: process.execPath,
      args: expectedArgs,
    })
    expect((parseToml(plan.files[1].after).mcp_servers as Record<string, unknown>)['customer-glide']).toEqual({
      command: process.execPath,
      args: expectedArgs,
    })
    expect(plan.files.every((file) => file.before === null && file.sha256 === null)).toBe(true)
    expect(await fs.readdir(options.projectPath)).toEqual([])
  })

  it('preserves unrelated values and TOML comments and excludes existing secrets from the safe preview', async () => {
    const claude = JSON.stringify({
      customSetting: { retained: true },
      mcpServers: { documentation: { type: 'http', url: 'https://example.test/mcp', headers: { Authorization: 'private-claude-value' } } },
    })
    const codex =
      '# Keep this comment\nmodel = "existing-model"\n\n[mcp_servers.documentation]\nurl = "https://example.test/mcp" # keep inline\nhttp_headers = { Authorization = "private-codex-value" }\n'
    await writeProject(claude, codex)
    const plan = await planProjectConfig(options)
    expect(plan.files[1].after.startsWith(codex)).toBe(true)
    expect(JSON.parse(plan.files[0].after).customSetting).toEqual({ retained: true })
    expect(JSON.parse(plan.files[0].after).mcpServers.documentation).toEqual(JSON.parse(claude).mcpServers.documentation)
    expect(parseToml(plan.files[1].after).model).toBe('existing-model')
    const preview = JSON.stringify(projectConfigPreview(plan))
    expect(preview).not.toContain('private-claude-value')
    expect(preview).not.toContain('private-codex-value')
    expect(preview).not.toContain('before')
    expect(preview).not.toContain('after')
    expect(await fs.readFile(plan.files[0].path, 'utf8')).toBe(claude)
    expect(await fs.readFile(plan.files[1].path, 'utf8')).toBe(codex)
  })

  it.each(['claude', 'codex'])('refuses a colliding %s alias without disclosing its credentials', async (kind) => {
    await writeProject(
      kind === 'claude' ? '{"mcpServers":{"customer-glide":{"command":"existing","env":{"SECRET":"do-not-disclose"}}}}' : '{}',
      kind === 'codex' ? '[mcp_servers.customer-glide]\ncommand = "existing"\nsecret = "do-not-disclose"\n' : '',
    )
    let message = ''
    try {
      await planProjectConfig(options)
    } catch (error) {
      message = (error as Error).message
    }
    expect(message).toContain('differs from this connection')
    expect(message).not.toContain('do-not-disclose')
  })

  it('refuses to silently rebind an existing alias to a different customer', async () => {
    await applyProjectConfig(await planProjectConfig(options))
    await expect(planProjectConfig({ ...options, customerId: 'ca40a2cf-0da7-44e4-9313-8926c0e42b45' })).rejects.toThrow(
      'differs from this connection',
    )
  })

  it('reports other Glide entries in the project, global settings, and Claude private project settings', async () => {
    await writeProject('{"mcpServers":{"glide-project":{"url":"https://mcp.glideapps.dev/mcp?secret=private-value"}}}', '')
    await fs.writeFile(
      path.join(claudeGlobal, '.claude.json'),
      JSON.stringify({
        mcpServers: { glideos: { url: 'https://mcp.glideapps.dev/mcp', headers: { Authorization: 'private-value' } } },
        projects: { [options.projectPath]: { mcpServers: { 'customer-glide': { command: 'existing' } } } },
      }),
    )
    await fs.writeFile(
      path.join(codexGlobal, 'config.toml'),
      '[mcp_servers.other-name]\nurl = "https://mcp.glideapps.dev/mcp?secret=private-value"\n',
    )
    const plan = await planProjectConfig(options)
    expect(plan.warnings).toHaveLength(4)
    expect(plan.warnings.join(' ')).toContain('glide-project')
    expect(plan.warnings.join(' ')).toContain('customer-glide')
    expect(plan.warnings.join(' ')).toContain('other-name')
    expect(plan.warnings.join(' ')).not.toContain('private-value')
  })

  it('redacts parse errors and fails safely when appending would extend an inline TOML table', async () => {
    await writeProject('{}', 'mcp_servers = { docs = { command = "private-inline-value" } }\n')
    await expect(planProjectConfig(options)).rejects.toThrow('Cannot parse TOML')
    expect(await fs.readFile(path.join(options.projectPath, '.codex', 'config.toml'), 'utf8')).toContain('private-inline-value')
    await fs.writeFile(path.join(options.projectPath, '.codex', 'config.toml'), '')
    await fs.writeFile(path.join(claudeGlobal, '.claude.json'), '{"secret":"private-malformed-value"')
    const plan = await planProjectConfig(options)
    expect(plan.warnings).toHaveLength(1)
    expect(plan.warnings[0]).not.toContain('private-malformed-value')
  })

  it('validates IDs and executable paths without shell interpolation', () => {
    expect(() => generateProjectConfigEntry({ ...options, customerId: '../../other' })).toThrow('UUID')
    expect(() => generateProjectConfigEntry({ ...options, cliPath: 'relative.js' })).toThrow('absolute path')
    const entry = generateProjectConfigEntry({ ...options, cliPath: '/tmp/a "quoted" $literal.js' })
    expect(entry.codex.args[0]).toBe('/tmp/a "quoted" $literal.js')
  })
})

describe('applying project configuration', () => {
  it.each([false, true])('rolls back a completed plan without deleting backups (existing files: %s)', async (existing) => {
    if (existing) await writeProject('{}\n', '# original\n')
    const plan = await planProjectConfig(options)
    const result = await applyProjectConfig(plan)
    await rollbackProjectConfig(plan)
    for (const file of plan.files) {
      const observed = await fs.readFile(file.path, 'utf8').catch((error) => {
        if (error.code === 'ENOENT') return null
        throw error
      })
      expect(observed).toBe(file.before)
    }
    for (const file of result.files.filter((item) => item.backupPath !== null)) {
      expect((await fs.stat(file.backupPath!)).isFile()).toBe(true)
    }
    await expect(rollbackProjectConfig(plan)).resolves.toBeUndefined()
  })

  it('refuses a later user edit before restoring either file', async () => {
    await writeProject('{}\n', '# original\n')
    const plan = await planProjectConfig(options)
    await applyProjectConfig(plan)
    await fs.writeFile(plan.files[0].path, '{"later":"edit"}\n')
    await expect(rollbackProjectConfig(plan)).rejects.toThrow('later edit')
    expect(await fs.readFile(plan.files[0].path, 'utf8')).toBe('{"later":"edit"}\n')
    expect(await fs.readFile(plan.files[1].path, 'utf8')).toBe(plan.files[1].after)
  })

  it('refuses a symlink introduced before rollback without changing its target', async () => {
    const plan = await planProjectConfig(options)
    await applyProjectConfig(plan)
    const outside = path.join(temporary, 'outside-config')
    await fs.writeFile(outside, '{}')
    await fs.unlink(plan.files[0].path)
    await fs.symlink(outside, plan.files[0].path)
    await expect(rollbackProjectConfig(plan)).rejects.toThrow(/symbolic link/i)
    expect(await fs.readFile(outside, 'utf8')).toBe('{}')
    expect(await fs.readFile(plan.files[1].path, 'utf8')).toBe(plan.files[1].after)
  })

  it('backs up existing files with private permissions and is idempotent for repeated apply and fresh plans', async () => {
    await writeProject('{"mcpServers":{}}\n', '# existing\n')
    const plan = await planProjectConfig(options)
    const result = await applyProjectConfig(plan)
    for (const [index, file] of result.files.entries()) {
      expect(file.changed).toBe(true)
      expect(file.backupPath).not.toBeNull()
      expect(await fs.readFile(file.path, 'utf8')).toBe(plan.files[index].after)
      expect(await fs.readFile(file.backupPath!, 'utf8')).toBe(plan.files[index].before)
      expect((await fs.stat(file.backupPath!)).mode & 0o777).toBe(0o600)
    }
    expect((await applyProjectConfig(plan)).files.every((file) => !file.changed)).toBe(true)
    const nextPlan = await planProjectConfig(options)
    expect(nextPlan.files.every((file) => file.before === file.after)).toBe(true)
    expect((await applyProjectConfig(nextPlan)).files.every((file) => !file.changed)).toBe(true)
    expect((await fs.readdir(options.projectPath)).filter((name) => name.endsWith('.lock') || name.endsWith('.tmp'))).toEqual([])
  })

  it('detects an edit after preview before changing either file', async () => {
    await writeProject('{}\n', '# original\n')
    const plan = await planProjectConfig(options)
    await fs.writeFile(plan.files[1].path, '# user edit\n')
    await expect(applyProjectConfig(plan)).rejects.toThrow('changed after preview')
    expect(await fs.readFile(plan.files[0].path, 'utf8')).toBe('{}\n')
    expect(await fs.readFile(plan.files[1].path, 'utf8')).toBe('# user edit\n')
    expect((await fs.readdir(options.projectPath)).some((name) => name.endsWith('.bak'))).toBe(false)
  })

  it.each([false, true])('restores the first file when the second replacement fails (existing files: %s)', async (existing) => {
    if (existing) await writeProject('{}\n', '# original\n')
    const plan = await planProjectConfig(options)
    const realRename = fs.rename.bind(fs)
    let failed = false
    vi.spyOn(fs, 'rename').mockImplementation(async (source, target) => {
      if (target === plan.files[1].path && !failed) {
        failed = true
        throw Object.assign(new Error('Simulated disk failure'), { code: 'EIO' })
      }
      return realRename(source, target)
    })
    await expect(applyProjectConfig(plan)).rejects.toThrow('were restored')
    for (const file of plan.files) {
      const observed = await fs.readFile(file.path, 'utf8').catch((error) => {
        if (error.code === 'ENOENT') return null
        throw error
      })
      expect(observed).toBe(file.before)
    }
    expect((await fs.readdir(options.projectPath)).some((name) => name.endsWith('.tmp') || name.endsWith('.lock'))).toBe(false)
  })

  it('does not erase an external edit during rollback and identifies the saved backup', async () => {
    await writeProject('{}\n', '# original\n')
    const plan = await planProjectConfig(options)
    const realRename = fs.rename.bind(fs)
    vi.spyOn(fs, 'rename').mockImplementation(async (source, target) => {
      if (target === plan.files[1].path) {
        await fs.writeFile(plan.files[0].path, '{"external":"edit"}\n')
        throw Object.assign(new Error('Simulated failure'), { code: 'EIO' })
      }
      return realRename(source, target)
    })
    await expect(applyProjectConfig(plan)).rejects.toThrow('Review backups:')
    expect(await fs.readFile(plan.files[0].path, 'utf8')).toBe('{"external":"edit"}\n')
  })

  it.each(['claude-file', 'codex-file', 'codex-directory'])('refuses a %s symbolic link', async (scenario) => {
    const outside = path.join(temporary, 'outside')
    await fs.mkdir(outside)
    await fs.writeFile(path.join(outside, 'config'), scenario === 'claude-file' ? '{}' : '')
    if (scenario === 'claude-file') await fs.symlink(path.join(outside, 'config'), path.join(options.projectPath, '.mcp.json'))
    else if (scenario === 'codex-directory') await fs.symlink(outside, path.join(options.projectPath, '.codex'))
    else {
      await fs.mkdir(path.join(options.projectPath, '.codex'))
      await fs.symlink(path.join(outside, 'config'), path.join(options.projectPath, '.codex', 'config.toml'))
    }
    await expect(planProjectConfig(options)).rejects.toThrow(/symbolic link/i)
    expect(await fs.readFile(path.join(outside, 'config'), 'utf8')).toBe(scenario === 'claude-file' ? '{}' : '')
  })

  it('rechecks symbolic links after preview', async () => {
    const plan = await planProjectConfig(options)
    const outside = path.join(temporary, 'outside')
    await fs.mkdir(outside)
    await fs.symlink(outside, path.join(options.projectPath, '.codex'))
    await expect(applyProjectConfig(plan)).rejects.toThrow(/symbolic link/i)
    expect(await fs.readdir(outside)).toEqual([])
    await expect(fs.stat(plan.files[0].path)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('refuses concurrent updates when the project lock already exists', async () => {
    const plan = await planProjectConfig(options)
    await fs.writeFile(path.join(options.projectPath, '.customer-glide-config.lock'), '')
    await expect(applyProjectConfig(plan)).rejects.toThrow('configuration lock')
    expect(await fs.readdir(options.projectPath)).toEqual(['.customer-glide-config.lock'])
  })
})
