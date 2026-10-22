import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { parse as parseToml, stringify as stringifyToml } from 'smol-toml'
import {
  applyProjectConfig,
  generateProjectConfigEntry,
  planProjectConfig,
  projectConfigPreview,
  reviewProjectConnections,
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
  vi.stubEnv('HOME', temporary)
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

  it('updates only old generated runtime paths for the same binding and backs up both files', async () => {
    const previous = generateProjectConfigEntry({ ...options, cliPath: '/old/source/dist/router-cli.js', nodePath: '/old/bin/node' })
    const claudeBefore = JSON.stringify({ theme: 'preserve', mcpServers: { 'customer-glide': previous.claude, docs: { command: 'keep' } } })
    const codexBefore =
      '# Keep this comment\nmodel = "same"\n' +
      stringifyToml({ mcp_servers: { 'customer-glide': previous.codex, docs: { command: 'keep' } } })
    await writeProject(claudeBefore, codexBefore)
    const plan = await planProjectConfig(options)
    expect(await fs.readFile(plan.files[0].path, 'utf8')).toBe(claudeBefore)
    expect(await fs.readFile(plan.files[1].path, 'utf8')).toBe(codexBefore)
    const generated = generateProjectConfigEntry(options)
    expect(JSON.parse(plan.files[0].after).mcpServers['customer-glide']).toEqual(generated.claude)
    expect(JSON.parse(plan.files[0].after).theme).toBe('preserve')
    expect((parseToml(plan.files[1].after).mcp_servers as Record<string, unknown>)['customer-glide']).toEqual(generated.codex)
    expect(plan.files[1].after).toContain('# Keep this comment')
    expect(parseToml(plan.files[1].after).model).toBe('same')
    expect(JSON.stringify(projectConfigPreview(plan))).not.toContain('/old/source')
    const applied = await applyProjectConfig(plan)
    expect(applied.files.every((file) => file.changed && file.backupPath !== null)).toBe(true)
    for (const file of applied.files) {
      expect(await fs.readFile(file.backupPath!, 'utf8')).toBe(plan.files.find((source) => source.path === file.path)!.before)
      expect((await fs.stat(file.backupPath!)).mode & 0o777).toBe(0o600)
    }
    expect((await planProjectConfig(options)).files.every((file) => file.before === file.after)).toBe(true)
  })

  describe.each(['claude', 'codex'] as const)('%s runtime migration', (kind) => {
    it.each([
      'customer',
      'project',
      'home',
      'extra-argument',
      'environment',
      'extra-field',
      'other-executable',
      'other-script',
      'relative-executable',
      'relative-script',
    ])('refuses a changed %s', async (change) => {
      const previous = generateProjectConfigEntry({ ...options, cliPath: '/old/source/dist/router-cli.js', nodePath: '/old/bin/node' })
      const entry: { command: string; args: string[]; [key: string]: unknown } = { ...previous[kind], args: [...previous[kind].args] }
      if (change === 'customer') entry.args[3] = 'ca40a2cf-0da7-44e4-9313-8926c0e42b45'
      if (change === 'project') entry.args[5] = '/another/project'
      if (change === 'home') entry.args[7] = '/another/router-home'
      if (change === 'extra-argument') entry.args.push('--extra')
      if (change === 'environment') entry.env = { SECRET: 'do-not-disclose' }
      if (change === 'extra-field') entry.extra = 'do-not-disclose'
      if (change === 'other-executable') entry.command = '/old/bin/python'
      if (change === 'other-script') entry.args[0] = '/old/source/dist/other.js'
      if (change === 'relative-executable') entry.command = 'node'
      if (change === 'relative-script') entry.args[0] = 'router-cli.js'
      const claude = kind === 'claude' ? JSON.stringify({ mcpServers: { 'customer-glide': entry } }) : '{}'
      const codex = kind === 'codex' ? stringifyToml({ mcp_servers: { 'customer-glide': entry } }) : ''
      await writeProject(claude, codex)
      await expect(planProjectConfig(options)).rejects.toThrow('differs from this connection')
      expect(await fs.readFile(path.join(options.projectPath, '.mcp.json'), 'utf8')).toBe(claude)
      expect(await fs.readFile(path.join(options.projectPath, '.codex/config.toml'), 'utf8')).toBe(codex)
    })
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
    expect(plan.warnings).toEqual([])
    expect(plan.connections).toHaveLength(4)
    expect(plan.connections.map((entry) => [entry.name, entry.scope])).toEqual([
      ['glide-project', 'project'],
      ['glideos', 'user'],
      ['customer-glide', 'project-private'],
      ['other-name', 'user'],
    ])
    expect(JSON.stringify(projectConfigPreview(plan))).not.toContain('private-value')
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

describe('reviewing existing connections', () => {
  it('removes selected project and user entries, keeps ignored entries, preserves unrelated settings, and backs up every changed file', async () => {
    const projectToml =
      '# Keep model comment\nmodel = "same"\n[mcp_servers.glideos]\nurl = "https://mcp.glideapps.dev/mcp"\n[mcp_servers.glideos.http_headers]\nAuthorization = "secret-a"\n\n# Keep docs comment\n[mcp_servers.docs]\nurl = "https://example.test/mcp" # keep inline\n'
    await writeProject('{"mcpServers":{"glide-keep":{"url":"https://mcp.glideapps.dev/mcp"}}}', projectToml)
    const globalPath = path.join(claudeGlobal, '.claude.json')
    const originalGlobal = JSON.stringify({
      other: { preserved: true },
      mcpServers: { glideos: { url: 'https://mcp.glideapps.dev/mcp', env: { SECRET: 'secret-b' } } },
      projects: {
        [options.projectPath]: { allowedTools: ['existing'], mcpServers: { 'private-glide': { command: 'private' } } },
        elsewhere: { mcpServers: { glideos: { command: 'keep' } } },
      },
    })
    await fs.writeFile(globalPath, originalGlobal)
    const plan = await planProjectConfig(options)
    const reviewed = reviewProjectConnections(
      plan,
      plan.connections.map((entry) => ({ id: entry.id, action: entry.name === 'glide-keep' ? 'ignore' : 'remove' })),
    )
    const result = await applyProjectConfig(reviewed)
    expect(JSON.parse(await fs.readFile(plan.files[0].path, 'utf8')).mcpServers['glide-keep']).toBeDefined()
    const codex = await fs.readFile(plan.files[1].path, 'utf8')
    expect(codex).not.toContain('secret-a')
    expect(codex).toContain('# Keep model comment')
    expect(codex).toContain('# Keep docs comment')
    expect(codex).toContain('# keep inline')
    expect((parseToml(codex).mcp_servers as Record<string, unknown>).glideos).toBeUndefined()
    const global = JSON.parse(await fs.readFile(globalPath, 'utf8'))
    expect(global.mcpServers).toEqual({})
    expect(global.projects[options.projectPath]).toEqual({ allowedTools: ['existing'], mcpServers: {} })
    expect(global.projects.elsewhere.mcpServers.glideos.command).toBe('keep')
    expect(global.other).toEqual({ preserved: true })
    for (const file of result.files) {
      expect(file.backupPath).not.toBeNull()
      expect((await fs.stat(file.backupPath!)).mode & 0o777).toBe(0o600)
      expect(await fs.readFile(file.backupPath!, 'utf8')).toBe(reviewed.files.find((item) => item.path === file.path)!.before)
    }
    await rollbackProjectConfig(reviewed)
    expect(await fs.readFile(globalPath, 'utf8')).toBe(originalGlobal)
    expect(await fs.readFile(plan.files[1].path, 'utf8')).toBe(projectToml)
  })

  it('preserves all existing connections for legacy callers that do not request removals', async () => {
    const original = '{"mcpServers":{"glideos":{"command":"keep"}}}'
    await fs.writeFile(path.join(claudeGlobal, '.claude.json'), original)
    const plan = await planProjectConfig(options)
    await applyProjectConfig(plan)
    expect(await fs.readFile(path.join(claudeGlobal, '.claude.json'), 'utf8')).toBe(original)
  })

  it('rejects missing decisions, duplicate IDs, and forged IDs and paths, while allowing explicit user-scope router removal', async () => {
    await fs.writeFile(path.join(claudeGlobal, '.claude.json'), '{"mcpServers":{"customer-glide":{"command":"existing"}}}')
    const plan = await planProjectConfig(options)
    const connection = plan.connections[0]
    expect(connection.removable).toBe(true)
    expect(() => reviewProjectConnections(plan, undefined)).toThrow('Choose Remove or Ignore')
    expect(() =>
      reviewProjectConnections(plan, [
        { id: connection.id, action: 'ignore' },
        { id: connection.id, action: 'ignore' },
      ]),
    ).toThrow('Invalid')
    expect(() => reviewProjectConnections(plan, [{ id: '/tmp/arbitrary', action: 'remove' }])).toThrow('not part of this preview')
    expect(() => reviewProjectConnections(plan, [{ id: connection.id, action: 'ignore', filePath: '/tmp/arbitrary' }])).toThrow('Invalid')
    expect(() => reviewProjectConnections({ ...plan }, [])).toThrow('Invalid project configuration plan')
    expect(Object.isFrozen(plan)).toBe(true)
    expect(Object.isFrozen(plan.connections[0])).toBe(true)
    await applyProjectConfig(reviewProjectConnections(plan, [{ id: connection.id, action: 'remove' }]))
    expect(JSON.parse(await fs.readFile(path.join(claudeGlobal, '.claude.json'), 'utf8')).mcpServers).toEqual({})
    expect(JSON.parse(await fs.readFile(plan.files[0].path, 'utf8')).mcpServers['customer-glide']).toBeDefined()
  })

  it('refuses an inline TOML removal while still offering Ignore', async () => {
    await fs.writeFile(
      path.join(codexGlobal, 'config.toml'),
      'mcp_servers = { glideos = { url = "https://mcp.glideapps.dev/mcp" }, docs = { command = "keep" } }\n',
    )
    const plan = await planProjectConfig(options)
    expect(plan.connections[0].removable).toBe(false)
    expect(() => reviewProjectConnections(plan, [{ id: plan.connections[0].id, action: 'remove' }])).toThrow('manual edit')
    await applyProjectConfig(reviewProjectConnections(plan, [{ id: plan.connections[0].id, action: 'ignore' }]))
    expect(await fs.readFile(path.join(codexGlobal, 'config.toml'), 'utf8')).toContain('glideos =')
  })

  it('preserves header-like text inside multiline TOML strings and handles quoted dotted names', async () => {
    const source =
      'instructions = """\n[mcp_servers.glideos]\nkeep this text\n"""\n[mcp_servers."glide.old"]\nurl = "https://mcp.glideapps.dev/mcp"\n\n# unrelated\n[mcp_servers.other]\ncommand = "keep"\n'
    await fs.writeFile(path.join(codexGlobal, 'config.toml'), source)
    const plan = await planProjectConfig(options)
    await applyProjectConfig(
      reviewProjectConnections(
        plan,
        plan.connections.map((entry) => ({ id: entry.id, action: 'remove' })),
      ),
    )
    const after = await fs.readFile(path.join(codexGlobal, 'config.toml'), 'utf8')
    expect(after).toContain('[mcp_servers.glideos]\nkeep this text')
    expect(after).toContain('# unrelated')
    expect(after).not.toContain('[mcp_servers."glide.old"]')
  })

  it('stops before any write when a selected user file changed after preview', async () => {
    const globalPath = path.join(claudeGlobal, '.claude.json')
    await fs.writeFile(globalPath, '{"mcpServers":{"glideos":{"command":"existing"}}}')
    const plan = await planProjectConfig(options)
    const reviewed = reviewProjectConnections(
      plan,
      plan.connections.map((entry) => ({ id: entry.id, action: 'remove' })),
    )
    const later = '{"mcpServers":{"glideos":{"command":"later"}}}'
    await fs.writeFile(globalPath, later)
    await expect(applyProjectConfig(reviewed)).rejects.toThrow('changed after preview')
    expect(await fs.readdir(options.projectPath)).toEqual([])
    expect(await fs.readFile(globalPath, 'utf8')).toBe(later)
  })

  it('lists a shared project and CODEX_HOME file once and removes its entry once', async () => {
    await writeProject('{}', '[mcp_servers.glideos]\nurl = "https://mcp.glideapps.dev/mcp"\n')
    vi.stubEnv('CODEX_HOME', path.join(options.projectPath, '.codex'))
    const plan = await planProjectConfig(options)
    expect(plan.connections).toHaveLength(1)
    expect(plan.connections[0].scope).toBe('project')
    const reviewed = reviewProjectConnections(plan, [{ id: plan.connections[0].id, action: 'remove' }])
    await applyProjectConfig(reviewed)
    const servers = parseToml(await fs.readFile(path.join(options.projectPath, '.codex/config.toml'), 'utf8')).mcp_servers as Record<
      string,
      unknown
    >
    expect(servers.glideos).toBeUndefined()
    expect(servers['customer-glide']).toBeDefined()
  })

  it.each(['file', 'directory'])('refuses a user configuration %s replaced by a symlink after preview', async (target) => {
    const globalPath = path.join(codexGlobal, 'config.toml')
    const original = '[mcp_servers.glideos]\ncommand = "existing"\n'
    await fs.writeFile(globalPath, original)
    const plan = await planProjectConfig(options)
    const reviewed = reviewProjectConnections(
      plan,
      plan.connections.map((entry) => ({ id: entry.id, action: 'remove' })),
    )
    const outside = path.join(temporary, 'outside-global')
    await fs.mkdir(outside)
    await fs.writeFile(path.join(outside, 'config.toml'), original)
    if (target === 'file') {
      await fs.unlink(globalPath)
      await fs.symlink(path.join(outside, 'config.toml'), globalPath)
    } else {
      await fs.rename(codexGlobal, `${codexGlobal}-original`)
      await fs.symlink(outside, codexGlobal)
    }
    await expect(applyProjectConfig(reviewed)).rejects.toThrow(/symbolic link|directory changed/)
    expect(await fs.readdir(options.projectPath)).toEqual([])
    expect(await fs.readFile(path.join(outside, 'config.toml'), 'utf8')).toBe(original)
    expect(await fs.readdir(outside)).toEqual(['config.toml'])
  })

  it('restores the project and earlier user file when the last user file replacement fails', async () => {
    await fs.writeFile(path.join(claudeGlobal, '.claude.json'), '{"mcpServers":{"glideos":{"command":"existing"}}}')
    const failingPath = path.join(codexGlobal, 'config.toml')
    await fs.writeFile(failingPath, '[mcp_servers.glideos]\ncommand = "existing"\n')
    const plan = await planProjectConfig(options)
    const reviewed = reviewProjectConnections(
      plan,
      plan.connections.map((entry) => ({ id: entry.id, action: 'remove' })),
    )
    const realRename = fs.rename.bind(fs)
    vi.spyOn(fs, 'rename').mockImplementation(async (source, target) => {
      if (target === failingPath) throw new Error('Simulated failure')
      return realRename(source, target)
    })
    await expect(applyProjectConfig(reviewed)).rejects.toThrow('were restored')
    for (const file of reviewed.files) expect(await fs.readFile(file.path, 'utf8').catch(() => null)).toBe(file.before)
  })

  it.runIf(process.platform === 'darwin')(
    'detects and removes Claude desktop entries without touching other desktop settings',
    async () => {
      const desktop = path.join(temporary, 'Library/Application Support/Claude/claude_desktop_config.json')
      await fs.mkdir(path.dirname(desktop), { recursive: true })
      await fs.writeFile(desktop, '{"mcpServers":{"glideos":{"command":"existing"}},"preferences":{"keep":true}}')
      const plan = await planProjectConfig(options)
      expect(plan.connections).toEqual([expect.objectContaining({ filePath: desktop, client: 'claude', scope: 'user' })])
      await applyProjectConfig(reviewProjectConnections(plan, [{ id: plan.connections[0].id, action: 'remove' }]))
      expect(JSON.parse(await fs.readFile(desktop, 'utf8'))).toEqual({ mcpServers: {}, preferences: { keep: true } })
    },
  )
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
