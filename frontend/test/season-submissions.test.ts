import { render, screen, waitFor } from '@testing-library/vue'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { AdminSubmissionRow } from '../src/api/client.js'

vi.mock('../src/api/client.js', () => ({
  listSeasonSubmissions: vi.fn(),
  // Admin downloads are now identified by the session cookie, so the URLs no longer carry `?user=`.
  adminSubmissionDownloadUrl: (id: string) => `/api/admin/submissions/${id}/download`,
  adminSeasonDownloadUrl: (seasonId: string) =>
    `/api/admin/seasons/${seasonId}/submissions/download`,
}))

import { listSeasonSubmissions } from '../src/api/client.js'
import SeasonSubmissions from '../src/components/admin/SeasonSubmissions.vue'

function row(overrides: Partial<AdminSubmissionRow> = {}): AdminSubmissionRow {
  return {
    id: 'sub-abcdef12',
    user_id: 'alice',
    status: 'ready',
    source_kind: 'git',
    repo_url: 'https://example.test/repo',
    commit_sha: 'c0ffee1234',
    ref: null,
    created_at: '2026-06-12T00:00:00Z',
    has_snapshot: true,
    ...overrides,
  }
}

describe('SeasonSubmissions', () => {
  afterEach(() => vi.clearAllMocks())

  it('renders a download link for a submission with a snapshot and a season download link', async () => {
    vi.mocked(listSeasonSubmissions).mockResolvedValue([row()])
    render(SeasonSubmissions, { props: { seasonId: 'iter-1' } })

    const link = await screen.findByRole('link', { name: 'Download' })
    expect(link.getAttribute('href')).toBe('/api/admin/submissions/sub-abcdef12/download')
    // No user_name on this row, so the Participant cell falls back to the stable user_id, kept as its
    // own tooltip — and the download filename stays keyed on the id either way.
    const participant = screen.getByText('alice')
    expect(participant).toHaveAttribute('title', 'alice')
    expect(link.getAttribute('download')).toBe('alice-sub-abcd.tar.gz')
    const all = screen.getByRole('link', { name: /Download all/ })
    expect(all.getAttribute('href')).toBe('/api/admin/seasons/iter-1/submissions/download')
  })

  it('disables the download for a submission without a snapshot', async () => {
    vi.mocked(listSeasonSubmissions).mockResolvedValue([
      row({ id: 'no-snap', user_id: 'bob', status: 'build_failed', has_snapshot: false }),
    ])
    render(SeasonSubmissions, { props: { seasonId: 'iter-1' } })

    await waitFor(() => expect(screen.getByText('bob')).toBeTruthy())
    // No per-row Download link exists; only the season-wide "Download all" link is present.
    expect(screen.queryByRole('link', { name: 'Download' })).toBeNull()
    expect(screen.getByRole('link', { name: /Download all/ })).toBeTruthy()
  })

  it('prefers user_name over user_id in the Participant column, keeping the id as a tooltip and download key', async () => {
    vi.mocked(listSeasonSubmissions).mockResolvedValue([
      row({ user_id: 'alice', user_name: 'Alice Nguyen' }),
    ])
    render(SeasonSubmissions, { props: { seasonId: 'iter-1' } })

    const participant = await screen.findByText('Alice Nguyen')
    expect(participant).toHaveAttribute('title', 'alice')
    expect(screen.queryByText('alice', { exact: true })).toBeNull()
    // The download filename must keep the stable id, never the display name, so attribution surviving
    // a later name change stays legible from the archive alone.
    const link = screen.getByRole('link', { name: 'Download' })
    expect(link.getAttribute('download')).toBe('alice-sub-abcd.tar.gz')
  })
})
