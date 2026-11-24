/**
 * fork (M9): a document's jobs are its own: reading them needs what reading the work order or quote needs, changing
 * them what editing it needs.
 */
import { PermissionAction, PermissionSubject, type PermissionInput } from '@/lib/permissions'
import type { JobParent } from '../Schema/workJobActionSchemas'

export function jobPermission(kind: JobParent['kind'], change: boolean): PermissionInput {
  return {
    action: change ? PermissionAction.UPDATE : PermissionAction.READ,
    subject: kind === 'quote' ? PermissionSubject.QUOTES : PermissionSubject.SERVICES,
  }
}
