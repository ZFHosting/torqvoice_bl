/**
 * fork (A6): where the load seed may write. Only a database on this machine (or the Dev Container's `db`) whose name
 * says it was made for testing: `test`, `e2e` or `load` as a whole word of it (`torqvoice_fork_load`, not `latest`).
 * The seed writes 85,000 rows and twelve full-access keys; anywhere else, it must not run.
 */
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', 'db'])

/** Why the seed refuses this database URL, or null when it may run. */
export function loadDatabaseRefusal(databaseUrl: string | undefined): string | null {
  let url: URL
  try {
    url = new URL(databaseUrl ?? '')
  } catch {
    return 'DATABASE_URL is not a database URL.'
  }
  if (!LOCAL_HOSTS.has(url.hostname.toLowerCase())) {
    return `Refusing ${url.hostname}: the load check seeds a database on this machine only.`
  }
  // The driver connects to a `host` in the query over the one in the URL (pg-connection-string), as a Cloud SQL URL
  // does (`@localhost/db?host=/cloudsql/…`): the load check never needs one.
  if (url.searchParams.has('host') || url.searchParams.has('hostaddr')) {
    return 'Refusing a URL that names its host in the query: the load check seeds a database on this machine only.'
  }
  const name = decodeURIComponent(url.pathname.slice(1))
  if (!/(^|_)(test|e2e|load)(_|$)/i.test(name)) {
    return `Refusing "${name}": the load check seeds a database named for it (test, e2e or load).`
  }
  return null
}
