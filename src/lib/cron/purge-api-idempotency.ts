import { CronJob } from 'cron'
import { purgeExpiredIdempotencyKeys } from '@/features/public-api/Lib/idempotency'
import { createLogger } from '@/lib/logger'

/**
 * fork: drops the public API's stored Idempotency-Key responses once they are 24 hours old
 * (docs/fork/API.md §3), hourly at minute 17. A request after that runs afresh anyway; this keeps
 * the table small.
 */
export function purgeApiIdempotencyKeys() {
  const job = new CronJob('17 * * * *', async () => {
    try {
      const deleted = await purgeExpiredIdempotencyKeys()
      if (deleted > 0) createLogger('cron').info('API idempotency purge', { deleted })
    } catch (error) {
      createLogger('cron').error('API idempotency purge failed', { err: error })
    }
  })

  job.start()
}
