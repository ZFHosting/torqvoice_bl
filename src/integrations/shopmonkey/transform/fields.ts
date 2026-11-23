/**
 * Which source fields a transform maps and which it leaves in the archive (M4: "every source field is
 * either mapped or listed as unmapped"). A transform reports the archive-only fields a record carries;
 * a test fails on any fixture field that is in neither list, so a new Shopmonkey field can't vanish.
 */
import type { Row, Warning } from './types'

export interface FieldSpec {
  /** Fields the transform reads into a Torqvoice row. */
  mapped: readonly string[]
  /** Fields kept only in SourceRecord (MAPPING "archive only"), reachable through the API. */
  archive: readonly string[]
}

/** The archive-only and unknown fields a record carries, sorted (unknown ones too, so M6 lists them). */
export function unmappedFields(record: Row, spec: FieldSpec): string[] {
  const mapped = new Set(spec.mapped)
  return Object.keys(record)
    .filter((key) => !mapped.has(key) && record[key] !== null && record[key] !== undefined)
    .sort()
}

/** Fields neither mapped nor archived: what the unmapped-key test fails on. */
export function unknownFields(record: Row, spec: FieldSpec): string[] {
  const known = new Set([...spec.mapped, ...spec.archive])
  return Object.keys(record)
    .filter((key) => !known.has(key))
    .sort()
}

export function warn(
  table: string,
  remoteId: string,
  code: string,
  message: string,
  field?: string
): Warning {
  return { code, table, remoteId, message, ...(field ? { field } : {}) }
}

export const str = (value: unknown): string | null =>
  typeof value === 'string' && value.trim() ? value.trim() : null

export const num = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null

export const date = (value: unknown): Date | null => {
  if (typeof value !== 'string' || !value) return null
  const d = new Date(value)
  return Number.isNaN(d.getTime()) ? null : d
}

export const records = (value: unknown): Row[] =>
  Array.isArray(value) ? value.filter((v): v is Row => !!v && typeof v === 'object') : []

/** A Shopmonkey `{ id: value }` object (custom fields, labels) as entries, in key order. */
export const entries = (value: unknown): [string, unknown][] =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? Object.entries(value as Row).sort(([a], [b]) => a.localeCompare(b))
    : []
