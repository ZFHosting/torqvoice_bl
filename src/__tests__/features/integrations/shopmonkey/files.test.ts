/**
 * @vitest-environment node
 *
 * fork: staging the files an import brings over (M3): only https links that pass the webhook address
 * checks, redirects checked again, the upload route's content types and size cap, written inside the
 * connection's staging folder whatever the id says.
 */
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import type { IncomingMessage } from 'node:http'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createFileStager, MAX_STAGED_FILE_BYTES } from '@/integrations/shopmonkey/extract/files'

function answer(
  status: number,
  body: string,
  headers: Record<string, string> = {}
): IncomingMessage {
  const stream = Readable.from([Buffer.from(body)]) as unknown as IncomingMessage
  stream.statusCode = status
  stream.headers = headers
  return stream
}

let root: string
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'sm-files-'))
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

function stager(responses: IncomingMessage[], allowed = true) {
  const open = vi.fn(async (_url: URL, _signal: AbortSignal) => {
    const next = responses.shift()
    if (!next) throw new Error('no more answers')
    return next
  })
  const check = vi.fn(async (url: string) => ({ ok: allowed && !url.includes('internal') }))
  return { files: createFileStager({ connectionId: 'conn-1', root, open, check }), open, check }
}

describe('a linked file', () => {
  it('is downloaded into the connection’s staging folder, with its size and hash', async () => {
    const { files } = stager([answer(200, 'JPEGDATA', { 'content-type': 'image/jpeg' })])
    const staged = await files.fetchUrl(
      'order_file',
      'syn_ofl_1',
      'https://files.example.test/a.jpg'
    )
    expect(staged).toEqual({
      path: 'shopmonkey-staging/conn-1/order_file/syn_ofl_1.jpg',
      bytes: 8,
      sha256: createHash('sha256').update('JPEGDATA').digest('hex'),
      contentType: 'image/jpeg',
    })
    expect(await readFile(path.join(root, (staged as { path: string }).path), 'utf-8')).toBe(
      'JPEGDATA'
    )
  })

  it('is refused unless it is https and passes the address checks, before any request', async () => {
    const plain = stager([])
    expect(
      await plain.files.fetchUrl('order_file', 'f', 'http://files.example.test/a.jpg')
    ).toEqual({
      skipped: 'refused_url',
    })
    const blocked = stager([])
    expect(await blocked.files.fetchUrl('order_file', 'f', 'https://internal.test/a.jpg')).toEqual({
      skipped: 'refused_url',
    })
    expect(plain.open).not.toHaveBeenCalled()
    expect(blocked.open).not.toHaveBeenCalled()
  })

  it('follows a redirect only where the checks allow', async () => {
    const { files, check } = stager([answer(302, '', { location: 'https://internal.test/a.jpg' })])
    expect(await files.fetchUrl('order_file', 'f', 'https://files.example.test/a.jpg')).toEqual({
      skipped: 'refused_url',
    })
    expect(check).toHaveBeenLastCalledWith('https://internal.test/a.jpg')
  })

  it('is left out when its type isn’t one the app takes, or it is too large', async () => {
    const { files } = stager([
      answer(200, '<html>', { 'content-type': 'text/html' }),
      answer(200, 'x', {
        'content-type': 'video/mp4',
        'content-length': String(MAX_STAGED_FILE_BYTES + 1),
      }),
    ])
    expect(await files.fetchUrl('order_file', 'a', 'https://files.example.test/a')).toEqual({
      skipped: 'content_type',
    })
    expect(await files.fetchUrl('order_file', 'b', 'https://files.example.test/b')).toEqual({
      skipped: 'too_large',
    })
  })

  it('is noted as gone on a 404, and retried later on a 5xx', async () => {
    const { files } = stager([answer(404, ''), answer(503, '')])
    expect(await files.fetchUrl('order_file', 'a', 'https://files.example.test/a')).toEqual({
      skipped: 'not_found',
    })
    await expect(files.fetchUrl('order_file', 'b', 'https://files.example.test/b')).rejects.toThrow(
      '503'
    )
  })
})

describe('bytes in hand', () => {
  it('are written under a name made from the id alone', async () => {
    const { files } = stager([])
    const staged = await files.write(
      'invoice_pdf',
      '../../etc/passwd',
      Buffer.from('%PDF'),
      'application/pdf'
    )
    expect(staged).toMatchObject({
      path: 'shopmonkey-staging/conn-1/invoice_pdf/______etc_passwd.pdf',
    })
    expect(await readFile(path.join(root, (staged as { path: string }).path), 'utf-8')).toBe('%PDF')
  })

  it('are left out when over the cap or of a type the app doesn’t take', async () => {
    const { files } = stager([])
    expect(await files.write('invoice_pdf', 'a', null, 'application/pdf')).toEqual({
      skipped: 'too_large',
    })
    expect(await files.write('invoice_pdf', 'b', Buffer.from('x'), 'text/html')).toEqual({
      skipped: 'content_type',
    })
  })
})
