class fsClass {
    _rootHandle?: FileSystemDirectoryHandle

    async rootHandle() {
        if (!this._rootHandle) {
            this._rootHandle = await navigator.storage.getDirectory()
        }
        return this._rootHandle;
    }

    async pathExists(path: string) {
        const rootHandle = await this.rootHandle()
        try {
            const folders = path.split('/')

            const last = folders.pop() as string

            let currentHandle = rootHandle

            for (const folder of folders) {
                currentHandle = await currentHandle.getDirectoryHandle(folder, { create: false })
            }

            try {
                await currentHandle.getFileHandle(last, { create: false })

                return true
            } catch (e) {
                await currentHandle.getDirectoryHandle(last, { create: false })

                return true
            }
        } catch (e) {
            return false
        }
    }

    async ensureDir(path: string) {
        const rootHandle = await this.rootHandle()
        const folders = path.split('/')

        let currentHandle = rootHandle

        for (const folder of folders) {
            currentHandle = await currentHandle.getDirectoryHandle(folder, { create: true })
        }

        return currentHandle
    }

    async writeFile(path: string, content: string | Buffer) {
        const rootHandle = await this.rootHandle()
        const folders = path.split('/')

        const file = folders.pop() as string

        let currentHandle = rootHandle

        for (const folder of folders) {
            currentHandle = await currentHandle.getDirectoryHandle(folder, { create: true })
        }

        const fileHandle = await currentHandle.getFileHandle(file, { create: true })

        const writable = await fileHandle.createWritable()

        if (typeof content === 'string') {
            await writable.write(content)
        } else {
            await writable.write(content.buffer)
        }
    }

    async readFile(path: string | File, encoding?: 'utf-8') {
        let fileContents: File = path as File

        if (typeof path === 'string') {
            const rootHandle = await this.rootHandle()
            const folders = path.split('/')

            const file = folders.pop() as string

            let currentHandle = rootHandle

            for (const folder of folders) {
                currentHandle = await currentHandle.getDirectoryHandle(folder, { create: false })
            }

            const fileHandle = await currentHandle.getFileHandle(file, { create: false })

            fileContents = await fileHandle.getFile()
        }

        if (encoding === undefined || encoding === 'utf-8') {
            return await fileContents.text()
        } else {
            return await fileContents.arrayBuffer()
        }
    }

    async readdir(path: string) {
        const rootHandle = await this.rootHandle()
        const folders = path.split('/')

        let currentHandle = rootHandle

        for (const folder of folders) {
            currentHandle = await currentHandle.getDirectoryHandle(folder, { create: false })
        }

        const entries: string[] = []

        for await (const entry of currentHandle.values()) {
            entries.push(entry.name)
        }

        return entries
    }

    async remove(path: string) {
        const rootHandle = await this.rootHandle()
        const folders = path.split('/')

        const file = folders.pop() as string

        let currentHandle = rootHandle

        for (const folder of folders) {
            currentHandle = await currentHandle.getDirectoryHandle(folder, { create: false })
        }

        try {
            const fileHandle = await currentHandle.getFileHandle(file, { create: false })

            await currentHandle.removeEntry(fileHandle.name)
        } catch (e) {
            const dirHandle = await currentHandle.getDirectoryHandle(file, { create: false })

            await currentHandle.removeEntry(dirHandle.name, { recursive: true })
        }
    }

    get walk () {
        const fs = this

        async function* walker(path: string, options?: { filter?: (path: string) => boolean }): AsyncGenerator<{ path: string, file: () => Promise<string | ArrayBuffer> }> {
            const rootHandle = await fs.rootHandle()
            const folders = path.split('/')

            let currentHandle = rootHandle

            for (const folder of folders) {
                currentHandle = await currentHandle.getDirectoryHandle(folder, { create: false })
            }

            const entries: [string, FileSystemHandleKind][] = []

            for await (const entry of currentHandle.values()) {
                entry.kind
                entries.push([entry.name, entry.kind])
            }

            for await (const [entry, type] of entries) {
                if (options?.filter && !options.filter(path + '/' + entry)) {
                    continue
                }
                if (type === 'file') {
                    const fileHandle = await currentHandle.getFileHandle(entry, { create: false })

                    const out = {
                        path: path + '/' + entry,
                        file: async () => await fs.readFile(await fileHandle.getFile())
                    }

                    yield out
                } else {
                    await currentHandle.getDirectoryHandle(entry, { create: false })

                    const newWalker = walker(path + '/' + entry)

                    for await (const entry of newWalker) {
                        yield entry
                    }
                }
            }
        }

        return walker
    }
}

export const fs = new fsClass()