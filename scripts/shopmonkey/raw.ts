/**
 * The file the spike writes for every response it records (tmp/shopmonkey-raw/<label>.json), and the
 * anonymizer reads. Raw files hold real shop data: they stay in tmp/, which is gitignored.
 */
export interface RawResponseFile {
  /** The Shopmonkey table the records belong to (`customer`, `order`, `order_service`...), or null. */
  table: string | null
  /** File name without extension; unique per request. */
  label: string
  request: {
    method: 'GET' | 'POST'
    path: string
    query?: Record<string, string>
    body?: unknown
  }
  status: number
  /** Only the headers the spike questions need: request id, rate limit, content type. */
  headers: Record<string, string>
  durationMs: number
  body: unknown
  recordedAt: string
}
