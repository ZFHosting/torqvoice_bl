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
  // fork: the public API's events (docs/fork/API.md §5); `data` is the resource as the API returns it.
  {
    event: 'work_order.issue',
    description: 'An invoice was issued: its lines and totals are now the customer’s document.',
    data: {
      id: 'svc_R8c9',
      number: '1043',
      status: 'completed',
      issuedAt: '2026-04-29T09:58:00.000Z',
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
    },
  },
  {
    event: 'restore.complete',
    description:
      "A backup was restored: the workshop's records were replaced. Fetch everything again; GET /api/v1/deleted has a restore marker.",
    data: { restoredAt: '2026-05-04T09:30:00.000Z' },
  },
  {
    event: 'contact.create',
    description: 'A phone number or email was added to a customer.',
    data: { id: 'con_9Hw2', kind: 'phone', value: '+4791234567', isPrimary: false },
  },
  {
    event: 'appointment.create',
    description: 'An appointment was booked.',
    data: {
      id: 'apt_3Lm8',
      title: 'Annual service',
      startAt: '2026-05-02T08:00:00.000Z',
      durationMinutes: 90,
    },
  },
  {
    event: 'time_entry.stop',
    description: 'A technician’s clock on a job was stopped.',
    data: {
      id: 'tme_6Bc4',
      technicianId: 'tec_1Qa2',
      workOrderId: 'svc_R8c9',
      durationMinutes: 47,
    },
  },
  {
    event: 'shift.create',
    description: 'A technician’s shift was recorded.',
    data: { id: 'shf_2Wd7', technicianId: 'tec_1Qa2', startAt: '2026-04-29T07:00:00.000Z' },
  },
  {
    event: 'technician.update',
    description: 'A technician’s details changed.',
    data: { id: 'tec_1Qa2', name: 'Kari Nordmann', isActive: true },
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
