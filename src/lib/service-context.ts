/**
 * fork: who a domain service is acting for (docs/fork/milestones/A2-domain-services.md).
 *
 * The write logic that used to live inside a server action lives in a service
 * (`src/features/<domain>/Lib/<domain>Service.server.ts`), so the action and the public API call one
 * definition. The action builds this from `withAuth`'s context, the API from `withPublicApi`'s (the
 * key's service user). Permission checks stay with the caller; the service does the work.
 */
export interface ServiceCtx {
  organizationId: string
  /** The person, or the API key's service user. */
  userId: string
  actor: 'user' | 'api'
}
