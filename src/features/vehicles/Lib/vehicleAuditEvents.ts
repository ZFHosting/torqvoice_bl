/**
 * fork: the audit events vehicle and note writes log, in one place for both callers: the server
 * actions pass them to `withAuth`'s `audit`, the public API to `logAudit`, so webhooks fire the same
 * either way (docs/fork/API.md §1.1). Moved unchanged from the actions (A2).
 */
import { type AuditEvent, auditDetails } from '@/lib/audit'

export function vehicleCreatedEvent(vehicle: {
  id: string
  year: number
  make: string
  model: string
}): AuditEvent {
  return {
    action: 'vehicle.create',
    entity: 'Vehicle',
    entityId: vehicle.id,
    details: {
      key: 'vehicle_create',
      params: { year: vehicle.year, make: vehicle.make, model: vehicle.model },
    },
    metadata: { vehicleId: vehicle.id },
  }
}

export function vehicleUpdatedEvent(result: {
  id: string
  fields: string[]
  vehicleDisplay: string
}): AuditEvent {
  return {
    action: 'vehicle.update',
    entity: 'Vehicle',
    entityId: result.id,
    details: result.fields.length
      ? auditDetails('vehicle_update', {
          name: result.vehicleDisplay,
          fields: result.fields.join(', '),
        })
      : auditDetails('vehicle_updateNoChanges', { name: result.vehicleDisplay }),
    metadata: {
      vehicleId: result.id,
      vehicleDisplay: result.vehicleDisplay,
      changed: result.fields,
    },
  }
}

export function vehicleDeletedEvent(result: {
  vehicleId: string
  vehicleDisplay: string
}): AuditEvent {
  return {
    action: 'vehicle.delete',
    entity: 'Vehicle',
    entityId: result.vehicleId,
    details: { key: 'vehicle_delete', params: { name: result.vehicleDisplay } },
    metadata: { vehicleId: result.vehicleId, vehicleDisplay: result.vehicleDisplay },
  }
}

export function vehicleArchivedEvent(result: { vehicleId: string }): AuditEvent {
  return {
    action: 'vehicle.archive',
    entity: 'Vehicle',
    entityId: result.vehicleId,
    details: { key: 'vehicle_archive', params: { id: result.vehicleId } },
    metadata: { vehicleId: result.vehicleId },
  }
}

export function vehicleUnarchivedEvent(result: { vehicleId: string }): AuditEvent {
  return {
    action: 'vehicle.unarchive',
    entity: 'Vehicle',
    entityId: result.vehicleId,
    details: { key: 'vehicle_unarchive', params: { id: result.vehicleId } },
    metadata: { vehicleId: result.vehicleId },
  }
}

export function noteCreatedEvent(note: { id: string; vehicleId: string }): AuditEvent {
  return {
    action: 'note.create',
    entity: 'Note',
    entityId: note.id,
    details: { key: 'note_create', params: { vehicleId: note.vehicleId } },
    metadata: { noteId: note.id, vehicleId: note.vehicleId },
  }
}

export function noteDeletedEvent(result: { noteId: string }): AuditEvent {
  return {
    action: 'note.delete',
    entity: 'Note',
    entityId: result.noteId,
    details: { key: 'note_delete', params: { id: result.noteId } },
    metadata: { noteId: result.noteId },
  }
}
