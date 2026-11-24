/**
 * fork (A6, docs/fork/milestones/A6-hardening.md task 7): an API key's service user on the Team page. Its role is set
 * there like anyone's, but it is labelled as a key, it can't be removed (it goes when the key is revoked, in Settings →
 * API keys), it isn't offered the technician app, and its placeholder address isn't shown as a contact.
 */
import { render, screen, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { ConfirmProvider } from '@/components/confirm-dialog'
import { GlassModal } from '@/components/glass-modal'
import { TooltipProvider } from '@/components/ui/tooltip'

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }))
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))
vi.mock('@/features/team/Actions/removeTechnicianAccess', () => ({
  removeTechnicianAccess: vi.fn(),
}))
vi.mock('@/features/team/Actions/setMemberTechnician', () => ({ setMemberTechnician: vi.fn() }))
vi.mock('@/features/team/Actions/teamActions', () => ({
  createOrganization: vi.fn(),
  removeMember: vi.fn(),
}))
vi.mock('@/features/team/Actions/cancelInvitation', () => ({ cancelInvitation: vi.fn() }))
vi.mock('@/features/team/Actions/resendInvitation', () => ({ resendInvitation: vi.fn() }))
vi.mock('@/features/team/Actions/createRole', () => ({ createRole: vi.fn() }))
vi.mock('@/features/team/Actions/updateRole', () => ({ updateRole: vi.fn() }))
vi.mock('@/features/team/Actions/deleteRole', () => ({ deleteRole: vi.fn() }))
vi.mock('@/features/team/Actions/assignRole', () => ({ assignRole: vi.fn() }))
vi.mock('@/features/team/Actions/createDefaultRoles', () => ({ createDefaultRoles: vi.fn() }))
vi.mock('@/features/workboard/Actions/technicianActions', () => ({ deleteTechnician: vi.fn() }))
vi.mock('@/components/upgrade-gate', () => ({ handleGated: () => false }))
vi.mock('@/features/team/Components/AddPersonDialog', () => ({ AddPersonDialog: () => null }))
vi.mock('@/features/team/Components/AppSetupCodeDialog', () => ({
  AppSetupCodeDialog: () => null,
}))
vi.mock('@/features/team/Components/GiveAppDialog', () => ({ GiveAppDialog: () => null }))

import { TeamSettings } from '@/app/(authenticated)/settings/team/team-settings'

const PERSON = {
  id: 'm2',
  role: 'member',
  roleId: null,
  customRoleName: null,
  user: { id: 'u2', name: 'Kari Mekaniker', email: 'kari@example.com' },
  apiKey: null,
}

const KEY = {
  id: 'm3',
  role: 'member',
  roleId: null,
  customRoleName: null,
  user: { id: 'u3', name: 'Bookkeeping sync', email: 'api+abcdefgh@invalid.local' },
  apiKey: { id: 'k1', name: 'Bookkeeping sync' },
}

function rowOf(name: string): HTMLElement {
  const row = screen
    .getAllByTestId('team-member')
    .find((el) => within(el).queryByText(name) !== null)
  if (!row) throw new Error(`no row for ${name}`)
  return row
}

describe('an API key on the Team page', () => {
  it('is labelled a key, with no Remove, no app and no placeholder address; a person keeps all three', () => {
    render(
      <TooltipProvider>
        <ConfirmProvider>
          <TeamSettings
            organization={{ id: 'org1', name: 'Berg Motor', members: [PERSON, KEY] }}
            currentRole="owner"
            technicianUserIds={[]}
          />
          <GlassModal />
        </ConfirmProvider>
      </TooltipProvider>
    )

    const key = rowOf('Bookkeeping sync')
    expect(within(key).getByTestId('team-member-api-key')).toHaveTextContent('API key')
    expect(within(key).queryByRole('button', { name: 'Remove member' })).toBeNull()
    expect(within(key).queryByRole('button', { name: 'Give them the app' })).toBeNull()
    expect(within(key).queryByText('api+abcdefgh@invalid.local')).toBeNull()

    const person = rowOf('Kari Mekaniker')
    expect(within(person).queryByTestId('team-member-api-key')).toBeNull()
    expect(within(person).getByRole('button', { name: 'Remove member' })).toBeInTheDocument()
    expect(within(person).getByRole('button', { name: 'Give them the app' })).toBeInTheDocument()
    expect(within(person).getByText('kari@example.com')).toBeInTheDocument()
  })
})
