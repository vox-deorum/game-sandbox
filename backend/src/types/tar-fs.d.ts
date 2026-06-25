/**
 * `@types/tar-fs` (v2) omits the `sort` pack option, but `tar-fs@2.1.4` honors it (`index.js` passes
 * `opts.sort` into its directory walk and calls `files.sort()`). We rely on a deterministic entry order
 * so a submission's snapshot and its overlay build context produce byte-identical archives. Augment the
 * published interface rather than casting at each call site.
 */
import 'tar-fs'

declare module 'tar-fs' {
  interface PackOptions {
    /** When true, directory entries are sorted for a deterministic, byte-stable archive. */
    sort?: boolean | undefined
  }
}
