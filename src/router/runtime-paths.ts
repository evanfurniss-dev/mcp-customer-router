import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { UserError } from './types'

interface RuntimePaths {
  nodePath: string
  cliPath: string
  connectionPath: string
  webPath: string
}

const paths = new Map<string, RuntimePaths>()

function stableNodePath(nodePath: string): string {
  const actual = fs.realpathSync(nodePath)
  for (const candidate of ['/opt/homebrew/bin/node', '/usr/local/bin/node', '/usr/bin/node']) {
    try {
      if (fs.realpathSync(candidate) === actual) return candidate
    } catch {
      /* Try the next installed location. */
    }
  }
  return nodePath
}

function absolutePath(value: unknown): value is string {
  return typeof value === 'string' && path.isAbsolute(value) && !Array.from(value).some((character) => character.charCodeAt(0) < 32)
}

/** Keep installer-supplied opt paths stable after Homebrew replaces or removes the running version. */
export function resolveRuntimePaths(
  cliPath = fileURLToPath(new URL('./router-cli.js', import.meta.url)),
  nodePath = process.execPath,
): RuntimePaths {
  const key = JSON.stringify([cliPath, nodePath])
  const cached = paths.get(key)
  if (cached) return cached
  let content: string | undefined
  try {
    content = fs.readFileSync(path.join(path.dirname(cliPath), 'install-paths.json'), 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw new UserError('Could not read the router installation paths. Reinstall the router.')
    }
  }
  if (content === undefined) {
    nodePath = stableNodePath(nodePath)
  } else {
    try {
      const installed: unknown = JSON.parse(content)
      if (
        !installed ||
        typeof installed !== 'object' ||
        !('nodePath' in installed) ||
        !('cliPath' in installed) ||
        !absolutePath(installed.nodePath) ||
        !absolutePath(installed.cliPath) ||
        !installed.cliPath.endsWith('.js')
      ) {
        throw new Error('Invalid installation paths')
      }
      nodePath = installed.nodePath
      cliPath = installed.cliPath
    } catch {
      throw new UserError('The router installation paths are invalid. Reinstall the router.')
    }
  }
  const resolved = {
    nodePath,
    cliPath,
    connectionPath: path.join(path.dirname(cliPath), 'router-connection.js'),
    webPath: path.resolve(path.dirname(cliPath), '../web/dist'),
  }
  paths.set(key, resolved)
  return resolved
}
