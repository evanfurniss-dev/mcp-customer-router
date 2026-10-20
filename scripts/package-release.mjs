import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const readJson = async (file) => JSON.parse(await fs.readFile(file, 'utf8'))
const inside = (parent, file) => {
  const relative = path.relative(parent, file)
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
}

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, stdio: 'inherit', env: { ...process.env, COPYFILE_DISABLE: '1' } })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`${command} failed (${result.status ?? result.signal}).`)
}

async function copyFile(source, destination) {
  if (!(await fs.lstat(source)).isFile()) throw new Error(`Expected a regular file: ${source}`)
  await fs.mkdir(path.dirname(destination), { recursive: true })
  await fs.copyFile(source, destination)
}

async function copyBuild(source, destination, extensions) {
  if (!(await fs.lstat(source)).isDirectory()) throw new Error(`Expected a build directory: ${source}`)
  await fs.mkdir(destination, { recursive: true })
  for (const entry of await fs.readdir(source, { withFileTypes: true })) {
    const from = path.join(source, entry.name)
    const to = path.join(destination, entry.name)
    if (entry.name.startsWith('.') || entry.isSymbolicLink()) throw new Error(`Unexpected build entry: ${from}`)
    if (entry.isDirectory()) await copyBuild(from, to, extensions)
    else if (entry.isFile()) {
      if (entry.name.endsWith('.map') || entry.name.endsWith('.d.ts')) continue
      if (!extensions.has(path.extname(entry.name)) || /\.(test|spec)\./.test(entry.name)) {
        throw new Error(`Unexpected build file: ${from}`)
      }
      await copyFile(from, to)
    } else throw new Error(`Unsupported build entry: ${from}`)
  }
}

async function resolvePackage(from, name, optional = false) {
  for (let directory = from; ; directory = path.dirname(directory)) {
    const candidate = path.join(directory, 'node_modules', name)
    try {
      const real = await fs.realpath(candidate)
      await fs.access(path.join(real, 'package.json'))
      return real
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }
    if (path.dirname(directory) === directory) break
  }
  if (optional) return null
  throw new Error(`Dependency ${name} is not installed under ${from}. Run the locked installs first.`)
}

async function licenseFiles(directory, prefix = '') {
  const files = []
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    if (!/^(licen[cs]es?|copying|notices?)(?:[._-].*)?$/i.test(entry.name)) continue
    const relative = path.join(prefix, entry.name)
    const absolute = path.join(directory, entry.name)
    if (entry.isFile()) {
      const content = await fs.readFile(absolute, 'utf8')
      if (content.trim()) files.push({ path: relative, content })
    } else if (entry.isDirectory()) {
      for (const nested of await fs.readdir(absolute, { withFileTypes: true })) {
        if (nested.isFile()) {
          const content = await fs.readFile(path.join(absolute, nested.name), 'utf8')
          if (content.trim()) files.push({ path: path.join(relative, nested.name), content })
        }
      }
    } else throw new Error(`Unsupported license entry: ${absolute}`)
  }
  return files.sort((a, b) => a.path.localeCompare(b.path))
}

async function dependencyNotices(sections) {
  const packages = new Map()
  const visited = new Set()
  async function visit(directory, section) {
    const key = `${section}:${directory}`
    if (visited.has(key)) return
    visited.add(key)
    const manifest = await readJson(path.join(directory, 'package.json'))
    if (!manifest.name || !manifest.version) throw new Error(`Missing package identity: ${directory}`)
    const identity = `${manifest.name}@${manifest.version}`
    let entry = packages.get(identity)
    if (!entry) {
      const licenses = await licenseFiles(directory)
      if (!licenses.some((file) => /^(licen[cs]e|copying)/i.test(file.path))) {
        throw new Error(`No LICENSE or COPYING text found for ${identity}. Review its terms before packaging.`)
      }
      entry = { manifest, licenses, sections: new Set() }
      packages.set(identity, entry)
    }
    entry.sections.add(section)
    const names = new Set([
      ...Object.keys(manifest.dependencies || {}),
      ...Object.keys(manifest.optionalDependencies || {}),
      ...Object.keys(manifest.peerDependencies || {}),
    ])
    for (const name of [...names].sort()) {
      const optional = Object.hasOwn(manifest.optionalDependencies || {}, name) || manifest.peerDependenciesMeta?.[name]?.optional === true
      const dependency = await resolvePackage(directory, name, optional)
      if (dependency) await visit(dependency, section)
    }
  }
  for (const { name, directory, dependencies } of sections) {
    for (const dependency of dependencies) await visit(await resolvePackage(directory, dependency), name)
  }
  let text = 'THIRD-PARTY NOTICES\n\n'
  text += 'License text from the installed frontend and bundled bridge dependency graphs. Installed peers are included conservatively.\n'
  text +=
    'Production Node dependencies retain their license files inside node_modules. COSS registry attribution is in COSS-REGISTRY-MIT.txt.\n\n'
  for (const [identity, { manifest, licenses, sections: groups }] of [...packages].sort(([a], [b]) => a.localeCompare(b))) {
    text += `${'='.repeat(72)}\n${identity}\nUsed by: ${[...groups].sort().join(', ')}\n`
    text += `Declared license: ${typeof manifest.license === 'string' ? manifest.license : JSON.stringify(manifest.license ?? manifest.licenses ?? 'unspecified')}\n\n`
    for (const file of licenses) text += `--- ${file.path} ---\n${file.content}${file.content.endsWith('\n') ? '' : '\n'}\n`
  }
  return text
}

async function checkLinks(directory, archiveRoot) {
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name)
    if (entry.isSymbolicLink()) {
      const target = await fs.readlink(file)
      if (path.isAbsolute(target) || !inside(archiveRoot, await fs.realpath(file))) {
        throw new Error(`Release symlink escapes its portable tree: ${file}`)
      }
    } else if (entry.isDirectory()) await checkLinks(file, archiveRoot)
    else if (path.basename(directory) === '.bin') throw new Error(`Expected a portable executable symlink: ${file}`)
    else if (!entry.isFile()) throw new Error(`Unsupported release entry: ${file}`)
  }
}

async function main() {
  const manifest = await readJson(path.join(root, 'package.json'))
  if (manifest.private !== true) throw new Error('The repository package.json must remain private.')
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(manifest.version)) throw new Error('Invalid release version.')
  for (const file of ['dist/router-cli.js', 'dist/router-connection.js', 'web/dist/index.html']) {
    await fs.access(path.join(root, file))
  }
  const webManifest = await readJson(path.join(root, 'web/package.json'))
  const notices = await dependencyNotices([
    { name: 'frontend', directory: path.join(root, 'web'), dependencies: Object.keys(webManifest.dependencies || {}).sort() },
    {
      name: 'bundled bridge',
      directory: root,
      dependencies: ['@modelcontextprotocol/client', '@modelcontextprotocol/core', '@modelcontextprotocol/server', 'zod'],
    },
  ])
  const releaseName = `mcp-customer-router-${manifest.version}`
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-customer-router-release-'))
  try {
    const stage = path.join(temporary, releaseName)
    await fs.mkdir(stage)
    await copyFile(path.join(root, 'package.json'), path.join(stage, 'package.json'))
    await copyFile(path.join(root, 'pnpm-lock.yaml'), path.join(stage, 'pnpm-lock.yaml'))
    run(
      'pnpm',
      [
        'install',
        '--prod',
        '--frozen-lockfile',
        '--ignore-scripts',
        '--package-import-method=copy',
        '--config.prefer-symlinked-executables=true',
        '--store-dir',
        path.join(temporary, 'store'),
      ],
      stage,
    )
    for (const file of [
      'pnpm-lock.yaml',
      'node_modules/.modules.yaml',
      'node_modules/.pnpm/lock.yaml',
      'node_modules/.pnpm-workspace-state-v1.json',
    ]) {
      await fs.rm(path.join(stage, file), { force: true })
    }
    const shippedManifest = {
      name: manifest.name,
      version: manifest.version,
      description: manifest.description,
      private: true,
      type: 'module',
      license: manifest.license,
      author: manifest.author,
      repository: manifest.repository,
      engines: manifest.engines,
      bin: { 'mcp-customer-router': 'dist/router-cli.js' },
      dependencies: manifest.dependencies,
    }
    await fs.writeFile(path.join(stage, 'package.json'), `${JSON.stringify(shippedManifest, null, 2)}\n`)
    await copyBuild(path.join(root, 'dist'), path.join(stage, 'dist'), new Set(['.js', '.cjs', '.mjs', '.json', '.wasm', '.node']))
    await copyBuild(
      path.join(root, 'web/dist'),
      path.join(stage, 'web/dist'),
      new Set(['.html', '.js', '.css', '.svg', '.png', '.jpg', '.jpeg', '.webp', '.ico', '.woff', '.woff2']),
    )
    await copyBuild(path.join(root, 'web/licenses'), path.join(stage, 'web/licenses'), new Set(['.txt', '.md', '']))
    for (const file of [
      'README.md',
      'LICENSE',
      'docs/UPSTREAM-README.md',
      'docs/UI-SOURCES.md',
      'docs/VERIFICATION.md',
      'docs/RELEASING.md',
      'docs/RELEASE-NOTES.md',
    ]) {
      await copyFile(path.join(root, file), path.join(stage, file))
    }
    await fs.writeFile(path.join(stage, 'web/licenses/THIRD-PARTY-NOTICES.txt'), notices)
    await fs.chmod(path.join(stage, 'dist/router-cli.js'), 0o755)
    await checkLinks(stage, await fs.realpath(stage))
    const archiveName = `${releaseName}.tar.gz`
    const archive = path.join(temporary, archiveName)
    run('tar', ['-czf', archive, '-C', temporary, releaseName], root)
    const hash = createHash('sha256')
    for await (const chunk of createReadStream(archive)) hash.update(chunk)
    const checksum = hash.digest('hex')
    const template = await fs.readFile(path.join(root, 'packaging/mcp-customer-router.rb.in'), 'utf8')
    if (!template.includes('@@VERSION@@') || !template.includes('@@SHA256@@'))
      throw new Error('Formula template is missing release placeholders.')
    const formula = template.replaceAll('@@VERSION@@', manifest.version).replaceAll('@@SHA256@@', checksum)
    if (/@@[A-Z0-9_]+@@/.test(formula)) throw new Error('Formula template has unresolved placeholders.')
    await fs.writeFile(path.join(temporary, `${archiveName}.sha256`), `${checksum}  ${archiveName}\n`)
    await fs.writeFile(path.join(temporary, 'mcp-customer-router.rb'), formula)
    const output = path.join(root, 'release')
    await fs.mkdir(output, { recursive: true })
    if (!(await fs.lstat(output)).isDirectory()) throw new Error('release/ must be a regular directory.')
    for (const file of [archiveName, `${archiveName}.sha256`, 'mcp-customer-router.rb']) {
      await fs.rename(path.join(temporary, file), path.join(output, file))
    }
    console.log(`Created release/${archiveName}\nSHA-256: ${checksum}\nCreated release/mcp-customer-router.rb`)
  } finally {
    await fs.rm(temporary, { recursive: true, force: true })
  }
}

main().catch((error) => {
  console.error(error.message)
  process.exitCode = 1
})
