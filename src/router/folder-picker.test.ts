import { execFile } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { chooseProjectFolder } from './folder-picker'

vi.mock('node:child_process', () => ({ execFile: vi.fn() }))

const platform = Object.getOwnPropertyDescriptor(process, 'platform')!
const homes: string[] = []

function commandResult(stdout: string, error: Error | null = null) {
  vi.mocked(execFile).mockImplementation((...args: unknown[]) => {
    const callback = args[3] as (error: Error | null, stdout: string) => void
    callback(error, stdout)
    return {} as ReturnType<typeof execFile>
  })
}

beforeEach(() => {
  Object.defineProperty(process, 'platform', { ...platform, value: 'darwin' })
  vi.mocked(execFile).mockReset()
})

afterEach(async () => {
  Object.defineProperty(process, 'platform', platform)
  await Promise.all(homes.splice(0).map((home) => fs.rm(home, { recursive: true, force: true })))
})

describe('native project folder chooser', () => {
  it('returns the canonical selected directory with whitespace preserved and uses a fixed bounded command', async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), 'router-picker-'))
    homes.push(home)
    const directory = path.join(home, 'project with\na newline ')
    const alias = path.join(home, 'folder alias')
    await fs.mkdir(directory)
    await fs.symlink(directory, alias)
    commandResult(`${alias}/\n`)
    const controller = new AbortController()

    expect(await chooseProjectFolder(controller.signal)).toBe(await fs.realpath(directory))
    expect(execFile).toHaveBeenCalledWith(
      '/usr/bin/osascript',
      ['-l', 'AppleScript', '-e', expect.stringContaining('choose folder')],
      { encoding: 'utf8', timeout: 120_000, killSignal: 'SIGKILL', maxBuffer: 16_384, signal: controller.signal },
      expect.any(Function),
    )
    expect(await fs.readdir(directory)).toEqual([])
  })

  it('returns null when the user cancels', async () => {
    commandResult('\n')
    expect(await chooseProjectFolder()).toBeNull()
  })

  it('passes cancellation to the native process and treats the abort as cancellation', async () => {
    const controller = new AbortController()
    vi.mocked(execFile).mockImplementation((...args: unknown[]) => {
      const { signal } = args[2] as { signal: AbortSignal }
      const callback = args[3] as (error: Error, stdout: string) => void
      expect(signal).toBe(controller.signal)
      signal.addEventListener('abort', () => callback(new Error('Aborted'), ''), { once: true })
      return {} as ReturnType<typeof execFile>
    })
    const selected = chooseProjectFolder(controller.signal)
    controller.abort()
    expect(await selected).toBeNull()
    expect(await chooseProjectFolder(controller.signal)).toBeNull()
    expect(execFile).toHaveBeenCalledOnce()
  })

  it('rejects a file or a relative result instead of returning it as a project directory', async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), 'router-picker-'))
    homes.push(home)
    const file = path.join(home, 'file')
    await fs.writeFile(file, 'fixture')
    commandResult(`${file}\n`)
    await expect(chooseProjectFolder()).rejects.toThrow('Choose an existing folder')
    commandResult('relative/folder\n')
    await expect(chooseProjectFolder()).rejects.toThrow('Choose an existing folder')
  })

  it('returns a safe actionable error without exposing osascript diagnostics', async () => {
    commandResult('', new Error('private command diagnostics'))
    await expect(chooseProjectFolder()).rejects.toMatchObject({
      status: 500,
      message: 'Could not open the folder chooser. Run the router in a local Mac session, or enter the project path.',
    })
  })

  it('reports a killed chooser as a timeout', async () => {
    commandResult('', Object.assign(new Error('Command killed'), { killed: true }))
    await expect(chooseProjectFolder()).rejects.toMatchObject({ status: 408, message: expect.stringContaining('timed out') })
  })

  it('offers manual entry on other operating systems without launching a process', async () => {
    Object.defineProperty(process, 'platform', { ...platform, value: 'linux' })
    await expect(chooseProjectFolder()).rejects.toMatchObject({ status: 501, message: expect.stringContaining('Enter the project path') })
    expect(execFile).not.toHaveBeenCalled()
  })
})
