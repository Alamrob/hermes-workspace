import { open, readFile, rename, stat, unlink } from 'node:fs/promises'
import { dirname } from 'node:path'

const EXACT_PATH = '/var/lib/proptimiza-telegram/cursor.json'

export class FileTelegramCursorStore {
  constructor(private readonly path = EXACT_PATH) {
    if (path !== EXACT_PATH) throw new Error('TELEGRAM_CURSOR_PATH_INVALID')
  }

  async load(): Promise<number> {
    await this.assertDirectory()
    try {
      const metadata = await stat(this.path)
      if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.uid !== 10016 || metadata.gid !== 10016 ||
          (metadata.mode & 0o777) !== 0o600 || metadata.size < 1 || metadata.size > 256)
        throw new Error('TELEGRAM_CURSOR_FILE_INVALID')
      const parsed = JSON.parse(await readFile(this.path, 'utf8')) as unknown
      if (!record(parsed) || JSON.stringify(Object.keys(parsed).sort()) !== JSON.stringify(['next_offset', 'schema_version']) ||
          parsed.schema_version !== '1.0' || !Number.isSafeInteger(parsed.next_offset) || (parsed.next_offset as number) < 0)
        throw new Error('TELEGRAM_CURSOR_CONTENT_INVALID')
      return parsed.next_offset as number
    } catch (error) {
      if (record(error) && error.code === 'ENOENT') return 0
      throw error
    }
  }

  async save(nextOffset: number): Promise<void> {
    if (!Number.isSafeInteger(nextOffset) || nextOffset < 0)
      throw new Error('TELEGRAM_CURSOR_INVALID')
    await this.assertDirectory()
    const temporary = `${this.path}.tmp.${process.pid}.${crypto.randomUUID()}`
    let created = false
    try {
      const handle = await open(temporary, 'wx', 0o600)
      created = true
      try {
        await handle.writeFile(`${JSON.stringify({ schema_version: '1.0', next_offset: nextOffset })}\n`, 'utf8')
        await handle.sync()
      } finally {
        await handle.close()
      }
      await rename(temporary, this.path)
      created = false
      const directory = await open(dirname(this.path), 'r')
      try { await directory.sync() } finally { await directory.close() }
    } finally {
      if (created) await unlink(temporary).catch(() => undefined)
    }
  }

  private async assertDirectory(): Promise<void> {
    const metadata = await stat(dirname(this.path))
    if (!metadata.isDirectory() || metadata.isSymbolicLink() || metadata.uid !== 10016 || metadata.gid !== 10016 ||
        (metadata.mode & 0o777) !== 0o700)
      throw new Error('TELEGRAM_CURSOR_DIRECTORY_INVALID')
  }
}

function record(value: unknown): value is Record<string, any> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
