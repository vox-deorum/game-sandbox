/**
 * A Docker-free {@link WorkflowRunner} double for the admin-API suite. It records enqueues and
 * cancels, marks a cancel `cancelled` in storage (the runner owns the cooperative stop), and lets a
 * test drive a run's live event stream via {@link StubWorkflowRunner.emit}. This is what proves the
 * routes, gating, and streaming Docker-free; the real runner lands in Stage 6.4.
 */
import type { Storage } from '../../src/storage/index.js'
import type { RunEvent, RunEventListener, WorkflowRunner } from '../../src/workflow/runner.js'

export class StubWorkflowRunner implements WorkflowRunner {
  /** Run ids handed to {@link enqueue}, in order; proves the trigger enqueued without running Docker. */
  readonly enqueued: string[] = []
  /** Run ids handed to {@link cancel}, in order. */
  readonly cancelled: string[] = []
  private readonly listeners = new Map<string, Set<RunEventListener>>()

  constructor(private readonly storage?: Storage) {}

  enqueue(runId: string): void {
    this.enqueued.push(runId)
  }

  cancel(runId: string): void {
    this.cancelled.push(runId)
    if (this.storage !== undefined) {
      void this.storage.setRunStatus(runId, 'cancelled', 'cancelled by operator')
    }
  }

  shutdown(): Promise<void> {
    return Promise.resolve()
  }

  subscribe(runId: string, listener: RunEventListener): () => void {
    let set = this.listeners.get(runId)
    if (set === undefined) {
      set = new Set()
      this.listeners.set(runId, set)
    }
    set.add(listener)
    return () => {
      set?.delete(listener)
    }
  }

  /** Push one event to every current subscriber of a run (the test's stand-in for the live runner). */
  emit(runId: string, event: RunEvent): void {
    for (const listener of this.listeners.get(runId) ?? []) {
      listener(event)
    }
  }

  /** How many listeners are currently subscribed to a run; lets a test wait for an attach. */
  subscriberCount(runId: string): number {
    return this.listeners.get(runId)?.size ?? 0
  }
}
