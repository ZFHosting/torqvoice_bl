/**
 * fork: Settings → API keys (docs/fork/milestones/A1-api-foundation.md, task 6): the list, a new
 * key shown once with a copy button, revoke behind a confirmation, and a dropped connection that
 * leaves the page standing.
 */
import type { ReactElement } from 'react'
import { fireEvent, render as renderBare, screen, waitFor, within } from '@testing-library/react'
import { toast } from 'sonner'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ConfirmProvider } from '@/components/confirm-dialog'

const createApiKey = vi.fn()
const revokeApiKey = vi.fn()
const router = { refresh: vi.fn(), push: vi.fn() }

vi.mock('next/navigation', () => ({ useRouter: () => router }))
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))
vi.mock('@/features/public-api/Actions/apiKeyActions', () => ({
  createApiKey: (input: unknown) => createApiKey(input),
  revokeApiKey: (id: string) => revokeApiKey(id),
}))

import { ApiKeysSettings, type ApiKeyRow } from '@/features/public-api/Components/ApiKeysSettings'

const render = (ui: ReactElement) => renderBare(ui, { wrapper: ConfirmProvider })

const roles = [{ id: 'role-1', name: 'Integrations' }]
const live: ApiKeyRow = {
  id: 'key-1',
  name: 'BlueLabel',
  prefix: 'abcd2345',
  createdAt: new Date('2026-11-01T10:00:00Z'),
  lastUsedAt: null,
  expiresAt: null,
  revokedAt: null,
  role: roles[0],
}

beforeEach(() => {
  vi.clearAllMocks()
  Object.assign(navigator, { clipboard: { writeText: vi.fn(async () => undefined) } })
})

describe('Settings → API keys', () => {
  it('lists each key by name, role and prefix, never the key', () => {
    render(
      <ApiKeysSettings
        keys={[live, { ...live, id: 'key-2', name: 'Old', revokedAt: new Date() }]}
        roles={roles}
      />
    )
    expect(screen.getByText('BlueLabel')).toBeInTheDocument()
    expect(screen.getByText('Integrations')).toBeInTheDocument()
    expect(screen.getAllByText('tvk_abcd2345_…')).toHaveLength(2)
    expect(screen.getByText('Revoked')).toBeInTheDocument()
    // A revoked key can't be revoked again.
    expect(screen.getAllByRole('button', { name: 'Revoke' })).toHaveLength(1)
  })

  it('shows a new key once, with a copy button', async () => {
    createApiKey.mockResolvedValue({
      success: true,
      data: { id: 'key-3', name: 'Sync', prefix: 'zzzz2345', key: 'tvk_zzzz2345_secret' },
    })
    render(<ApiKeysSettings keys={[]} roles={roles} />)
    fireEvent.click(screen.getByRole('button', { name: 'Create key' }))
    const dialog = await screen.findByRole('dialog')
    fireEvent.change(within(dialog).getByLabelText('Name'), { target: { value: 'Sync' } })
    fireEvent.change(within(dialog).getByLabelText('Allowed IP addresses (optional)'), {
      target: { value: '198.51.100.7, 203.0.113.5' },
    })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create key' }))

    expect(await screen.findByText('tvk_zzzz2345_secret')).toBeInTheDocument()
    expect(createApiKey).toHaveBeenCalledWith({
      name: 'Sync',
      roleId: 'role-1',
      ipAllowlist: ['198.51.100.7', '203.0.113.5'],
    })
    fireEvent.click(screen.getByRole('button', { name: 'Copy key' }))
    await waitFor(() =>
      expect(navigator.clipboard.writeText).toHaveBeenCalledWith('tvk_zzzz2345_secret')
    )
    fireEvent.click(screen.getByRole('button', { name: 'Done' }))
    await waitFor(() => expect(screen.queryByText('tvk_zzzz2345_secret')).not.toBeInTheDocument())
  })

  it('revokes after a confirmation and refreshes the list', async () => {
    revokeApiKey.mockResolvedValue({ success: true, data: { id: 'key-1' } })
    render(<ApiKeysSettings keys={[live]} roles={roles} />)
    fireEvent.click(screen.getByRole('button', { name: 'Revoke' }))
    const confirm = await screen.findByRole('alertdialog').catch(() => screen.findByRole('dialog'))
    fireEvent.click(within(confirm).getByRole('button', { name: 'Revoke' }))
    await waitFor(() => expect(revokeApiKey).toHaveBeenCalledWith('key-1'))
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Key revoked'))
    expect(router.refresh).toHaveBeenCalled()
  })

  it('asks for a role first when the workshop has none', () => {
    render(<ApiKeysSettings keys={[]} roles={[]} />)
    expect(screen.getByRole('button', { name: 'Create key' })).toBeDisabled()
    expect(screen.getByText(/Create a role under Settings, Roles first/)).toBeInTheDocument()
  })

  it('stays on screen and says so when the connection drops', async () => {
    createApiKey.mockRejectedValue(new TypeError('Failed to fetch'))
    render(<ApiKeysSettings keys={[]} roles={roles} />)
    fireEvent.click(screen.getByRole('button', { name: 'Create key' }))
    const dialog = await screen.findByRole('dialog')
    fireEvent.change(within(dialog).getByLabelText('Name'), { target: { value: 'Sync' } })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create key' }))
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('The key could not be created.'))
    expect(screen.getByText('API keys')).toBeInTheDocument()
  })
})
