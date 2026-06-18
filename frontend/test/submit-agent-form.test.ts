import { fireEvent, render, screen, within } from '@testing-library/vue'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { SubmissionDetail } from '../src/api/client.js'

vi.mock('../src/api/client.js', () => ({
  getSubmissionCapabilities: vi.fn(),
  checkReachability: vi.fn(),
  submitAgent: vi.fn(),
  getSubmission: vi.fn(),
}))

import {
  checkReachability,
  getSubmission,
  getSubmissionCapabilities,
  submitAgent,
} from '../src/api/client.js'
import SubmitAgentForm from '../src/components/SubmitAgentForm.vue'

/** A submission-detail payload with the given status and ordered per-stage checks. */
function detail(
  status: SubmissionDetail['status'],
  checks: Array<
    [
      SubmissionDetail['checks'][number]['stage'],
      SubmissionDetail['checks'][number]['status'],
      string?,
    ]
  >,
  extra: Partial<SubmissionDetail> = {},
): SubmissionDetail {
  return {
    id: 'sub1',
    iteration_id: 'flappy_bird-iter-1',
    env_id: 'flappy_bird',
    user_id: 'dev-user',
    source_kind: 'git',
    repo_url: 'https://x/y',
    commit_sha: null,
    local_path: null,
    ref: null,
    status,
    reason: null,
    created_at: '2026-06-14T00:00:00.000Z',
    superseded_at: null,
    checks: checks.map(([stage, checkStatus, d]) => ({
      stage,
      status: checkStatus,
      detail: d ?? null,
      started_at: '2026-06-14T00:00:00.000Z',
      ended_at: checkStatus === 'running' ? null : '2026-06-14T00:00:01.000Z',
    })),
    ...extra,
  }
}

function renderForm() {
  return render(SubmitAgentForm, {
    props: { envId: 'flappy_bird', pollIntervalMs: 5, stallAfterPolls: 2 },
  })
}

/** Type a repo URL and click through the reachability check, awaiting the reachable badge. */
async function verifyReachable(): Promise<void> {
  await fireEvent.update(screen.getByLabelText('Repository URL'), 'https://x/y')
  await fireEvent.click(screen.getByRole('button', { name: 'Verify reachability' }))
  await screen.findByText('reachable')
}

describe('SubmitAgentForm', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(getSubmissionCapabilities).mockResolvedValue({ local_submissions: false })
  })

  it('keeps submit disabled until the repository verifies reachable', async () => {
    vi.mocked(checkReachability).mockResolvedValue({ reachable: true })
    renderForm()
    expect(screen.getByRole('button', { name: 'Submit agent' })).toBeDisabled()

    await verifyReachable()
    expect(screen.getByRole('button', { name: 'Submit agent' })).toBeEnabled()
  })

  it('surfaces an unreachable repo inline and leaves submit disabled', async () => {
    vi.mocked(checkReachability).mockResolvedValue({
      reachable: false,
      failure: 'ref_not_found',
      detail: 'no such ref',
    })
    renderForm()
    await fireEvent.update(screen.getByLabelText('Repository URL'), 'https://x/y')
    await fireEvent.click(screen.getByRole('button', { name: 'Verify reachability' }))

    expect(await screen.findByText('no such ref')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Submit agent' })).toBeDisabled()
  })

  it('posts the submission and enters the polling state on a pending response', async () => {
    vi.mocked(checkReachability).mockResolvedValue({ reachable: true })
    vi.mocked(submitAgent).mockResolvedValue({ ok: true, id: 'sub1', status: 'pending' })
    vi.mocked(getSubmission).mockResolvedValue(detail('pending', [['resolve', 'running']]))
    renderForm()
    await verifyReachable()

    await fireEvent.click(screen.getByRole('button', { name: 'Submit agent' }))

    expect(await screen.findByText('Validating your submission')).toBeInTheDocument()
    expect(vi.mocked(submitAgent)).toHaveBeenCalledWith('flappy_bird', {
      repoUrl: 'https://x/y',
      ref: null,
    })
  })

  it('prevents a duplicate submit while the first is in flight', async () => {
    vi.mocked(checkReachability).mockResolvedValue({ reachable: true })
    let resolveSubmit: (value: { ok: true; id: string; status: 'pending' }) => void = () => {}
    vi.mocked(submitAgent).mockReturnValue(
      new Promise((resolve) => {
        resolveSubmit = resolve
      }),
    )
    vi.mocked(getSubmission).mockResolvedValue(detail('pending', [['resolve', 'running']]))
    renderForm()
    await verifyReachable()

    const submit = screen.getByRole('button', { name: 'Submit agent' })
    await fireEvent.click(submit)
    // The button is busy/disabled, so a second click cannot fire a second request.
    expect(submit).toBeDisabled()
    await fireEvent.click(submit)
    expect(vi.mocked(submitAgent)).toHaveBeenCalledTimes(1)

    resolveSubmit({ ok: true, id: 'sub1', status: 'pending' })
  })

  it('renders the stage timeline with an in-progress stage and the earlier stage passed', async () => {
    vi.mocked(checkReachability).mockResolvedValue({ reachable: true })
    vi.mocked(submitAgent).mockResolvedValue({ ok: true, id: 'sub1', status: 'pending' })
    vi.mocked(getSubmission).mockResolvedValue(
      detail('pending', [
        ['resolve', 'passed'],
        ['static', 'running'],
      ]),
    )
    renderForm()
    await verifyReachable()
    await fireEvent.click(screen.getByRole('button', { name: 'Submit agent' }))

    await screen.findByText('Validating your submission')
    expect(within(screen.getByTestId('stage-resolve')).getByText('passed')).toBeInTheDocument()
    expect(within(screen.getByTestId('stage-static')).getByText('running')).toBeInTheDocument()
    expect(within(screen.getByTestId('stage-build')).getByText('not started')).toBeInTheDocument()
  })

  it('highlights the failed stage and renders its detail on a terminal failure', async () => {
    vi.mocked(checkReachability).mockResolvedValue({ reachable: true })
    vi.mocked(submitAgent).mockResolvedValue({ ok: true, id: 'sub1', status: 'pending' })
    vi.mocked(getSubmission).mockResolvedValue(
      detail(
        'build_failed',
        [
          ['resolve', 'passed'],
          ['static', 'passed'],
          ['build', 'failed', 'overlay build kaboom'],
        ],
        { reason: 'overlay build kaboom' },
      ),
    )
    renderForm()
    await verifyReachable()
    await fireEvent.click(screen.getByRole('button', { name: 'Submit agent' }))

    expect(await screen.findByText('overlay build kaboom')).toBeInTheDocument()
    expect(within(screen.getByTestId('stage-build')).getByText('failed')).toBeInTheDocument()
  })

  it('flips to a non-terminal "still processing" notice when a submission stays pending', async () => {
    vi.mocked(checkReachability).mockResolvedValue({ reachable: true })
    vi.mocked(submitAgent).mockResolvedValue({ ok: true, id: 'sub1', status: 'pending' })
    // Every poll returns the same pending log, so the no-progress stall counter trips.
    vi.mocked(getSubmission).mockResolvedValue(detail('pending', [['resolve', 'running']]))
    renderForm()
    await verifyReachable()
    await fireEvent.click(screen.getByRole('button', { name: 'Submit agent' }))

    expect(await screen.findByText(/Still processing/)).toBeInTheDocument()
  })

  it('shows the dev local-folder field only when the backend reports the gate is on', async () => {
    vi.mocked(getSubmissionCapabilities).mockResolvedValue({ local_submissions: true })
    renderForm()
    expect(await screen.findByLabelText('Local folder path (dev only)')).toBeInTheDocument()
  })

  it('hides the local-folder field when the gate is off', async () => {
    vi.mocked(getSubmissionCapabilities).mockResolvedValue({ local_submissions: false })
    renderForm()
    await vi.waitFor(() => expect(getSubmissionCapabilities).toHaveBeenCalled())
    expect(screen.queryByLabelText('Local folder path (dev only)')).toBeNull()
  })
})
