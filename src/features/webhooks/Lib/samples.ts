/**
 * Example payloads shown in the events reference panel. These mirror the
 * shape produced by `dispatchWebhookEvent` so integrators can stub their
 * receivers against realistic input.
 */

export type SamplePayload = {
  event: string
  description: string
  data: Record<string, unknown>
}

export const SAMPLE_PAYLOADS: SamplePayload[] = [
  {
    event: 'customer.create',
    description: 'A new customer was added to your workshop.',
    data: { id: 'cus_1aB2cD3eF4', name: 'Acme Logistics' },
  },
  {
    event: 'vehicle.create',
    description: 'A vehicle was registered against a customer.',
    data: { id: 'veh_8K9L0', licensePlate: 'AB12345', make: 'Volvo', model: 'FH16' },
  },
  {
    event: 'service.status',
    description: 'A work-order status changed (e.g. → completed, ready).',
    data: { id: 'svc_R8c9', status: 'completed', previousStatus: 'in_progress' },
  },
  {
    event: 'payment.create',
    description: 'A payment was recorded against an invoice.',
    data: { id: 'pmt_zX1y', invoiceId: 'svc_R8c9', amount: 12500, currency: 'NOK', method: 'card' },
  },
  {
    event: 'quote.status',
    description: 'A quote moved between draft / sent / accepted / declined.',
    data: { id: 'quo_44A', status: 'accepted' },
  },
  {
    event: 'inspection.complete',
    description: 'A digital inspection was submitted for a vehicle.',
    data: { id: 'ins_77B', vehicleId: 'veh_8K9L0', findings: 2 },
  },
  // fork: the public API's events (docs/fork/API.md §5); `data` is the resource as the API returns it (a contact or
  // a job also carries the id that finds it; a delete, its id and those). Fictional people and numbers.
  {
    event: 'appointment.create',
    description: 'An appointment was booked.',
    data: {
      id: 'apt_3Lm8',
      title: 'Annual service',
      description: null,
      startAt: '2026-05-02T08:00:00.000Z',
      endAt: '2026-05-02T09:30:00.000Z',
      customerId: 'cus_1aB2cD3eF4',
      vehicleId: 'veh_8K9L0',
    },
  },
  {
    event: 'appointment.update',
    description: 'An appointment was moved or changed.',
    data: {
      id: 'apt_3Lm8',
      title: 'Annual service',
      description: null,
      startAt: '2026-05-02T10:00:00.000Z',
      endAt: '2026-05-02T11:30:00.000Z',
      customerId: 'cus_1aB2cD3eF4',
      vehicleId: 'veh_8K9L0',
    },
  },
  {
    event: 'appointment.delete',
    description: 'An appointment was deleted, or became a work order.',
    data: { id: 'apt_3Lm8' },
  },
  {
    event: 'time_entry.start',
    description: 'A technician’s clock on a job started (and the clock it closed, if one ran).',
    data: {
      id: 'tme_6Bc4',
      technicianId: 'tec_1Qa2',
      workOrderId: 'svc_R8c9',
      startedAt: '2026-04-29T08:11:00.000Z',
      endedAt: null,
      durationMinutes: null,
      note: null,
      closedEntryId: 'tme_5Ab3',
    },
  },
  {
    event: 'time_entry.stop',
    description: 'A technician’s clock on a job was stopped.',
    data: {
      id: 'tme_6Bc4',
      technicianId: 'tec_1Qa2',
      workOrderId: 'svc_R8c9',
      startedAt: '2026-04-29T08:11:00.000Z',
      endedAt: '2026-04-29T08:58:00.000Z',
      durationMinutes: 47,
      note: null,
    },
  },
  {
    event: 'time_entry.create',
    description: 'A time entry was added by hand.',
    data: {
      id: 'tme_7Cd5',
      technicianId: 'tec_1Qa2',
      workOrderId: 'svc_R8c9',
      startedAt: '2026-04-28T13:00:00.000Z',
      endedAt: '2026-04-28T14:30:00.000Z',
      durationMinutes: 90,
      note: 'Diagnosis',
    },
  },
  {
    event: 'time_entry.update',
    description: 'A time entry was edited.',
    data: {
      id: 'tme_7Cd5',
      technicianId: 'tec_1Qa2',
      workOrderId: 'svc_R8c9',
      startedAt: '2026-04-28T13:00:00.000Z',
      endedAt: '2026-04-28T14:15:00.000Z',
      durationMinutes: 75,
      note: 'Diagnosis',
    },
  },
  {
    event: 'time_entry.delete',
    description: 'A time entry was deleted.',
    data: { id: 'tme_7Cd5' },
  },
  {
    event: 'shift.create',
    description: 'A technician’s shift was recorded.',
    data: {
      id: 'shf_2Wd7',
      technicianId: 'tec_1Qa2',
      clockIn: '2026-04-29T07:00:00.000Z',
      clockOut: null,
      durationMinutes: null,
      note: null,
    },
  },
  {
    event: 'shift.update',
    description: 'A shift was closed or edited.',
    data: {
      id: 'shf_2Wd7',
      technicianId: 'tec_1Qa2',
      clockIn: '2026-04-29T07:00:00.000Z',
      clockOut: '2026-04-29T15:30:00.000Z',
      durationMinutes: 510,
      note: null,
    },
  },
  {
    event: 'shift.delete',
    description: 'A shift was deleted.',
    data: { id: 'shf_2Wd7' },
  },
  {
    event: 'technician.create',
    description: 'A technician was added.',
    data: { id: 'tec_1Qa2', name: 'Alex Example', color: '#3b82f6', isActive: true },
  },
  {
    event: 'technician.update',
    description: 'A technician’s details changed.',
    data: { id: 'tec_1Qa2', name: 'Alex Example', color: '#3b82f6', isActive: true },
  },
  {
    event: 'technician.delete',
    description: 'A technician was removed (deactivated: their hours stay).',
    data: { id: 'tec_1Qa2' },
  },
  {
    event: 'work_order.issue',
    description: 'An invoice was issued: its lines and totals are now the customer’s document.',
    data: {
      id: 'svc_R8c9',
      invoiceNumber: '1043',
      status: 'completed',
      issuedAt: '2026-04-29T09:58:00.000Z',
    },
  },
  {
    event: 'job.create',
    description: 'A job was added to a work order or a quote.',
    data: {
      id: 'job_5Tq1',
      name: 'Front brakes',
      authorizationStatus: null,
      totalAmount: 0,
      workOrderId: 'svc_R8c9',
    },
  },
  {
    event: 'job.update',
    description: 'A job on a work order changed (its lines, its approval).',
    data: {
      id: 'job_5Tq1',
      name: 'Front brakes',
      authorizationStatus: 'approved',
      totalAmount: 4200,
      workOrderId: 'svc_R8c9',
    },
  },
  {
    event: 'job.delete',
    description: 'A job was removed from a work order or a quote.',
    data: { id: 'job_5Tq1', workOrderId: 'svc_R8c9' },
  },
  {
    event: 'contact.create',
    description: 'A phone number or email was added to a customer.',
    data: {
      id: 'con_9Hw2',
      kind: 'phone',
      value: '+15555550100',
      label: 'Mobile',
      isPrimary: false,
      customerId: 'cus_1aB2cD3eF4',
    },
  },
  {
    event: 'contact.update',
    description: 'A customer’s phone number or email changed.',
    data: {
      id: 'con_9Hw2',
      kind: 'phone',
      value: '+15555550101',
      label: 'Mobile',
      isPrimary: true,
      customerId: 'cus_1aB2cD3eF4',
    },
  },
  {
    event: 'contact.delete',
    description: 'A phone number or email was removed from a customer.',
    data: { id: 'con_9Hw2', customerId: 'cus_1aB2cD3eF4' },
  },
  {
    event: 'restore.complete',
    description:
      "A backup was restored: the workshop's records were replaced. Fetch everything again; GET /api/v1/deleted has a restore marker.",
    data: { restoredAt: '2026-05-04T09:30:00.000Z' },
  },
  {
    event: 'ping.test',
    description: 'Sent by the “Send test” button in the settings page.',
    data: { test: true },
  },
]

export function buildSampleEnvelope(sample: SamplePayload) {
  return {
    id: 'evt_2k0r6h6f7g4z',
    event: sample.event,
    createdAt: '2026-04-29T10:00:00.000Z',
    organizationId: 'org_4nFgYkM',
    entity: sample.event.split('.')[0],
    entityId: sample.data.id ?? null,
    message: null,
    userId: 'usr_3K8qP1',
    data: sample.data,
  }
}
