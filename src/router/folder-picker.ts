import { execFile } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'
import { UserError } from './types'

// Activate this process through AppKit. Finder and System Events need no Automation permission.
const PICK_FOLDER_SCRIPT = `use framework "AppKit"
use scripting additions
set pickerApplication to current application's NSApplication's sharedApplication()
pickerApplication's setActivationPolicy:1
pickerApplication's |activate|()
try
  set selectedFolder to choose folder with prompt "Choose the project folder for Claude Code and Codex." without multiple selections allowed
  return POSIX path of selectedFolder
on error number -128
  return ""
end try`

export async function chooseProjectFolder(signal?: AbortSignal): Promise<string | null> {
  if (signal?.aborted) return null
  if (process.platform !== 'darwin') {
    throw new UserError('The folder chooser is available on macOS. Enter the project path instead.', 501)
  }
  const output = await new Promise<string>((resolve, reject) => {
    execFile(
      '/usr/bin/osascript',
      ['-l', 'AppleScript', '-e', PICK_FOLDER_SCRIPT],
      { encoding: 'utf8', timeout: 120_000, killSignal: 'SIGKILL', maxBuffer: 16_384, signal },
      (error, stdout) => {
        if (signal?.aborted) {
          resolve('')
          return
        }
        if (error) {
          reject(
            new UserError(
              error.killed
                ? 'The folder chooser timed out. Choose the folder again, or enter its path.'
                : 'Could not open the folder chooser. Run the router in a local Mac session, or enter the project path.',
              error.killed ? 408 : 500,
            ),
          )
        } else resolve(stdout)
      },
    )
  })
  // osascript adds one output newline. Preserve spaces and newlines inside folder names.
  const selected = output.replace(/\r?\n$/, '')
  if (selected === '') return null
  try {
    if (!path.isAbsolute(selected) || selected.includes('\0')) throw new Error()
    const canonical = await fs.realpath(selected)
    if (!(await fs.stat(canonical)).isDirectory()) throw new Error()
    return canonical
  } catch {
    throw new UserError('The selected folder is unavailable. Choose an existing folder, or enter its path.')
  }
}
