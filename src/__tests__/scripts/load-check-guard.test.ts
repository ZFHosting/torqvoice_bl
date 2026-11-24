/**
 * fork (A6): the load seed writes 85,000 rows and twelve full-access keys, so it runs only against a database on this
 * machine whose name says it was made for testing.
 */
import { describe, expect, it } from 'vitest'
import { loadDatabaseRefusal } from '../../../scripts/load-check/guard'

const url = (host: string, name: string, query = '') =>
  `postgresql://torqvoice:torqvoice@${host}:5442/${name}${query}`

describe('loadDatabaseRefusal', () => {
  it('lets a local database named for the load check, the tests or e2e through', () => {
    for (const name of ['torqvoice_fork_load', 'torqvoice_fork_test', 'torqvoice_e2e', 'load']) {
      expect(loadDatabaseRefusal(url('localhost', name))).toBeNull()
    }
    expect(loadDatabaseRefusal(url('127.0.0.1', 'torqvoice_fork_load'))).toBeNull()
    expect(loadDatabaseRefusal(url('[::1]', 'torqvoice_fork_load'))).toBeNull()
    expect(loadDatabaseRefusal(url('db', 'torqvoice_test'))).toBeNull()
  })

  it('refuses a database on any other host, whatever its name', () => {
    expect(loadDatabaseRefusal(url('db.example.com', 'torqvoice_fork_load'))).toMatch(
      /this machine/
    )
    expect(loadDatabaseRefusal(url('10.0.0.5', 'torqvoice_test'))).toMatch(/this machine/)
  })

  it('refuses a local URL whose query names another host, which the driver would connect to', () => {
    for (const query of [
      '?host=db.prod.example.com',
      '?host=/cloudsql/project:region:db',
      '?hostaddr=10.0.0.5',
    ]) {
      expect(loadDatabaseRefusal(url('localhost', 'torqvoice_test', query))).toMatch(/query/)
    }
  })

  it('refuses a name that only contains the words', () => {
    for (const name of ['latest', 'payload', 'download', 'torqvoice', 'contest_db']) {
      expect(loadDatabaseRefusal(url('localhost', name))).toMatch(/named for it/)
    }
  })

  it('reads the name from the path, not from a slash in the query', () => {
    expect(
      loadDatabaseRefusal(url('localhost', 'torqvoice', '?sslrootcert=/certs/test-ca.pem'))
    ).toMatch(/named for it/)
  })

  it('refuses a missing or malformed URL, or one that is not postgresql://', () => {
    expect(loadDatabaseRefusal(undefined)).toMatch(/not a database URL/)
    expect(loadDatabaseRefusal('torqvoice_fork_load')).toMatch(/not a database URL/)
    expect(loadDatabaseRefusal('socket://localhost/test?db=production')).toMatch(/postgresql/)
    expect(loadDatabaseRefusal('postgres://u:p@localhost/torqvoice_test')).toBeNull()
  })
})
