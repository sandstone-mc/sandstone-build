import path from 'path'
import { pathToFileURL } from 'url'
import PrettyError from 'pretty-error'
import walk from 'klaw'
import { register as tsEval } from 'ts-node'

import chalk from 'chalk'
import AdmZip from 'adm-zip'
import deleteEmpty from 'delete-empty'
import { fs } from './opfs.js'


type ProjectFolders = { absProjectFolder: string, projectFolder: string, rootFolder: string, sandstoneConfigFolder: string }

type BuildOptions = {
  // Flags
  dry?: boolean
  verbose?: boolean
  root?: boolean
  fullTrace?: boolean
  strictErrors?: boolean
  production?: boolean

  // Values
  path: string
  configPath: string
  name?: string
  namespace?: string

  dependencies?: [string, string][]
}

const pe = new PrettyError()

type SaveFileObject = {
  relativePath: string
  content: any
  contentSummary: string
}

/**
 * Build the project, but might throw errors.
 *
 * @param cliOptions The options to build the project with.
 *
 * @param projectFolder The folder of the project. It needs a sandstone.config.ts, and it or one of its parent needs a package.json.
 */
async function _buildProject(cliOptions: BuildOptions, { absProjectFolder, projectFolder, rootFolder, sandstoneConfigFolder }: ProjectFolders) {

  // Register ts-node
  const tsConfigPath = path.join(rootFolder, 'tsconfig.json')

  tsEval({
    transpileOnly: !cliOptions.strictErrors,
    project: tsConfigPath,
  })

  // First, read sandstone.config.ts to get all properties
  const sandstoneConfig = (await import(pathToFileURL(path.join(sandstoneConfigFolder, 'sandstone.config.ts')).toString())).default

  const { scripts } = sandstoneConfig

  let { saveOptions } = sandstoneConfig

  if (saveOptions === undefined) saveOptions = {}

  const outputFolder = path.join(rootFolder, '.sandstone', 'output')

  /// OPTIONS ///

  let worldName: undefined | string = saveOptions.world
  if (worldName) {
    throw new Error('Client export is unsupported in the browser.')
  }

  const root = cliOptions.root !== undefined ? cliOptions.root : saveOptions.root

  if (root) {
    throw new Error('Client export is unsupported in the browser.')
  }

  const packName: string = cliOptions.name ?? sandstoneConfig.name

  // Important /!\: The below if statements, which set environment variables, must run before importing any Sandstone file.

  // Set the pack ID environment variable

  // Set production/development mode
  if (cliOptions.production) {
    process.env.SANDSTONE_ENV = 'production'
  } else {
    process.env.SANDSTONE_ENV = 'development'
  }

  process.env.WORKING_DIR = absProjectFolder

  if (sandstoneConfig.packUid) {
    process.env.PACK_UID = sandstoneConfig.packUid
  }

  // Set the namespace
  const namespace = cliOptions.namespace || sandstoneConfig.namespace
  if (namespace) {
    process.env.NAMESPACE = namespace
  }

  if (sandstoneConfig.onConflict) {
    for (const resource of Object.entries(sandstoneConfig.onConflict)) {
      process.env[`${resource[0].toUpperCase()}_CONFLICT_STRATEGY`] = resource[1] as string
    }
  }

  // JSON indentation
  process.env.INDENTATION = saveOptions.indentation

  // Pack mcmeta
  process.env.PACK_OPTIONS = JSON.stringify(sandstoneConfig.packs)

  // Configure error display
  if (!cliOptions.fullTrace) {
    pe.skipNodeFiles()
  }

  /// IMPORTING USER CODE ///
  // The configuration is ready.

  // Now, let's run the beforeAll script
  await scripts?.beforeAll?.()

  // Finally, let's import from the index.
  let error = false

  let sandstonePack: any

  const filePath = path.join(projectFolder, 'index.ts')

  try {
    // Sometimes, a file might not exist because it has been deleted.
    if (await fs.pathExists(filePath)) {
      sandstonePack = (await import(pathToFileURL(filePath).toString())).default
    }
  }
  catch (e: any) {
    logError(e, absProjectFolder)
    error = true
  }

  if (error) {
    return
  }

  /// Add new dependencies ///
  if (cliOptions.dependencies) {
    for (const dependency of cliOptions.dependencies) {
      sandstonePack.core.depend(...dependency)
    }
  }

  /// SAVING RESULTS ///

  // Save the pack

  // Run the beforeSave script (TODO: This is where sandstone-server will remove restart env vars)
  await scripts?.beforeSave?.()

  const excludeOption = saveOptions.resources?.exclude

  const fileExclusions = excludeOption ? {
    generated: (excludeOption.generated || excludeOption) as RegExp[] | undefined,
    existing: (excludeOption.existing || excludeOption) as RegExp[] | undefined
  } : false

  const fileHandlers = saveOptions.resources?.handle as ({ path: RegExp, callback: (contents: string | Buffer | Promise<Buffer>) => Promise<Buffer> })[] || false

  const packTypes = await sandstonePack.save({
    // Additional parameters
    dry: cliOptions.dry,
    verbose: cliOptions.verbose,

    fileHandler: saveOptions.customFileHandler ?? (async (relativePath: string, content: any) => {
      let pathPass = true
      if (fileExclusions && fileExclusions.generated) {
        for (const exclude of fileExclusions.generated) {
          if (!Array.isArray(exclude)) {
            pathPass = !exclude.test(relativePath)
          }
        }
      }

      if (fileHandlers) {
        for (const handler of fileHandlers) {
          if (handler.path.test(relativePath)) {
            content = await handler.callback(content)
          }
        }
      }

      if (pathPass) {
        const realPath = path.join(outputFolder, relativePath)

        await fs.ensureDir(realPath.replace(/(?:\/|\\)(?:.(?!(?:\/|\\)))+$/, ''))
        return await fs.writeFile(realPath, content)
      }
    })
  })

  async function handleResources(packType: string) {
    const working = path.join(rootFolder, 'resources', packType)

    let exists = await fs.pathExists(working)

    if (exists) {
      for await (const file of walk(path.join(rootFolder, 'resources', packType), { filter: (_path) => {
        const relativePath = path.join(packType, _path.split(working)[1])
        let pathPass = true
        if (fileExclusions && fileExclusions.existing) {
          for (const exclude of fileExclusions.existing) {
            pathPass = Array.isArray(exclude) ? !exclude[0].test(relativePath) : !exclude.test(relativePath)
          }
        }
        return pathPass
      }})) {
        const relativePath = path.join(packType, file.path.split(working)[1])

        try {
          let content = Buffer.from(await fs.readFile(file.path))

          if (fileHandlers) {
            for (const handler of fileHandlers) {
              if (handler.path.test(relativePath)) {
                content = await handler.callback(content)
              }
            }
          }

          const realPath = path.join(outputFolder, relativePath)

          await fs.ensureDir(realPath.replace(/(?:\/|\\)(?:.(?!(?:\/|\\)))+$/, ''))
          await fs.writeFile(realPath, content)
        } catch (e) {}
      }
    }
  }

  async function archiveOutput(packType: any) {
    const input = path.join(outputFolder, packType.type)

    if ((await fs.readdir(input)).length !== 0) {
      const archive = new AdmZip()

      await archive.addLocalFolderPromise(input, {})

      await archive.writeZipPromise(`${path.join(outputFolder, 'archives', `${packName}_${packType.type}`)}.zip`, { overwrite: true })

      return true
    }

    return false
  }

  // TODO: implement linking to make the cache more useful when not archiving.
  if (!cliOptions.production) {
    for await (const _packType of packTypes) {
      const packType = _packType[1]
      const outputPath = path.join(outputFolder, packType.type)

      await fs.ensureDir(outputPath)

      if (packType.handleOutput) {
        await packType.handleOutput(
          'output',
          async (relativePath: string, encoding: 'utf-8' | undefined = 'utf-8') => await fs.readFile(path.join(outputPath, relativePath), encoding),
          async (relativePath: string, contents: any) => {
            if (contents === undefined) {
              await fs.remove(path.join(outputPath, relativePath))
            } else {
              await fs.writeFile(path.join(outputPath, relativePath), contents)
            }
          }
        )
      }

      await handleResources(packType.type)

      if (packType.archiveOutput) {
        await archiveOutput(packType)
      }
    }
  } else {
    for await (const packType of packTypes) {
      const outputPath = path.join(outputFolder, packType.type)

      if (packType.handleOutput) {
        await packType.handleOutput(
          'output',
          async (relativePath: string, encoding: 'utf-8' | undefined = 'utf-8') => await fs.readFile(path.join(outputPath, relativePath), encoding),
          async (relativePath: string, contents: any) => {
            if (contents === undefined) {
              await fs.remove(path.join(outputPath, relativePath))
            } else {
              await fs.writeFile(path.join(outputPath, relativePath), contents)
            }
          }
        )
      }

      await handleResources(packType.type)

      if (packType.archiveOutput) {
        archiveOutput(packType)
      }
    }
  }

  await deleteEmpty(outputFolder)

  // Run the afterAll script
  await scripts?.afterAll?.()

  console.log('\nPack(s) compiled! View output in ./.sandstone/output/\n')
}

/**
 * Build the project. Will log errors and never throw any.
 *
 * @param options The options to build the project with.
 *
 * @param projectFolder The folder of the project. It needs a sandstone.config.ts, and it or one of its parent needs a package.json.
 */
export async function buildProject(options: BuildOptions, folders: ProjectFolders) {
  try {
    await _buildProject(options, folders)
  }
  catch (err: any) {
    console.log(err)
  }
}

function logError(err?: Error, file?: string) {
  if (err) {
    if (file) {
      console.error(
        '  ' + chalk.bgRed.white('BuildError') + chalk.gray(':'),
        `While loading "${file}", the following error happened:\n`
      )
    }
    debugger
    console.error(pe.render(err))
  }
}

buildProject(JSON.parse(process.env.CLI_OPTIONS as string), JSON.parse(process.env.PROJECT_FOLDERS as string) as ProjectFolders);