/**
 * fork: what the public API takes to write the fork's own records (docs/fork/milestones/A4-write-endpoints.md):
 * a customer's other emails and phones (X4), a work order's jobs (X2), a technician's shifts (X6). An update is
 * the create schema made partial without defaults: a field not sent stays as it is.
 */
import { z } from 'zod'

const optionalText = (max: number) => z.string().trim().max(max).nullable().optional()

export const createContactSchema = z
  .object({
    kind: z.enum(['email', 'phone']),
    value: z.string().trim().min(1).max(254),
    label: optionalText(50),
    isPrimary: z.boolean().optional(),
    marketingOptIn: z.boolean().nullable().optional(),
    subscribed: z.boolean().nullable().optional(),
  })
  .refine((c) => c.kind !== 'email' || z.email().safeParse(c.value).success, {
    message: 'Invalid email',
    path: ['value'],
  })

export const updateContactSchema = z
  .object({
    kind: z.enum(['email', 'phone']).optional(),
    value: z.string().trim().min(1).max(254).optional(),
    label: optionalText(50),
    isPrimary: z.boolean().optional(),
    marketingOptIn: z.boolean().nullable().optional(),
    subscribed: z.boolean().nullable().optional(),
  })
  .strict()

const jobFields = {
  name: z.string().trim().min(1).max(200),
  note: optionalText(2000),
  ordinal: z.number().int().min(0).optional(),
  authorizationStatus: optionalText(50),
  recommended: z.boolean().optional(),
  hidden: z.boolean().optional(),
  lumpSum: z.boolean().optional(),
  fixedPrice: z.number().nullable().optional(),
  deferredDate: z.iso.datetime({ offset: true }).nullable().optional(),
  deferredReason: optionalText(500),
}

export const createJobSchema = z.object(jobFields).strict()
export const updateJobSchema = z.object({ ...jobFields, name: jobFields.name.optional() }).strict()

export const createShiftSchema = z
  .object({
    technicianId: z.string().min(1),
    clockIn: z.iso.datetime({ offset: true }),
    clockOut: z.iso.datetime({ offset: true }).nullable().optional(),
    note: optionalText(1000),
  })
  .strict()

export const updateShiftSchema = z
  .object({
    technicianId: z.string().min(1).optional(),
    clockIn: z.iso.datetime({ offset: true }).optional(),
    clockOut: z.iso.datetime({ offset: true }).nullable().optional(),
    note: optionalText(1000),
  })
  .strict()
