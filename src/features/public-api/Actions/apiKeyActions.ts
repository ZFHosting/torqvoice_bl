'use server'
/**
 * Settings → API keys (docs/fork/API.md §2). Owners and admins only: a key acts with the role it is
 * given, so making one hands out access. The full key is returned once, by createApiKey, and never
 * again; the audit row names the key by its prefix.
 */
import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { db } from '@/lib/db'
import { demoGuard } from '@/lib/demo'
import { requireFeature } from '@/lib/features'
import { withAuth } from '@/lib/with-auth'
import { API_KEYS_OWNER_ONLY as OWNER_ONLY, createApiKeySchema } from '../Schema/apiKeys'
import {
  ApiKeyRoleError,
  createApiKey as createKey,
  revokeApiKey as revokeKey,
} from '../Lib/keys.server'

export async function getApiKeys() {
  return withAuth(async ({ organizationId, isAdmin }) => {
    if (!isAdmin) throw new Error(OWNER_ONLY)
    const [keys, roles] = await Promise.all([
      db.apiKey.findMany({
        where: { organizationId },
        orderBy: { createdAt: 'desc' },
        select: {
          id: true,
          name: true,
          prefix: true,
          createdAt: true,
          lastUsedAt: true,
          lastUsedIp: true,
          expiresAt: true,
          revokedAt: true,
          ipAllowlist: true,
          serviceUser: {
            select: {
              organizationMembers: {
                where: { organizationId },
                select: { customRole: { select: { id: true, name: true } } },
              },
            },
          },
        },
      }),
      db.role.findMany({
        where: { organizationId },
        select: { id: true, name: true, isAdmin: true },
        orderBy: { name: 'asc' },
      }),
    ])
    return {
      keys: keys.map((k) => ({
        id: k.id,
        name: k.name,
        prefix: k.prefix,
        createdAt: k.createdAt,
        lastUsedAt: k.lastUsedAt,
        lastUsedIp: k.lastUsedIp,
        expiresAt: k.expiresAt,
        revokedAt: k.revokedAt,
        ipAllowlist: k.ipAllowlist,
        role: k.serviceUser.organizationMembers[0]?.customRole ?? null,
      })),
      roles,
    }
  })
}

export async function createApiKey(input: unknown) {
  return withAuth(
    async ({ organizationId, userId, isAdmin }) => {
      if (!isAdmin) throw new Error(OWNER_ONLY)
      await requireFeature(organizationId, 'api')
      // A key is a login of sorts to the shared demo, which takes no new users either.
      demoGuard()
      const data = createApiKeySchema.parse(input)
      try {
        const created = await createKey({
          organizationId,
          name: data.name,
          roleId: data.roleId,
          createdById: userId,
          expiresAt: data.expiresAt ? new Date(data.expiresAt) : null,
          ipAllowlist: data.ipAllowlist,
        })
        revalidatePath('/settings/api-keys')
        // The only time the full key leaves the server.
        return { id: created.id, name: created.name, prefix: created.prefix, key: created.key }
      } catch (err) {
        if (err instanceof ApiKeyRoleError) throw new Error(err.message)
        throw err
      }
    },
    {
      audit: ({ result }) => ({
        action: 'api_key.create',
        entity: 'apiKey',
        entityId: result.id,
        details: { key: 'api_key_create', params: { name: result.name, ref: result.prefix } },
        // Never the key itself.
        metadata: { name: result.name, prefix: result.prefix },
      }),
    }
  )
}

export async function revokeApiKey(id: string) {
  return withAuth(
    async ({ organizationId, isAdmin }) => {
      if (!isAdmin) throw new Error(OWNER_ONLY)
      const revoked = await revokeKey(organizationId, z.string().min(1).parse(id))
      if (!revoked) throw new Error('API key not found')
      revalidatePath('/settings/api-keys')
      return revoked
    },
    {
      audit: ({ result }) => ({
        action: 'api_key.revoke',
        entity: 'apiKey',
        entityId: result.id,
        details: { key: 'api_key_revoke', params: { name: result.name, ref: result.prefix } },
        metadata: { name: result.name, prefix: result.prefix },
      }),
    }
  )
}
