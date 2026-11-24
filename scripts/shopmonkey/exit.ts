/**
 * fork (M8): how a script that runs the app's server modules ends. Once a run writes anything, the realtime bus opens
 * its own `LISTEN` connection to tell the app's open screens (`src/lib/realtime/bus.server.ts`) and keeps it for the
 * life of the process, so a load or an undo run from a script would never exit on its own. This disconnects Prisma,
 * gives the bus a moment to send what the run published (it sends one `pg_notify` at a time), then ends the process
 * with the run's exit code.
 */
const DRAIN_MS = 1_000

export async function endProcess(disconnect: () => Promise<void>): Promise<never> {
  await disconnect().catch(() => undefined)
  await new Promise((resolve) => setTimeout(resolve, DRAIN_MS))
  process.exit()
}
