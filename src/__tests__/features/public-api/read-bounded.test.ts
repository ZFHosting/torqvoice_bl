/**
 * @vitest-environment node
 *
 * fork (A6, SECURITY-REVIEW.md): an upload is read as it arrives and stopped as soon as it passes its limit, so a body
 * sent without a Content-Length is never held whole before its size is known.
 */
import { describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))

import {
  isSystemError,
  MAX_JSON_BYTES,
  readBounded,
  readJsonBody,
} from '@/features/public-api/Lib/writeRoute'

describe('readBounded', () => {
  it('stops an endless body at its limit, and reads no more of it', async () => {
    let pulled = 0
    const cancel = vi.fn()
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled++
        controller.enqueue(new Uint8Array(1024))
      },
      cancel,
    })
    const request = new Request('http://localhost/x', {
      method: 'POST',
      body,
      duplex: 'half',
    } as RequestInit)
    expect(await readBounded(request, 10_000)).toBeNull()
    expect(pulled).toBeLessThan(20)
    expect(cancel).toHaveBeenCalled()
  })

  it('reads a body within its limit whole', async () => {
    const request = new Request('http://localhost/x', { method: 'POST', body: 'hello' })
    expect(new TextDecoder().decode((await readBounded(request, 5)) ?? undefined)).toBe('hello')
    expect(
      await readBounded(new Request('http://localhost/x', { method: 'POST', body: 'hello!' }), 5)
    ).toBeNull()
  })
})

describe('readJsonBody', () => {
  const endless = () =>
    new Request('http://localhost/x', {
      method: 'POST',
      body: new ReadableStream<Uint8Array>({
        pull(controller) {
          controller.enqueue(new Uint8Array(64 * 1024).fill(32))
        },
      }),
      duplex: 'half',
    } as RequestInit)

  it('refuses a JSON body past 1 MiB with a 413, even one sent without a length', async () => {
    const answer = await readJsonBody(endless())
    expect(answer).toBeInstanceOf(Response)
    expect((answer as Response).status).toBe(413)
    expect(await (answer as Response).json()).toMatchObject({
      error: { code: 'invalid_request' },
    })
  })

  it('refuses one that says it is too long before reading it', async () => {
    const request = new Request('http://localhost/x', {
      method: 'POST',
      body: '{}',
      headers: { 'content-length': String(MAX_JSON_BYTES + 1) },
    })
    expect(((await readJsonBody(request)) as Response).status).toBe(413)
  })

  it('reads a body within the limit as text, multi-byte characters whole', async () => {
    const body = JSON.stringify({ name: 'Øyvind Åsheim 🚗' })
    const request = new Request('http://localhost/x', { method: 'POST', body })
    expect(await readJsonBody(request)).toBe(body)
  })
})

describe('isSystemError', () => {
  it('tells a file system failure from a refusal, though both are plain Errors', () => {
    const disk = Object.assign(new Error("EACCES: permission denied, mkdir '/app/data/x'"), {
      code: 'EACCES',
      errno: -13,
      syscall: 'mkdir',
    })
    expect(isSystemError(disk)).toBe(true)
    expect(isSystemError(new Error('Customer not found'))).toBe(false)
  })
})
