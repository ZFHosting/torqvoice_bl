/**
 * fork: moved unchanged from the server actions (A2), so the actions and the public API
 * share one definition. Callers check permissions and log the audit event.
 */
import 'server-only'
import { prepareRecordCustomFields } from '@/features/custom-fields/Lib/recordCustomFieldValues.server'
import { deleteCustomFieldValuesOf } from '@/features/custom-fields/Lib/deleteCustomFieldValues'
import { isCustomerReferenceEnabled } from '@/features/customer-reference/Lib/referenceSetting'
import { db } from '@/lib/db'
import { createCustomerSchema, updateCustomerSchema } from '../Schema/customerSchema'
import { revalidatePath } from 'next/cache'
import { getFeatures, FeatureGatedError } from '@/lib/features'
import { countCustomersTowardLimit } from '@/lib/customer-limit'
import { claimWhatsappMessagesForCustomer } from '@/lib/whatsapp'
import { claimEmailMessagesForCustomer } from '@/features/messaging/Lib/emailClaim.server'
import { clearedToNull } from '@/lib/clearable'
import type { ServiceCtx } from '@/lib/service-context'

/**
 * A design a customer is being pointed at has to be this workshop's and an
 * invoice design; anything else is refused rather than stored.
 */
async function assertInvoiceDesign(organizationId: string, designId: string | null | undefined) {
  if (!designId) return
  const design = await db.documentDesign.findFirst({
    where: { id: designId, organizationId, documentType: 'invoice' },
    select: { id: true },
  })
  if (!design) throw new Error('Design not found')
}

/**
 * "PO required" belongs to the Reference / PO field. A workshop that has the
 * field off has no such switch, so the value is neither set nor cleared for
 * it: what was chosen while the field was on is still there when it returns.
 */
async function dropPoRequiredWhenOff(
  organizationId: string,
  data: { poRequired?: boolean }
): Promise<void> {
  if (data.poRequired === undefined) return
  if (!(await isCustomerReferenceEnabled(organizationId))) delete data.poRequired
}

export async function createCustomerService(ctx: ServiceCtx, input: unknown) {
  const { userId, organizationId } = ctx
  const features = await getFeatures(organizationId)
  const count = await countCustomersTowardLimit(organizationId)
  if (count >= features.maxCustomers) {
    throw new FeatureGatedError(
      'maxCustomers',
      'Customer limit reached. Upgrade your plan to add more customers.',
      features.maxCustomers
    )
  }

  const { customFields, ...data } = createCustomerSchema.parse(input)
  await assertInvoiceDesign(organizationId, data.invoiceDesignId)
  // The workshop's own fields, when the form sent them: checked first, so
  // a required one left empty stops the customer being made at all.
  const writeCustomFields = await prepareRecordCustomFields(
    organizationId,
    'customer',
    null,
    customFields
  )
  await dropPoRequiredWhenOff(organizationId, data)

  // Auto-assign the next sequential number when none was provided; the
  // per-org unique index guards against races and manual duplicates.
  let customerNumber = data.customerNumber?.trim() || null
  if (!customerNumber) {
    const existing = await db.customer.findMany({
      where: { organizationId, customerNumber: { not: null } },
      select: { customerNumber: true },
    })
    const max = existing.reduce((acc, c) => {
      const n = Number.parseInt(c.customerNumber ?? '', 10)
      return Number.isFinite(n) && n > acc ? n : acc
    }, 1000)
    customerNumber = String(max + 1)
  }

  try {
    const createWith = (store: Pick<typeof db, 'customer'>) =>
      store.customer.create({
        data: {
          ...data,
          customerNumber,
          email: data.email || null,
          userId,
          organizationId,
        },
      })
    // With its fields, in one transaction: both are saved or neither is.
    const customer = writeCustomFields
      ? await db.$transaction(async (tx) => {
          const made = await createWith(tx)
          await writeCustomFields(tx, made.id)
          return made
        })
      : await createWith(db)
    // Someone added from an unknown WhatsApp number or email address
    // keeps the thread that prompted it.
    await claimWhatsappMessagesForCustomer(organizationId, customer.id, customer.phone)
    await claimEmailMessagesForCustomer(organizationId, customer.id, customer.email)

    revalidatePath('/customers')
    return customer
  } catch (err: unknown) {
    if (err && typeof err === 'object' && (err as { code?: string }).code === 'P2002') {
      throw new Error('Customer number is already in use')
    }
    throw err
  }
}

export async function updateCustomerService(ctx: ServiceCtx, input: unknown) {
  const { userId, organizationId } = ctx
  const { id, customFields, ...data } = updateCustomerSchema.parse(input)
  await assertInvoiceDesign(organizationId, data.invoiceDesignId)
  await dropPoRequiredWhenOff(organizationId, data)
  // The workshop's own fields, when the form sent them: checked before
  // anything is written. The customer has to be this workshop's first.
  const writeCustomFields =
    customFields !== undefined && (await db.customer.count({ where: { id, organizationId } })) > 0
      ? await prepareRecordCustomFields(organizationId, 'customer', id, customFields)
      : null
  const updateWith = (store: Pick<typeof db, 'customer'>) =>
    store.customer.updateMany({
      where: { id, organizationId },
      // Fields left out of the input stay as they are; an emptied one
      // ('') is cleared.
      data: {
        ...data,
        customerNumber: clearedToNull(data.customerNumber),
        email: clearedToNull(data.email),
        company: clearedToNull(data.company),
        phone: clearedToNull(data.phone),
        address: clearedToNull(data.address),
        taxId: clearedToNull(data.taxId),
        notes: clearedToNull(data.notes),
      },
    })
  let result
  try {
    // With its fields, in one transaction: both are saved or neither is.
    result = writeCustomFields
      ? await db.$transaction(async (tx) => {
          const updated = await updateWith(tx)
          if (updated.count === 0) throw new Error('Customer not found')
          await writeCustomFields(tx, id)
          return updated
        })
      : await updateWith(db)
  } catch (err: unknown) {
    if (err && typeof err === 'object' && (err as { code?: string }).code === 'P2002') {
      throw new Error('Customer number is already in use')
    }
    throw err
  }
  if (result.count === 0) throw new Error('Customer not found')
  if (data.phone) await claimWhatsappMessagesForCustomer(organizationId, id, data.phone)
  if (data.email) await claimEmailMessagesForCustomer(organizationId, id, data.email)
  revalidatePath('/customers')
  revalidatePath(`/customers/${id}`)
  return { id }
}

export async function deleteCustomerService(ctx: ServiceCtx, customerId: string) {
  const { userId, organizationId } = ctx
  // The customer's custom field values hang on their id alone, with no
  // foreign key, so they are removed by name with the row.
  const result = await db.$transaction(async (tx) => {
    const deleted = await tx.customer.deleteMany({ where: { id: customerId, organizationId } })
    await deleteCustomFieldValuesOf(tx, organizationId, 'customer', [customerId])
    // fork: the tombstone an API client syncing by updatedSince learns the delete from.
    if (deleted.count > 0) {
      await tx.deletedRecord.create({
        data: { organizationId, entityType: 'customer', entityId: customerId, actorUserId: userId },
      })
    }
    return deleted
  })
  if (result.count === 0) throw new Error('Customer not found')
  revalidatePath('/customers')
  return { customerId }
}

export async function deleteCustomersService(ctx: ServiceCtx, customerIds: string[]) {
  const { userId, organizationId } = ctx
  if (customerIds.length === 0) throw new Error('No customers selected')
  // Only the ones that are this workshop's: an id from elsewhere must not
  // take another workshop's values with it.
  const own = await db.customer.findMany({
    where: { id: { in: customerIds }, organizationId },
    select: { id: true },
  })
  const ownIds = own.map((customer) => customer.id)
  const result = await db.$transaction(async (tx) => {
    const deleted = await tx.customer.deleteMany({
      where: { id: { in: ownIds }, organizationId },
    })
    await deleteCustomFieldValuesOf(tx, organizationId, 'customer', ownIds)
    // fork: tombstones for API sync, one per customer this workshop deleted.
    if (deleted.count > 0) {
      await tx.deletedRecord.createMany({
        data: ownIds.map((entityId) => ({
          organizationId,
          entityType: 'customer',
          entityId,
          actorUserId: userId,
        })),
      })
    }
    return deleted
  })
  revalidatePath('/customers')
  return { deleted: result.count }
}
