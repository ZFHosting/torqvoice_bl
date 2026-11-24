/**
 * @vitest-environment node
 *
 * fork (A6, SECURITY-REVIEW.md): an upload is read as it arrives and stopped as soon as it passes its limit, so a body
 * sent without a Content-Length is never held whole before its size is known.
 */
import { describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))

import { readBounded } from '@/features/public-api/Lib/writeRoute'

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
