import { fireEvent, render, screen, within } from '@testing-library/vue'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { SubmissionDetail } from '../src/api/client.js'

vi.mock('../src/api/client.js', () => ({
  getSubmissionCapabilities: vi.fn(),
  checkReachability: vi.fn(),
  submitAgent: vi.fn(),
  getSubmission: vi.fn(),
  getAuthorPrompt: vi.fn(),
  setAuthorPrompt: vi.fn(),
}))

import {
  checkReachability,
  getAuthorPrompt,
  getSubmission,
  getSubmissionCapabilities,
  setAuthorPrompt,
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
    season_id: 'flappy_bird-iter-1',
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

function renderForm(withActionBefore = false) {
  return render(SubmitAgentForm, {
    props: {
      envId: 'flappy_bird',
      submissionSeasonId: 'flappy_bird-iter-1',
      pollIntervalMs: 5,
      stallAfterPolls: 2,
    },
    slots: withActionBefore
      ? { 'actions-before': '<button type="button">Set Up Locally</button>' }
      : {},
  })
}

/** Type a repo URL and click through the reachability check, awaiting the reachable badge. */
async function verifyReachable(): Promise<void> {
  await fireEvent.update(screen.getByLabelText('Public Repository URL'), 'https://x/y')
  await fireEvent.click(screen.getByRole('button', { name: 'Verify reachability' }))
  await screen.findByText('reachable')
}

describe('SubmitAgentForm', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(getSubmissionCapabilities).mockResolvedValue({ local_submissions: false })
    vi.mocked(getAuthorPrompt).mockResolvedValue({ season_id: 'flappy_bird-iter-1', prompt: null })
    vi.mocked(setAuthorPrompt).mockResolvedValue({ ok: true, prompt: 'reward smooth play' })
  })

  it('renders an optional action before verification and submission', () => {
    renderForm(true)
    const form = screen.getByLabelText('Public Repository URL').closest('form')
    const setup = within(form as HTMLElement).getByRole('button', { name: 'Set Up Locally' })
    const verify = within(form as HTMLElement).getByRole('button', { name: 'Verify reachability' })
    const submit = within(form as HTMLElement).getByRole('button', { name: 'Submit agent' })
    const actions = within(form as HTMLElement).getByRole('group', { name: 'Submission actions' })
    expect(actions).toContainElement(setup)
    expect(actions).toContainElement(verify)
    expect(actions).toContainElement(submit)
    expect(
      within(actions)
        .getAllByRole('button')
        .map((button) => button.textContent?.trim()),
    ).toEqual(['Set Up Locally', 'Verify reachability', 'Submit agent'])
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
    await fireEvent.update(screen.getByLabelText('Public Repository URL'), 'https://x/y')
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
    const view = renderForm()
    await verifyReachable()
    await fireEvent.click(screen.getByRole('button', { name: 'Submit agent' }))

    expect(await screen.findByText('overlay build kaboom')).toBeInTheDocument()
    expect(within(screen.getByTestId('stage-build')).getByText('failed')).toBeInTheDocument()
    expect(view.emitted().accepted).toEqual([['sub1']])
    expect(view.emitted().settled).toEqual([
      [expect.objectContaining({ id: 'sub1', status: 'build_failed' })],
    ])
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

  it('prefills the rating prompt from the existing season value', async () => {
    vi.mocked(getAuthorPrompt).mockResolvedValue({
      season_id: 'flappy_bird-iter-1',
      prompt: 'reward smooth play',
    })
    renderForm()
    const field = await screen.findByLabelText('Rating prompt (optional)')
    await vi.waitFor(() => expect(field).toHaveValue('reward smooth play'))
    expect(getAuthorPrompt).toHaveBeenCalledWith('flappy_bird-iter-1')
  })

  it('saves a changed rating prompt as soon as the submission is accepted and shows it on the ready banner', async () => {
    vi.mocked(checkReachability).mockResolvedValue({ reachable: true })
    vi.mocked(submitAgent).mockResolvedValue({ ok: true, id: 'sub1', status: 'pending' })
    vi.mocked(getSubmission).mockResolvedValue(detail('ready', [['resolve', 'passed']]))
    renderForm()
    await verifyReachable()
    await fireEvent.update(screen.getByLabelText('Rating prompt (optional)'), 'reward smooth play')
    await fireEvent.click(screen.getByRole('button', { name: 'Submit agent' }))

    expect(await screen.findByText(/Rating prompt saved\./)).toBeInTheDocument()
    expect(vi.mocked(setAuthorPrompt)).toHaveBeenCalledWith(
      'flappy_bird-iter-1',
      'reward smooth play',
    )
  })

  it('persists the rating prompt on acceptance even if the submission never reaches ready', async () => {
    vi.mocked(checkReachability).mockResolvedValue({ reachable: true })
    vi.mocked(submitAgent).mockResolvedValue({ ok: true, id: 'sub1', status: 'pending' })
    // The submission stays pending forever, modelling an author who leaves the page mid-validation.
    // The prompt must already be saved against the submission season, not waiting for a `ready` poll.
    vi.mocked(getSubmission).mockResolvedValue(detail('pending', [['resolve', 'running']]))
    renderForm()
    // Verify first so the onMounted prefill settles before typing; otherwise it would overwrite the field.
    await verifyReachable()
    await fireEvent.update(screen.getByLabelText('Rating prompt (optional)'), 'reward smooth play')
    await fireEvent.click(screen.getByRole('button', { name: 'Submit agent' }))

    await vi.waitFor(() =>
      expect(vi.mocked(setAuthorPrompt)).toHaveBeenCalledWith(
        'flappy_bird-iter-1',
        'reward smooth play',
      ),
    )
  })

  it('leaves the rating prompt untouched when the field is not edited', async () => {
    vi.mocked(getAuthorPrompt).mockResolvedValue({
      season_id: 'flappy_bird-iter-1',
      prompt: 'reward smooth play',
    })
    vi.mocked(checkReachability).mockResolvedValue({ reachable: true })
    vi.mocked(submitAgent).mockResolvedValue({ ok: true, id: 'sub1', status: 'pending' })
    vi.mocked(getSubmission).mockResolvedValue(detail('ready', [['resolve', 'passed']]))
    renderForm()
    await screen.findByLabelText('Rating prompt (optional)')
    await verifyReachable()
    await fireEvent.click(screen.getByRole('button', { name: 'Submit agent' }))

    await screen.findByText('Accepted.')
    expect(vi.mocked(setAuthorPrompt)).not.toHaveBeenCalled()
  })
})
