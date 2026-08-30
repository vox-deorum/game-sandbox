<!--
  The global navigation column: brand at the top, the cross-cutting sections (Games, Seasons,
  Documentation, My Agents), and the account block pinned to the bottom. These are the student's
  cross-game jobs; the per-game tasks live in the contextual tab strip (ExperimentTabs), not here.

  It collapses to an icon rail on desktop (the persisted choice in useSidebar) and slides in as an
  off-canvas drawer on narrow screens. Active state is computed from the route rather than relying on
  RouterLink's prefix matching, because the "Games" root would otherwise read as active everywhere.
-->
<script setup lang="ts">
import { Bot, BookOpen, FileText, Gamepad2, PanelLeftClose, PanelLeftOpen, Trophy, Users, X } from '@lucide/vue'
import { computed, type FunctionalComponent } from 'vue'
import { RouterLink, useRoute } from 'vue-router'

import { useSidebar } from '../composables/useSidebar.js'
import { useSiteConfig } from '../composables/useSiteConfig.js'
import { isAdmin, useMe } from '../me.js'
import AccountMenu from './AccountMenu.vue'

interface NavItem {
  label: string
  to: string
  icon: FunctionalComponent
  /** Route-path prefixes that mark this item active. The root item uses both '/' and the game routes. */
  match: string[]
}

const baseItems: NavItem[] = [
  { label: 'Environments', to: '/', icon: Gamepad2, match: ['/', '/environments'] },
  { label: 'Seasons', to: '/seasons', icon: Trophy, match: ['/seasons'] },
  { label: 'Documentation', to: '/docs', icon: BookOpen, match: ['/docs'] },
  { label: 'My Agents', to: '/my/agents', icon: Bot, match: ['/my/agents'] },
]

const route = useRoute()
const me = useMe()
const { collapsed, toggleCollapsed, closeMobile } = useSidebar()
const { siteIconUrl, siteName } = useSiteConfig()

// The operator-only pages follow the student-facing items, with the roster before the process logs.
const items = computed<NavItem[]>(() =>
  isAdmin(me.me)
    ? [
        ...baseItems,
        { label: 'Users', to: '/admin/users', icon: Users, match: ['/admin/users'] },
        { label: 'Logs', to: '/admin/logs', icon: FileText, match: ['/admin/logs'] },
      ]
    : baseItems,
)

function isActive(item: NavItem): boolean {
  return item.match.some((prefix) =>
    prefix === '/' ? route.path === '/' : route.path === prefix || route.path.startsWith(`${prefix}/`),
  )
}
</script>

<template>
  <aside class="app-sidebar" aria-label="Primary">
    <div class="sidebar-head">
      <RouterLink
        class="brand"
        to="/"
        :aria-label="siteName"
        :title="collapsed ? siteName : undefined"
      >
        <img class="brand-icon" :src="siteIconUrl" alt="" aria-hidden="true" />
        <span class="brand-name">{{ siteName }}</span>
      </RouterLink>
      <button
        class="rail-toggle desktop-only"
        type="button"
        :aria-label="collapsed ? 'Expand sidebar' : 'Collapse sidebar'"
        @click="toggleCollapsed"
      >
        <component :is="collapsed ? PanelLeftOpen : PanelLeftClose" :size="18" />
      </button>
      <button class="rail-toggle mobile-only" type="button" aria-label="Close menu" @click="closeMobile">
        <X :size="18" />
      </button>
    </div>

    <nav class="sidebar-nav">
      <RouterLink
        v-for="item in items"
        :key="item.to"
        class="nav-item"
        :class="{ active: isActive(item) }"
        :to="item.to"
        :title="collapsed ? item.label : undefined"
        :aria-label="item.label"
      >
        <component :is="item.icon" class="nav-icon" :size="20" />
        <span class="nav-label">{{ item.label }}</span>
      </RouterLink>
    </nav>

    <AccountMenu class="sidebar-foot" />
  </aside>
</template>

<style scoped>
.app-sidebar {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 100vh;
  padding: var(--space-4) var(--space-3);
  border-right: 1px solid var(--color-border);
  background: var(--color-surface);
  gap: var(--space-4);
}

.sidebar-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-2);
  min-height: 32px;
}

.brand {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  min-width: 0;
}

.brand-icon {
  flex: none;
  width: 28px;
  height: 28px;
  border-radius: var(--radius-sm);
  object-fit: cover;
}

.brand-name {
  font-family: var(--font-heading);
  font-size: var(--text-lg);
  font-weight: 700;
  white-space: nowrap;
  overflow: hidden;
}

.rail-toggle {
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  border: none;
  background: transparent;
  color: var(--color-text-muted);
  border-radius: var(--radius-sm);
  cursor: pointer;
  transition: color var(--motion-fast) var(--ease-out), background-color var(--motion-fast) var(--ease-out);
}

.rail-toggle:hover {
  color: var(--color-text);
  background: var(--color-surface-raised);
}

.sidebar-nav {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  flex: 1 1 auto;
  min-height: 0;
}

.nav-item {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  padding: var(--space-2) var(--space-3);
  border-radius: var(--radius-sm);
  color: var(--color-text-muted);
  white-space: nowrap;
  transition: color var(--motion-fast) var(--ease-out), background-color var(--motion-fast) var(--ease-out);
}

.nav-item:hover {
  color: var(--color-text);
  background: var(--color-surface-raised);
}

.nav-item.active {
  color: var(--color-text);
  background: var(--color-surface-raised);
  font-weight: 600;
}

.nav-icon {
  flex: none;
}

.nav-label {
  overflow: hidden;
}

.sidebar-foot {
  margin-top: auto;
}

.mobile-only {
  display: none;
}

/* The collapsed-rail rules that key off the .app ancestor live in styles/app.css: a scoped block
   cannot select an ancestor without :global(), and :global() with a descendant miscompiles. */

@media (max-width: 768px) {
  .desktop-only {
    display: none;
  }

  .mobile-only {
    display: inline-flex;
  }
}
</style>
