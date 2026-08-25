/**
 * The singleton toast queue behind the UiToast primitive.
 *
 * A feature component calls `useToast().show(...)` for a transient, non-blocking notice (a blocked
 * guest action, for example); the one UiToast host mounted in AppShell.vue renders the queue
 * teleported to the body's bottom-center. The queue is module-level so the host and any caller share
 * one state without threading a provider, and each toast auto-dismisses after a few seconds or on
 * click.
 */
import { reactive } from 'vue'

/** One queued toast: a stable id the host keys and dismisses on. */
export interface ToastItem {
  id: number
  message: string
}

/** How long a toast stays up before auto-dismissing. */
const AUTODISMISS_MS = 4000

const state = reactive<{ toasts: ToastItem[] }>({ toasts: [] })
const timers = new Map<number, ReturnType<typeof setTimeout>>()
let nextId = 1

function dismissNow(id: number): void {
  const timer = timers.get(id)
  if (timer !== undefined) {
    clearTimeout(timer)
    timers.delete(id)
  }
  const index = state.toasts.findIndex((toast) => toast.id === id)
  if (index !== -1) {
    state.toasts.splice(index, 1)
  }
}

/** Show a transient notice, and the shared state the UiToast host renders. */
export function useToast(): {
  show(message: string): void
  dismiss(id: number): void
  toasts: ToastItem[]
} {
  function show(message: string): void {
    const id = nextId
    nextId += 1
    state.toasts.push({ id, message })
    timers.set(
      id,
      setTimeout(() => dismissNow(id), AUTODISMISS_MS),
    )
  }
  return { show, dismiss: dismissNow, toasts: state.toasts }
}
