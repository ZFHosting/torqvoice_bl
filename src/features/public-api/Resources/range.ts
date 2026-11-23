/** `?from=&to=` as a Prisma condition on one date column: `from` inclusive, `to` exclusive. */
export function range(field: string, from: unknown, to: unknown): Record<string, unknown> {
  const bounds: Record<string, Date> = {}
  if (typeof from === 'string') bounds.gte = new Date(from)
  if (typeof to === 'string') bounds.lt = new Date(to)
  return Object.keys(bounds).length ? { [field]: bounds } : {}
}
