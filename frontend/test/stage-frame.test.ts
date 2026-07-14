import { fireEvent, render, screen } from '@testing-library/vue'
import { describe, expect, it, vi } from 'vitest'

import StageFrame from '../src/components/StageFrame.vue'

describe('StageFrame', () => {
  it('owns the renderer host and forwards keyboard events from the labeled stage', async () => {
    const onRendererHost = vi.fn()
    const onKeydown = vi.fn()
    const view = render(StageFrame, {
      props: {
        aspectRatio: 0.75,
        logBeside: true,
        canvasLabel: 'Environment',
        stageLabel: 'Game stage',
        besideLogLabel: 'Decision log',
        onRendererHost,
        onKeydown,
      },
      slots: {
        overlay: '<span>Paused</span>',
        'beside-log': '<p>Decisions</p>',
        'below-log': '<details><summary>Chat</summary></details>',
      },
    })

    const stage = screen.getByRole('group', { name: 'Game stage' })
    expect(stage).toHaveClass('portrait', 'beside')
    expect(screen.getByText('Decisions').closest('section')).toHaveAttribute(
      'aria-label',
      'Decision log',
    )
    expect(onRendererHost.mock.calls[0]?.[0]).toBeInstanceOf(HTMLElement)

    await fireEvent.keyDown(stage, { key: 'ArrowRight' })
    expect(onKeydown).toHaveBeenCalledOnce()

    view.unmount()
    expect(onRendererHost).toHaveBeenLastCalledWith(null)
  })

  it('replaces log content with the shared loading status', () => {
    render(StageFrame, {
      props: {
        aspectRatio: null,
        logBeside: false,
        loading: true,
        loadingLabel: 'Loading replay…',
        canvasLabel: 'Replay',
      },
      slots: { 'below-log': '<p>Hidden log</p>' },
    })

    expect(screen.getByRole('status')).toHaveTextContent('Loading replay…')
    expect(screen.queryByText('Hidden log')).toBeNull()
  })
})
