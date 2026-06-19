/**
 * The app sidebar's shared UI state, hoisted to module scope so the shell, the sidebar, and the mobile
 * bar all read one source. Two independent pieces:
 *
 * - `collapsed`: the desktop icon-rail toggle, persisted to localStorage so the choice survives a
 *   reload (the same per-browser persistence the identity override uses).
 * - `mobileOpen`: the off-canvas drawer's open state on narrow screens. Deliberately not persisted —
 *   a drawer is a momentary thing, reset on every load, and closed again on navigation by the shell.
 */
import { ref, watch } from 'vue'

/** The localStorage key for the persisted desktop-collapse choice. */
export const SIDEBAR_STORAGE_KEY = 'sandbox-sidebar-collapsed'

/** Read the persisted collapse choice, guarded because localStorage can be absent or throw. */
function storedCollapsed(): boolean {
  try {
    return globalThis.localStorage?.getItem(SIDEBAR_STORAGE_KEY) === '1'
  } catch {
    return false
  }
}

const collapsed = ref(storedCollapsed())
const mobileOpen = ref(false)

watch(collapsed, (value) => {
  try {
    globalThis.localStorage?.setItem(SIDEBAR_STORAGE_KEY, value ? '1' : '0')
  } catch {
    // A failed write (private mode, disabled storage) just means the choice does not persist.
  }
})

/** The shared sidebar state plus the actions the chrome triggers. */
export function useSidebar() {
  return {
    collapsed,
    mobileOpen,
    toggleCollapsed: () => {
      collapsed.value = !collapsed.value
    },
    toggleMobile: () => {
      mobileOpen.value = !mobileOpen.value
    },
    closeMobile: () => {
      mobileOpen.value = false
    },
  }
}
