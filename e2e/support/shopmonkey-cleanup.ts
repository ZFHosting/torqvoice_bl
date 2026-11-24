/**
 * fork (M8): leaves the suite's shared workshop as the Shopmonkey import spec found it, whether the spec got to its
 * own undo or not: every load of its Shopmonkey connection undone (what a load created goes), then the import's
 * archive (`SourceRecord`) and batches removed. Run by `support/shopmonkey.ts` with the server's environment:
 *
 *   node node_modules/tsx/dist/cli.mjs --import ./scripts/shopmonkey/register.mjs e2e/support/shopmonkey-cleanup.ts
 */
import { undoLoad } from '@/integrations/shopmonkey/load/undo'
import { db } from '@/lib/db'
import { endProcess } from '../../scripts/shopmonkey/exit'

async function main() {
  const email = process.env.E2E_USER_EMAIL ?? 'demo@torqvoice.com'
  const user = await db.user.findFirst({ where: { email }, select: { id: true } })
  if (!user) return
  // Every workshop the suite's user is in, not whichever membership comes first.
  const memberships = await db.organizationMember.findMany({
    where: { userId: user.id },
    select: { organizationId: true },
  })
  for (const { organizationId } of memberships) await cleanUp(organizationId, user.id)
}

async function cleanUp(organizationId: string, userId: string) {
  const connection = await db.integrationConnection.findFirst({
    where: { organizationId, connectorId: 'shopmonkey' },
    select: { id: true },
  })
  if (connection) {
    const audits = await db.auditLog.findMany({
      where: { organizationId, entityId: connection.id, action: 'shopmonkey.import' },
      orderBy: { timestamp: 'desc' },
      select: { metadata: true },
    })
    const undone = new Set(
      (
        await db.auditLog.findMany({
          where: { organizationId, entityId: connection.id, action: 'shopmonkey.import_undo' },
          select: { metadata: true },
        })
      ).map((a) => (a.metadata as { runId?: string } | null)?.runId)
    )
    for (const audit of audits) {
      const runId = (audit.metadata as { runId?: string } | null)?.runId
      if (!runId || undone.has(runId)) continue
      await undoLoad({ organizationId, connectionId: connection.id, runId, userId })
    }
  }
  await db.sourceRecord.deleteMany({ where: { organizationId, source: 'shopmonkey' } })
  await db.importBatch.deleteMany({ where: { organizationId, source: 'shopmonkey' } })
}

main()
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err)
    process.exitCode = 1
  })
  .finally(() => endProcess(() => db.$disconnect()))
