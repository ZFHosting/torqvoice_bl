/** What Settings → API keys sends to create a key. Safe to import from the form. */
import { z } from 'zod'

/** What the actions answer a member who isn't an owner or admin; the page recognises it. */
export const API_KEYS_OWNER_ONLY = 'Only an owner or administrator can manage API keys.'

export const createApiKeySchema = z.object({
  name: z.string().trim().min(1).max(80),
  roleId: z.string().min(1),
  expiresAt: z.iso.datetime({ offset: true }).nullable().optional(),
  /** Exact addresses, IPv4 or IPv6; empty means any address. */
  ipAllowlist: z
    .array(z.union([z.ipv4(), z.ipv6()]))
    .max(50)
    .default([]),
})

export type CreateApiKeyInput = z.input<typeof createApiKeySchema>
