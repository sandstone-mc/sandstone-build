import fs from 'fs'
import os from 'os'
import path from 'path'
import { execSync } from 'child_process'
import chalk from 'chalk-template'

export function hasYarn(): boolean {
  try {
    execSync('yarn --version')
    return true
  } catch (error) {
    return false
  }
}
export function hasPnpm(): boolean {
  try {
    execSync('pnpm --version')
    return true
  } catch (error) {
    return false
  }
}

/**
 * Get the .minecraft path
 */
export function getMinecraftPath(): string {
  function getMCPath(): string {
    switch (os.platform()) {
    case 'win32':
      return path.join(os.homedir(), 'AppData/Roaming/.minecraft')
    case 'darwin':
      return path.join(os.homedir(), 'Library/Application Support/minecraft')
    case 'linux':
    default:
      return path.join(os.homedir(), '.minecraft')
    }
  }

  const mcPath = getMCPath()

  if (!fs.existsSync(mcPath)) {
    throw new Error('Unable to locate the .minecraft folder. Please specify it manually.')
  }

  return mcPath
}

export function getWorldsList(): string[] {
  const mcPath = getMinecraftPath()
  const savesPath = path.join(mcPath, 'saves')

  return fs.readdirSync(
    savesPath,
    { withFileTypes: true }
  ).filter((f) => f.isDirectory).map((f) => f.name)
}

/**
 * @param worldName The name of the world
 * @param minecraftPath The optional location of the .minecraft folder.
 * If left unspecified, the .minecraft will be found automatically.
 */
export function getWorldPath(worldName: string, minecraftPath: string | undefined = undefined): string {
  let mcPath: string

  if (minecraftPath) {
    mcPath = minecraftPath
  } else {
    mcPath = getMinecraftPath()
  }

  const savesPath = path.join(mcPath, 'saves')
  const worldPath = path.join(savesPath, worldName)

  if (!fs.existsSync(worldPath)) {
    const existingWorlds = fs.readdirSync(savesPath, { withFileTypes: true }).filter((f) => f.isDirectory).map((f) => f.name)

    throw new Error(`Unable to locate the "${worldPath}" folder. Word ${worldName} does not exists. List of existing worlds: ${JSON.stringify(existingWorlds, null, 2)}`)
  }

  return worldPath
}

/**
 * Recursively search for a file.
 * Starts in the current folder, and go to the parent, recursively.
 *
 * @param filename the name of the file to resolve
 * @param from the path to start at
 *
 * @return The path on success, `null` if no the file is found in any parent.
 */
export function getFileFolder(filename: string, from = '.'): string | null {
  let fileFolder = path.resolve(from)

  while (!fs.existsSync(path.join(fileFolder, filename))) {
    // Go up 1 folder
    const newFileFolder = path.dirname(fileFolder)

    if (newFileFolder == fileFolder) {
      // If we arrived to the root folder, give up.
      return null
    }

    fileFolder = newFileFolder
  }

  return fileFolder
}

export type ProjectFolders = { absProjectFolder: string, projectFolder: string, rootFolder: string, sandstoneConfigFolder: string }

export function getProjectFolders(projectFolder: string): ProjectFolders {
  const absProjectFolder = path.resolve(projectFolder)

  /// GETTING ALL MANDATORY FILES ///
  // Resolve the location of package.json, in order to get the node_modules folder.
  const rootFolder = getFileFolder('package.json', projectFolder)
  if (!rootFolder) {
    throw new Error(chalk`{red Failed to find {bold package.json} in the "${absProjectFolder}" folder, or in any parent folder.}`)
  }

  // Resolve the location of sandstone.config.ts
  const sandstoneConfigFolder = getFileFolder('sandstone.config.ts', projectFolder)
  if (!sandstoneConfigFolder) {
    throw new Error(chalk`{red Failed to find {bold sandstone.config.ts} in the "${absProjectFolder}" folder, or in any parent folder.}`)
  }

  return {
    absProjectFolder, projectFolder, rootFolder, sandstoneConfigFolder
  }
}

export const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)