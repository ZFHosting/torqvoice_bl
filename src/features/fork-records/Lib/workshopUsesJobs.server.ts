/**
 * fork (M9): whether the workshop has any job (an import or the API made them, or a person on a screen that already
 * showed jobs). A workshop with none sees its screens and prints as upstream draws them.
 */
import 'server-only'
import { db } from '@/lib/db'

export async function workshopUsesJobs(organizationId: string): Promise<boolean> {
  const job = await db.workJob.findFirst({ where: { organizationId }, select: { id: true } })
  return job !== null
}
