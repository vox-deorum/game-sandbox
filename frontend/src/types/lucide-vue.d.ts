/*
 * Type shim for @lucide/vue. The package ships its declarations at dist/lucide-vue.d.ts but sets no
 * `types`/`exports` field, so Bundler resolution does not find them from the bare specifier. Re-export
 * them here from the concrete path so `import { House } from '@lucide/vue'` is typed.
 */
declare module '@lucide/vue' {
  export * from '@lucide/vue/dist/lucide-vue'
}
