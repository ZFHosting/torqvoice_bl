/**
 * Files an import brings over (docs/fork/milestones/M3-extract-and-stage.md, task 5): order files,
 * inspection photos and Shopmonkey's invoice PDFs, downloaded into a staging area beside the uploads
 * (`dataRoot()/shopmonkey-staging/<connectionId>/<table>/`). M5 moves them into uploads.
 *
 * A link comes from Shopmonkey's data, and the server fetches it, so it is checked the way webhook
 * targets are: https only, no private, loopback or metadata address (the connection's own lookup
 * refuses one, so a name can't answer differently for the check and the connection), redirects followed
 * by hand and checked again, a time limit, a size cap and the same content types the upload route takes.
 * PROVISIONAL(M0:S4): whether a file `url` downloads without the API key is open; links on Shopmonkey's
 * own API origin go through the read-only client instead (see engine.ts).
 */
import { createHash, randomUUID } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { mkdir, rename, rm, writeFile } from 'node:fs/promises'
import type { IncomingMessage } from 'node:http'
import { request as httpsGet } from 'node:https'
import { type LookupAddress, lookup as dnsLookup } from 'node:dns'
import path from 'node:path'
import { checkWebhookUrl, isPrivateAddress } from '@/features/webhooks/Lib/ssrf'
import { dataRoot } from '@/lib/upload-root'

/** What the service upload route accepts (`api/protected/upload/service-files`), so M5 can attach it. */
export const STAGED_FILE_TYPES: ReadonlySet<string> = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'application/pdf',
  'text/csv',
  'text/plain',
  'video/mp4',
  'video/webm',
  'video/quicktime',
])

/** The upload route's own cap. */
export const MAX_STAGED_FILE_BYTES = 500 * 1024 * 1024
/** An invoice PDF is read into memory; anything larger isn't an invoice. */
export const MAX_PDF_BYTES = 25 * 1024 * 1024
const TIMEOUT_MS = 120_000
const MAX_REDIRECTS = 3

const EXTENSIONS: Record<string, string> = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'application/pdf': '.pdf',
  'text/csv': '.csv',
  'text/plain': '.txt',
  'video/mp4': '.mp4',
  'video/webm': '.webm',
  'video/quicktime': '.mov',
}

export type StagedFile =
  | {
      /** Relative to `dataRoot()`. */
      path: string
      bytes: number
      sha256: string
      contentType: string
    }
  | { skipped: 'too_large' | 'content_type' | 'not_found' | 'refused_url' }

export interface FileStager {
  /** A file Shopmonkey links to, downloaded into the staging area. */
  fetchUrl(table: string, remoteId: string, url: string): Promise<StagedFile>
  /** Bytes already in hand (an invoice PDF read through the client). */
  write(
    table: string,
    remoteId: string,
    bytes: Uint8Array | null,
    contentType: string | null
  ): Promise<StagedFile>
}

/** `image/jpeg; charset=…` → `image/jpeg`. */
export function baseType(contentType: string | null): string {
  return (contentType ?? '').split(';')[0].trim().toLowerCase()
}

export function stagingDir(connectionId: string, root = dataRoot()): string {
  return path.join(root, 'shopmonkey-staging', connectionId)
}

/** A file name from an id: nothing that could climb out of the folder. */
function safeName(remoteId: string, contentType: string): string {
  const id = remoteId.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 120) || 'file'
  return `${id}${EXTENSIONS[contentType] ?? ''}`
}

class PrivateAddressError extends Error {
  code = 'EPRIVATEADDRESS'
}

/** The connection's own DNS lookup, refusing a private, loopback or link-local answer. */
function guardedLookup(
  hostname: string,
  options: { all?: boolean; family?: number },
  callback: (
    err: NodeJS.ErrnoException | null,
    address: string | LookupAddress[],
    family?: number
  ) => void
): void {
  dnsLookup(hostname, { all: true, family: options.family ?? 0 }, (err, addresses) => {
    if (err) return callback(err, [])
    const allowPrivate = process.env.WEBHOOKS_ALLOW_PRIVATE_TARGETS === 'true'
    if (!addresses.length) return callback(new Error('No address'), [])
    if (!allowPrivate && addresses.some((a) => isPrivateAddress(a.address))) {
      return callback(new PrivateAddressError('resolves_private'), [])
    }
    if (options.all) return callback(null, addresses)
    return callback(null, addresses[0].address, addresses[0].family)
  })
}

/** An https GET whose connection resolves through `guardedLookup` (callers refuse anything but https). */
function get(url: URL, signal: AbortSignal): Promise<IncomingMessage> {
  return new Promise((resolve, reject) => {
    const req = httpsGet(
      url,
      { method: 'GET', signal, lookup: guardedLookup as never, headers: { accept: '*/*' } },
      resolve
    )
    req.on('error', reject)
    req.end()
  })
}

export interface FileStagerOptions {
  connectionId: string
  /** `dataRoot()` unless a test says otherwise. */
  root?: string
  /** How a URL is fetched; the guarded https GET unless a test says otherwise. */
  open?: (url: URL, signal: AbortSignal) => Promise<IncomingMessage>
  check?: (url: string) => Promise<{ ok: boolean }>
}

export function createFileStager(options: FileStagerOptions): FileStager {
  const root = options.root ?? dataRoot()
  const dir = stagingDir(options.connectionId, root)
  const open = options.open ?? get
  const check = options.check ?? ((url: string) => checkWebhookUrl(url))

  async function target(table: string, remoteId: string, contentType: string) {
    const folder = path.join(dir, table.replace(/[^a-z_]/g, '_'))
    await mkdir(folder, { recursive: true, mode: 0o700 })
    const file = path.join(folder, safeName(remoteId, contentType))
    return { file, relative: path.relative(root, file).split(path.sep).join('/') }
  }

  return {
    async write(table, remoteId, bytes, contentType) {
      const type = baseType(contentType)
      if (!bytes) return { skipped: 'too_large' }
      if (!STAGED_FILE_TYPES.has(type)) return { skipped: 'content_type' }
      const { file, relative } = await target(table, remoteId, type)
      const temp = `${file}.${randomUUID()}.part`
      await writeFile(temp, bytes, { mode: 0o600 })
      await rename(temp, file)
      return {
        path: relative,
        bytes: bytes.byteLength,
        sha256: createHash('sha256').update(bytes).digest('hex'),
        contentType: type,
      }
    },

    async fetchUrl(table, remoteId, url) {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
      try {
        let current = url
        for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
          const parsed = new URL(current)
          if (parsed.protocol !== 'https:' || !(await check(current)).ok) {
            return { skipped: 'refused_url' }
          }
          const res = await open(parsed, controller.signal)
          const status = res.statusCode ?? 0
          if (status >= 300 && status < 400) {
            res.destroy()
            const location = res.headers.location
            if (!location) return { skipped: 'not_found' }
            current = new URL(location, current).toString()
            continue
          }
          if (status === 404 || status === 410) {
            res.destroy()
            return { skipped: 'not_found' }
          }
          if (status < 200 || status >= 300) {
            res.destroy()
            // Worth another try later: the step fails and the job runner retries it.
            throw new Error(`A staged file answered ${status}`)
          }
          const type = baseType(res.headers['content-type'] ?? null)
          if (!STAGED_FILE_TYPES.has(type)) {
            res.destroy()
            return { skipped: 'content_type' }
          }
          const declared = Number(res.headers['content-length'])
          if (Number.isFinite(declared) && declared > MAX_STAGED_FILE_BYTES) {
            res.destroy()
            return { skipped: 'too_large' }
          }
          const { file, relative } = await target(table, remoteId, type)
          const temp = `${file}.${randomUUID()}.part`
          const hash = createHash('sha256')
          let total = 0
          const out = createWriteStream(temp, { mode: 0o600 })
          try {
            for await (const chunk of res) {
              const buffer = chunk as Buffer
              total += buffer.byteLength
              if (total > MAX_STAGED_FILE_BYTES) {
                res.destroy()
                out.destroy()
                await rm(temp, { force: true })
                return { skipped: 'too_large' }
              }
              hash.update(buffer)
              if (!out.write(buffer)) await new Promise<void>((r) => out.once('drain', () => r()))
            }
            await new Promise<void>((resolve, reject) =>
              out.end((err?: Error | null) => (err ? reject(err) : resolve()))
            )
          } catch (err) {
            out.destroy()
            await rm(temp, { force: true })
            throw err
          }
          await rename(temp, file)
          return { path: relative, bytes: total, sha256: hash.digest('hex'), contentType: type }
        }
        return { skipped: 'not_found' }
      } catch (err) {
        if (
          err instanceof PrivateAddressError ||
          (err as { code?: string }).code === 'EPRIVATEADDRESS'
        ) {
          return { skipped: 'refused_url' }
        }
        throw err
      } finally {
        clearTimeout(timer)
      }
    },
  }
}
