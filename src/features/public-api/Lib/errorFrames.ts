/**
 * fork (A6, SECURITY-REVIEW.md item 6): where an error came from, for a log that must not quote it. A stack opens with
 * the error's message (one line or several, and it can quote what was sent); only the frame lines below it are kept.
 */
const MAX_FRAMES = 8

export function framesOf(err: unknown): string[] {
  if (!(err instanceof Error) || typeof err.stack !== 'string') return []
  return err.stack
    .split('\n')
    .filter((line) => /^\s+at\s/.test(line))
    .slice(0, MAX_FRAMES)
    .map((line) => line.trim())
}
