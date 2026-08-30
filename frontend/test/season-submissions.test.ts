import { render, screen, waitFor } from '@testing-library/vue'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { AdminSubmissionRow } from '../src/api/client.js'
import { formatDate } from '../src/lib/format.js'

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

  it('links the submission date to its source and renders the available downloads', async () => {
    const submission = row()
    vi.mocked(listSeasonSubmissions).mockResolvedValue([submission])
    render(SeasonSubmissions, { props: { seasonId: 'iter-1' } })

    const link = await screen.findByRole('link', { name: 'Download' })
    // No user_name on this row, so the Participant cell falls back to the stable user_id, kept as its
    // own tooltip — and the download filename stays keyed on the id either way.
    const participant = screen.getByText('alice')
    expect(participant).toHaveAttribute('title', 'alice')
    expect(link.getAttribute('download')).toBe('alice-sub-abcd.tar.gz')
    const all = screen.getByRole('link', { name: /Download all/ })
    expect(all).toHaveAttribute('download', 'season-iter-1.tar.gz')
    expect(all).toHaveClass('ui-button', 'secondary', 'tight')
    expect(screen.getByRole('heading', { name: 'Submissions', level: 2 })).toBeInTheDocument()

    expect(screen.getAllByRole('columnheader').map((header) => header.textContent)).toEqual([
      'Participant',
      'Status',
      'Submitted',
      'Download',
    ])
    const sourceLink = screen
      .getAllByRole('link')
      .find((candidate) => candidate.getAttribute('href') === 'https://example.test/repo')
    expect(sourceLink).toHaveAttribute('title', 'https://example.test/repo @ c0ffee12')
    expect(sourceLink).toHaveTextContent(formatDate(submission.created_at) ?? submission.created_at)
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

  it('keeps a local submission date as text when there is no source URL', async () => {
    const submission = row({ source_kind: 'local', repo_url: null, commit_sha: null })
    vi.mocked(listSeasonSubmissions).mockResolvedValue([submission])
    render(SeasonSubmissions, { props: { seasonId: 'iter-1' } })

    const submittedAt = formatDate(submission.created_at) ?? submission.created_at
    await screen.findByText(submittedAt)
    expect(screen.queryByRole('link', { name: submittedAt })).toBeNull()
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
