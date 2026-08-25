import { fireEvent, screen, waitFor, within } from '@testing-library/vue'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { nextTick } from 'vue'

import { signedInMe } from './helpers/me.js'
import { memoryRouter, renderWithMe } from './helpers/render.js'

// The account block and the page's own gate both read /api/me through the MeProvider.
vi.mock('../src/api/client.js', () => ({ getMe: vi.fn() }))

// This is the one page that drives `authClient.admin` directly (see UsersAdminPage.vue); stub every
// method the page calls, matching the account-menu/login-page idiom for mocking the auth client.
vi.mock('../src/auth.js', () => ({
  authClient: {
    admin: {
      listUsers: vi.fn(),
      createUser: vi.fn(),
      setRole: vi.fn(),
      banUser: vi.fn(),
      unbanUser: vi.fn(),
      setUserPassword: vi.fn(),
    },
  },
}))

import { getMe } from '../src/api/client.js'
import { authClient } from '../src/auth.js'
import UsersAdminPage from '../src/pages/UsersAdminPage.vue'

/** A roster row shaped like the admin plugin's list-users response, with only the fields the page reads. */
interface RosterUserFixture {
  id: string
  name: string
  email: string
  role?: string | null
  banned?: boolean | null
  banReason?: string | null
  createdAt: string
}

function user(overrides: Partial<RosterUserFixture> = {}): RosterUserFixture {
  return {
    id: 'u1',
    name: 'Pat',
    email: 'pat@test.local',
    role: 'user',
    banned: false,
    banReason: null,
    createdAt: '2026-06-01T00:00:00Z',
    ...overrides,
  }
}

const listUsers = vi.mocked(authClient.admin.listUsers)
const createUser = vi.mocked(authClient.admin.createUser)
const setRole = vi.mocked(authClient.admin.setRole)
const banUser = vi.mocked(authClient.admin.banUser)
const unbanUser = vi.mocked(authClient.admin.unbanUser)
const setUserPassword = vi.mocked(authClient.admin.setUserPassword)

/** Resolve `listUsers` with the given rows, however many calls the test makes going forward. */
function mockRoster(users: RosterUserFixture[], total = users.length): void {
  listUsers.mockResolvedValue({ data: { users, total }, error: null } as never)
}

/** A promise plus its resolver, for controlling exactly when a mocked `listUsers` call settles. */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((res) => {
    resolve = res
  })
  return { promise, resolve }
}

async function renderUsersPage() {
  const router = memoryRouter([{ path: '/admin/users', component: UsersAdminPage }])
  router.push('/admin/users')
  await router.isReady()
  return renderWithMe(router)
}

/** The most recent `query` object passed to `listUsers`. */
function lastQuery(): Record<string, unknown> | undefined {
  return listUsers.mock.calls.at(-1)?.[0]?.query as Record<string, unknown> | undefined
}

describe('UsersAdminPage', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(getMe).mockResolvedValue(signedInMe('admin-1', 'admin'))
    mockRoster([])
    createUser.mockResolvedValue({ data: { user: {} }, error: null } as never)
    setRole.mockResolvedValue({ data: { user: {} }, error: null } as never)
    banUser.mockResolvedValue({ data: { user: {} }, error: null } as never)
    unbanUser.mockResolvedValue({ data: { user: {} }, error: null } as never)
    setUserPassword.mockResolvedValue({ data: { status: true }, error: null } as never)
  })

  it('shows an access notice for a non-admin and never calls list-users', async () => {
    vi.mocked(getMe).mockResolvedValue(signedInMe('u2', 'normal'))
    await renderUsersPage()

    expect(await screen.findByText(/limited to operators/)).toBeInTheDocument()
    expect(listUsers).not.toHaveBeenCalled()
  })

  it('renders the roster with derived status badges, a banned marker, and a fail-closed corrupted role', async () => {
    mockRoster([
      user({ id: 'u1', name: 'Alice', email: 'alice@test.local', role: 'user' }),
      user({
        id: 'u2',
        name: 'Bob',
        email: 'bob@test.local',
        role: 'admin,user',
        banned: true,
        banReason: 'spam',
      }),
      user({ id: 'u3', name: 'Carol', email: 'carol@test.local', role: 'superuser' }),
    ])
    await renderUsersPage()

    const aliceRow = (await screen.findByText('Alice')).closest('tr')
    expect(aliceRow).not.toBeNull()
    expect(within(aliceRow as HTMLElement).getByText('normal')).toBeInTheDocument()
    expect(within(aliceRow as HTMLElement).queryByText('Banned')).toBeNull()

    const bobRow = screen.getByText('Bob').closest('tr') as HTMLElement
    expect(within(bobRow).getByText('admin')).toBeInTheDocument()
    expect(within(bobRow).getByText('Banned')).toBeInTheDocument()

    // An unrecognized role value fails closed to pending rather than reading as more privileged.
    const carolRow = screen.getByText('Carol').closest('tr') as HTMLElement
    expect(within(carolRow).getByText('pending')).toBeInTheDocument()
  })

  it('renders the error state alone when listUsers fails, without the table or pager', async () => {
    listUsers.mockResolvedValueOnce({ data: null, error: { message: 'boom' } } as never)
    await renderUsersPage()

    expect(await screen.findByText('boom')).toBeInTheDocument()
    expect(screen.queryByRole('table')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Prev' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Next' })).toBeNull()
    expect(screen.queryByText('No users match.')).toBeNull()
  })

  it('maps each status tab to one list-users filter, and All sends none', async () => {
    await renderUsersPage()
    await screen.findByRole('tab', { name: 'All' })
    await waitFor(() => expect(listUsers).toHaveBeenCalledTimes(1))

    await fireEvent.click(screen.getByRole('tab', { name: 'Pending' }))
    await waitFor(() =>
      expect(lastQuery()).toEqual(
        expect.objectContaining({
          filterField: 'role',
          filterValue: 'pending',
          filterOperator: 'eq',
        }),
      ),
    )

    await fireEvent.click(screen.getByRole('tab', { name: 'Normal' }))
    await waitFor(() =>
      expect(lastQuery()).toEqual(
        expect.objectContaining({ filterField: 'role', filterValue: 'user' }),
      ),
    )

    await fireEvent.click(screen.getByRole('tab', { name: 'Admins' }))
    await waitFor(() =>
      expect(lastQuery()).toEqual(
        expect.objectContaining({ filterField: 'role', filterValue: 'admin' }),
      ),
    )

    await fireEvent.click(screen.getByRole('tab', { name: 'Banned' }))
    await waitFor(() =>
      expect(lastQuery()).toEqual(
        expect.objectContaining({ filterField: 'banned', filterValue: true }),
      ),
    )

    const callsBeforeAll = listUsers.mock.calls.length
    await fireEvent.click(screen.getByRole('tab', { name: 'All' }))
    await waitFor(() => expect(listUsers.mock.calls.length).toBeGreaterThan(callsBeforeAll))
    const allQuery = lastQuery()
    expect(allQuery).not.toHaveProperty('filterField')
    expect(allQuery).not.toHaveProperty('filterValue')
  })

  it('resets to page 1 on a tab switch', async () => {
    mockRoster([user()], 120)
    await renderUsersPage()
    await screen.findByText('Pat')
    await fireEvent.click(screen.getByRole('button', { name: 'Next' }))
    await waitFor(() => expect(lastQuery()).toEqual(expect.objectContaining({ offset: 50 })))

    await fireEvent.click(screen.getByRole('tab', { name: 'Banned' }))
    await waitFor(() => expect(lastQuery()).toEqual(expect.objectContaining({ offset: 0 })))
  })

  it('discards a stale listUsers response that resolves after a newer request', async () => {
    const first = deferred<{ data: { users: RosterUserFixture[]; total: number }; error: null }>()
    const second = deferred<{ data: { users: RosterUserFixture[]; total: number }; error: null }>()
    listUsers.mockImplementationOnce(() => first.promise as never)
    listUsers.mockImplementationOnce(() => second.promise as never)

    await renderUsersPage()
    await screen.findByRole('tab', { name: 'All' })

    // Switch tabs before the initial mount fetch settles: a second, newer load() starts while the
    // first is still in flight.
    await fireEvent.click(screen.getByRole('tab', { name: 'Pending' }))
    expect(listUsers).toHaveBeenCalledTimes(2)

    // The newer (tab-switch) request resolves first...
    second.resolve({ data: { users: [user({ id: 'u2', name: 'Newer' })], total: 1 }, error: null })
    await screen.findByText('Newer')

    // ...then the stale (mount) request resolves after. Its data must be discarded rather than
    // clobber the newer result already on screen.
    first.resolve({ data: { users: [user({ id: 'u1', name: 'Older' })], total: 1 }, error: null })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(screen.queryByText('Older')).toBeNull()
    expect(screen.getByText('Newer')).toBeInTheDocument()
  })

  it('sends searchValue and searchField from the search box, resetting to page 1', async () => {
    await renderUsersPage()
    await screen.findByRole('tab', { name: 'All' })
    const callsBeforeSearch = listUsers.mock.calls.length

    // The search box debounces (~250ms) so typing doesn't send one request per keystroke: nothing
    // is sent immediately, and nothing before the debounce elapses.
    vi.useFakeTimers()
    try {
      await fireEvent.update(screen.getByLabelText('Search users'), 'ali')
      vi.advanceTimersByTime(200)
      await nextTick()
      expect(listUsers.mock.calls.length).toBe(callsBeforeSearch)

      vi.advanceTimersByTime(50)
      await nextTick()
    } finally {
      vi.useRealTimers()
    }
    expect(lastQuery()).toEqual(
      expect.objectContaining({
        searchValue: 'ali',
        searchField: 'email',
        searchOperator: 'contains',
        offset: 0,
      }),
    )

    // The search field (a select, not a keystroke stream) is not debounced — it fires immediately.
    await fireEvent.update(screen.getByLabelText('Search field'), 'name')
    await waitFor(() =>
      expect(lastQuery()).toEqual(
        expect.objectContaining({ searchValue: 'ali', searchField: 'name' }),
      ),
    )
  })

  it('debounces rapid keystrokes into a single listUsers call for the final value', async () => {
    await renderUsersPage()
    await screen.findByRole('tab', { name: 'All' })
    const callsBeforeSearch = listUsers.mock.calls.length

    vi.useFakeTimers()
    try {
      const input = screen.getByLabelText('Search users')
      await fireEvent.update(input, 'a')
      vi.advanceTimersByTime(100)
      await nextTick()
      await fireEvent.update(input, 'al')
      vi.advanceTimersByTime(100)
      await nextTick()
      await fireEvent.update(input, 'ali')
      vi.advanceTimersByTime(250)
      await nextTick()
    } finally {
      vi.useRealTimers()
    }

    // Only one new request went out, for the final value — not one per keystroke.
    expect(listUsers.mock.calls.length).toBe(callsBeforeSearch + 1)
    expect(lastQuery()).toEqual(expect.objectContaining({ searchValue: 'ali' }))
  })

  it('pages 50 rows at a time and disables Prev/Next at the bounds', async () => {
    mockRoster([user()], 120)
    await renderUsersPage()
    await screen.findByText('Pat')

    expect(screen.getByRole('button', { name: 'Prev' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Next' })).toBeEnabled()

    await fireEvent.click(screen.getByRole('button', { name: 'Next' }))
    await waitFor(() => expect(lastQuery()).toEqual(expect.objectContaining({ offset: 50 })))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Prev' })).toBeEnabled())
    await waitFor(() => expect(screen.getByRole('button', { name: 'Next' })).toBeEnabled())

    await fireEvent.click(screen.getByRole('button', { name: 'Next' }))
    await waitFor(() => expect(lastQuery()).toEqual(expect.objectContaining({ offset: 100 })))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Next' })).toBeDisabled())

    await fireEvent.click(screen.getByRole('button', { name: 'Prev' }))
    await waitFor(() => expect(lastQuery()).toEqual(expect.objectContaining({ offset: 50 })))
  })

  it('disables Prev/Next while a page fetch is in flight so double-clicks cannot stack', async () => {
    mockRoster([user()], 120)
    await renderUsersPage()
    await screen.findByText('Pat')

    const gate = deferred<{ data: { users: RosterUserFixture[]; total: number }; error: null }>()
    listUsers.mockImplementationOnce(() => gate.promise as never)

    await fireEvent.click(screen.getByRole('button', { name: 'Next' }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Next' })).toBeDisabled())
    expect(screen.getByRole('button', { name: 'Prev' })).toBeDisabled()

    // A second click while the fetch is still in flight must not send another request.
    const callsWhileLoading = listUsers.mock.calls.length
    await fireEvent.click(screen.getByRole('button', { name: 'Next' }))
    expect(listUsers.mock.calls.length).toBe(callsWhileLoading)

    gate.resolve({ data: { users: [user()], total: 120 }, error: null })
    await waitFor(() => expect(screen.getByRole('button', { name: 'Prev' })).toBeEnabled())
  })

  it('clamps the offset back to the last real page when the current page empties out from under it', async () => {
    mockRoster([user({ role: 'pending' })], 100)
    await renderUsersPage()
    await screen.findByText('Pat')

    await fireEvent.click(screen.getByRole('button', { name: 'Next' }))
    await waitFor(() => expect(lastQuery()).toEqual(expect.objectContaining({ offset: 50 })))

    // Approving the sole row on this last page removes it from the roster: the refetch at the
    // same offset (50) comes back empty even though 50 users still remain overall.
    listUsers.mockResolvedValueOnce({ data: { users: [], total: 50 }, error: null } as never)
    listUsers.mockResolvedValueOnce({
      data: { users: [user({ id: 'u2', name: 'Riley', role: 'user' })], total: 50 },
      error: null,
    } as never)

    await fireEvent.click(screen.getByRole('button', { name: 'Approve' }))
    await waitFor(() => expect(setRole).toHaveBeenCalled())

    // The empty response at offset 50 triggers exactly one follow-up call at the clamped,
    // 0-based last page, which renders that page's row.
    await waitFor(() => expect(lastQuery()).toEqual(expect.objectContaining({ offset: 0 })))
    await screen.findByText('Riley')
  })

  it('approves a pending user through set-role directly, with no confirmation dialog', async () => {
    mockRoster([user({ role: 'pending' })])
    await renderUsersPage()
    await screen.findByText('Pat')

    await fireEvent.click(screen.getByRole('button', { name: 'Approve' }))
    expect(screen.queryByRole('dialog')).toBeNull()
    await waitFor(() => expect(setRole).toHaveBeenCalledWith({ userId: 'u1', role: 'user' }))
    await waitFor(() => expect(listUsers).toHaveBeenCalledTimes(2))
  })

  it('promotes a normal user to admin only after the confirmation dialog', async () => {
    mockRoster([user({ role: 'user' })])
    await renderUsersPage()
    await screen.findByText('Pat')

    await fireEvent.click(screen.getByRole('button', { name: 'Promote' }))
    // The row click only opens the confirmation; no request until the dialog confirms.
    expect(setRole).not.toHaveBeenCalled()
    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByText(/Promote Pat to admin\?/)).toBeInTheDocument()

    await fireEvent.click(within(dialog).getByRole('button', { name: 'Promote' }))
    await waitFor(() => expect(setRole).toHaveBeenCalledWith({ userId: 'u1', role: 'admin' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    await waitFor(() => expect(listUsers).toHaveBeenCalledTimes(2))
  })

  it('demotes an admin to a normal user only after the confirmation dialog', async () => {
    mockRoster([user({ role: 'admin' })])
    await renderUsersPage()
    await screen.findByText('Pat')

    await fireEvent.click(screen.getByRole('button', { name: 'Demote' }))
    expect(setRole).not.toHaveBeenCalled()
    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByText(/Demote Pat to a normal member\?/)).toBeInTheDocument()

    await fireEvent.click(within(dialog).getByRole('button', { name: 'Demote' }))
    await waitFor(() => expect(setRole).toHaveBeenCalledWith({ userId: 'u1', role: 'user' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    await waitFor(() => expect(listUsers).toHaveBeenCalledTimes(2))
  })

  it('cancelling the role confirmation fires no role change', async () => {
    mockRoster([user({ role: 'admin' })])
    await renderUsersPage()
    await screen.findByText('Pat')

    await fireEvent.click(screen.getByRole('button', { name: 'Demote' }))
    const dialog = await screen.findByRole('dialog')
    await fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }))

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(setRole).not.toHaveBeenCalled()
    expect(listUsers).toHaveBeenCalledTimes(1)
  })

  it('bans a user with a reason through the ban dialog, then refetches', async () => {
    mockRoster([user({ banned: false })])
    await renderUsersPage()
    await screen.findByText('Pat')

    await fireEvent.click(screen.getByRole('button', { name: 'Ban' }))
    const dialog = await screen.findByRole('dialog')
    await fireEvent.update(within(dialog).getByLabelText('Reason (optional)'), 'spam')
    await fireEvent.click(within(dialog).getByRole('button', { name: 'Ban' }))

    await waitFor(() => expect(banUser).toHaveBeenCalledWith({ userId: 'u1', banReason: 'spam' }))
    await waitFor(() => expect(listUsers).toHaveBeenCalledTimes(2))
  })

  it('does not paint a stale ban error into a dialog reopened for a different row', async () => {
    mockRoster([
      user({ id: 'u1', name: 'Alice', banned: false }),
      user({ id: 'u2', name: 'Bob', banned: false }),
    ])
    await renderUsersPage()
    await screen.findByText('Alice')

    const aliceRow = screen.getByText('Alice').closest('tr') as HTMLElement
    const bobRow = screen.getByText('Bob').closest('tr') as HTMLElement

    const gate = deferred<{ data: null; error: { message: string } }>()
    banUser.mockImplementationOnce(() => gate.promise as never)

    // Confirm ban for Alice; her request is held open for the rest of this test.
    await fireEvent.click(within(aliceRow).getByRole('button', { name: 'Ban' }))
    let dialog = await screen.findByRole('dialog')
    await fireEvent.click(within(dialog).getByRole('button', { name: 'Ban' }))
    await waitFor(() => expect(banUser).toHaveBeenCalledWith({ userId: 'u1' }))

    // Cancel while Alice's request is still in flight, then open the dialog for Bob instead.
    await fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    await fireEvent.click(within(bobRow).getByRole('button', { name: 'Ban' }))
    dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByText(/Ban Bob\?/)).toBeInTheDocument()

    // Alice's stale request now resolves as an error: it must not show up in Bob's now-open dialog.
    gate.resolve({ data: null, error: { message: 'cannot ban alice' } })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(screen.queryByText('cannot ban alice')).toBeNull()
    dialog = screen.getByRole('dialog')
    expect(within(dialog).getByText(/Ban Bob\?/)).toBeInTheDocument()
  })

  it('keeps a dialog reopened for a different row open when a stale ban resolves as a success, but still refetches', async () => {
    mockRoster([
      user({ id: 'u1', name: 'Alice', banned: false }),
      user({ id: 'u2', name: 'Bob', banned: false }),
    ])
    await renderUsersPage()
    await screen.findByText('Alice')

    const aliceRow = screen.getByText('Alice').closest('tr') as HTMLElement
    const bobRow = screen.getByText('Bob').closest('tr') as HTMLElement

    const gate = deferred<{ data: { user: unknown }; error: null }>()
    banUser.mockImplementationOnce(() => gate.promise as never)

    await fireEvent.click(within(aliceRow).getByRole('button', { name: 'Ban' }))
    let dialog = await screen.findByRole('dialog')
    await fireEvent.click(within(dialog).getByRole('button', { name: 'Ban' }))
    await waitFor(() => expect(banUser).toHaveBeenCalledWith({ userId: 'u1' }))

    await fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    await fireEvent.click(within(bobRow).getByRole('button', { name: 'Ban' }))
    dialog = await screen.findByRole('dialog')

    const callsBeforeResolve = listUsers.mock.calls.length
    gate.resolve({ data: { user: {} }, error: null })
    // Alice's success still refetches the roster...
    await waitFor(() => expect(listUsers.mock.calls.length).toBeGreaterThan(callsBeforeResolve))
    // ...but Bob's dialog, which Alice's stale response must not touch, stays open on Bob.
    dialog = screen.getByRole('dialog')
    expect(within(dialog).getByText(/Ban Bob\?/)).toBeInTheDocument()
  })

  it("disables every row's approve while one is in flight, so a second click is a visible no-op", async () => {
    mockRoster([
      user({ id: 'u1', name: 'Alice', role: 'pending' }),
      user({ id: 'u2', name: 'Bob', role: 'pending' }),
    ])
    await renderUsersPage()
    await screen.findByText('Alice')
    const aliceRow = screen.getByText('Alice').closest('tr') as HTMLElement
    const bobRow = screen.getByText('Bob').closest('tr') as HTMLElement

    const gate = deferred<{ data: { user: unknown }; error: null }>()
    setRole.mockImplementationOnce(() => gate.promise as never)

    await fireEvent.click(within(aliceRow).getByRole('button', { name: 'Approve' }))
    await waitFor(() => expect(setRole).toHaveBeenCalledWith({ userId: 'u1', role: 'user' }))

    // While Alice's approval is in flight, Bob's action is disabled — the click is refused visibly
    // rather than silently swallowed.
    expect(within(bobRow).getByRole('button', { name: 'Approve' })).toBeDisabled()

    gate.resolve({ data: { user: {} }, error: null })
    await waitFor(() =>
      expect(within(bobRow).getByRole('button', { name: 'Approve' })).not.toBeDisabled(),
    )
  })

  it('reflects the in-flight ban when the dialog is reopened for the same row, firing no duplicate', async () => {
    mockRoster([user({ id: 'u1', name: 'Alice', banned: false })])
    await renderUsersPage()
    await screen.findByText('Alice')

    const gate = deferred<{ data: { user: unknown }; error: null }>()
    banUser.mockImplementationOnce(() => gate.promise as never)

    await fireEvent.click(screen.getByRole('button', { name: 'Ban' }))
    let dialog = await screen.findByRole('dialog')
    await fireEvent.click(within(dialog).getByRole('button', { name: 'Ban' }))
    await waitFor(() => expect(banUser).toHaveBeenCalledTimes(1))

    // Cancel and reopen the dialog for the SAME row while Alice's ban is still in flight.
    await fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    await fireEvent.click(screen.getByRole('button', { name: 'Ban' }))
    dialog = await screen.findByRole('dialog')

    // The reopened dialog shows the in-flight state (its confirm is busy/disabled) rather than offering
    // a fresh confirm, so a second click cannot fire a duplicate ban.
    const confirm = within(dialog).getByRole('button', { name: 'Ban' })
    expect(confirm).toBeDisabled()
    await fireEvent.click(confirm)
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(banUser).toHaveBeenCalledTimes(1)

    // Once the original resolves, its success still refetches the roster.
    gate.resolve({ data: { user: {} }, error: null })
    await waitFor(() => expect(listUsers).toHaveBeenCalledTimes(2))
  })

  it('unbans a user directly, with no dialog, then refetches', async () => {
    mockRoster([user({ banned: true })])
    await renderUsersPage()
    await screen.findByText('Pat')

    expect(screen.getByRole('button', { name: 'Reset' })).toBeInTheDocument()
    await fireEvent.click(screen.getByRole('button', { name: 'Unban' }))
    await waitFor(() => expect(unbanUser).toHaveBeenCalledWith({ userId: 'u1' }))
    await waitFor(() => expect(listUsers).toHaveBeenCalledTimes(2))
  })

  it('resets a password through the reset-password dialog', async () => {
    mockRoster([user()])
    await renderUsersPage()
    await screen.findByText('Pat')

    await fireEvent.click(screen.getByRole('button', { name: 'Reset' }))
    const dialog = await screen.findByRole('dialog')
    await fireEvent.update(within(dialog).getByLabelText('New password'), 'hunter2')
    await fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }))

    await waitFor(() =>
      expect(setUserPassword).toHaveBeenCalledWith({ userId: 'u1', newPassword: 'hunter2' }),
    )
    await waitFor(() => expect(listUsers).toHaveBeenCalledTimes(2))
  })

  it('creates a user through the create-user dialog and refreshes the list', async () => {
    await renderUsersPage()
    await screen.findByRole('tab', { name: 'All' })

    await fireEvent.click(screen.getByRole('button', { name: 'Create user' }))
    const dialog = await screen.findByRole('dialog')
    await fireEvent.update(within(dialog).getByLabelText('Name'), 'New Person')
    await fireEvent.update(within(dialog).getByLabelText('Email'), 'new@test.local')
    await fireEvent.update(within(dialog).getByLabelText('Password'), 'secretpw')
    await fireEvent.update(within(dialog).getByLabelText('Role'), 'admin')
    await fireEvent.click(within(dialog).getByRole('button', { name: 'Create' }))

    await waitFor(() =>
      expect(createUser).toHaveBeenCalledWith({
        name: 'New Person',
        email: 'new@test.local',
        password: 'secretpw',
        role: 'admin',
      }),
    )
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    await waitFor(() => expect(listUsers).toHaveBeenCalledTimes(2))
  })

  it('offers Guest as a create-user role and as a roster filter tab', async () => {
    await renderUsersPage()
    await screen.findByRole('tab', { name: 'All' })

    await fireEvent.click(screen.getByRole('button', { name: 'Create user' }))
    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByRole('option', { name: 'Guest' })).toBeInTheDocument()
    await within(dialog).getByRole('button', { name: 'Cancel' }).click()
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())

    // The Guests tab filters the roster on the guest role.
    await fireEvent.click(screen.getByRole('tab', { name: 'Guests' }))
    await waitFor(() =>
      expect(listUsers).toHaveBeenCalledWith(
        expect.objectContaining({ query: expect.objectContaining({ filterValue: 'guest' }) }),
      ),
    )
  })

  it("disables self-targeting actions on the acting admin's own row", async () => {
    mockRoster([user({ id: 'admin-1', name: 'Self', role: 'admin', banned: false })])
    await renderUsersPage()
    await screen.findByText('Self')

    expect(screen.getByRole('button', { name: 'Demote' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Ban' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Reset' })).toBeDisabled()
  })
})
