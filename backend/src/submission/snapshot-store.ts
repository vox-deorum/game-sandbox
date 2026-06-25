/**
 * The submission-snapshot store: the durable, on-disk copy of a submission's checked-out source tree,
 * written once the size check passes (Stage 5.5). It mirrors `RecordingsStore` (one flat file per id
 * under a single root), but the unit is a gzipped tar of the filtered tree (`<root>/<id>.tar.gz`).
 *
 * The snapshot serves two later needs: an operator download (stream the file) and an overlay rebuild
 * after the cached image was evicted (materialize the tree and rebuild, instead of re-cloning the
 * pinned commit, which fails if the participant force-pushed or deleted it). Because the pack uses the
 * same shared filter and deterministic sort as the overlay build context, a rebuild reproduces the
 * original overlay's `COPY` payload. The filter excludes `.git` and build artifacts, so a snapshot is
 * the submitted code, not the repository history.
 */
import { createReadStream, createWriteStream } from 'node:fs'
import { mkdir, mkdtemp, rename, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { createGunzip, createGzip } from 'node:zlib'

import tar from 'tar-fs'

import type { TreeHandle } from './source/index.js'
import { submissionTarIgnore } from './tree-filter.js'

/** Raised by {@link SubmissionSnapshotStore.materialize} when no snapshot exists for the id. */
export class SnapshotMissingError extends Error {
  constructor(submissionId: string) {
    super(`no snapshot for submission ${submissionId}`)
    this.name = 'SnapshotMissingError'
  }
}

export class SubmissionSnapshotStore {
  constructor(private readonly root: string) {}

  /**
   * Pack the filtered tree at `sourceTreePath` into `<root>/<id>.tar.gz`. The pack uses the shared
   * submission filter (drops `.git`, `node_modules`, …) and a deterministic sort so the archive is
   * byte-stable. The write goes to a `.tmp` sibling and is renamed into place, so a crash mid-write
   * never leaves a truncated archive that later reads as a valid (but incomplete) snapshot.
   */
  async write(id: string, sourceTreePath: string): Promise<void> {
    await mkdir(this.root, { recursive: true })
    const finalPath = this.filePath(id)
    const tmpPath = `${finalPath}.tmp`
    try {
      await pipeline(
        tar.pack(sourceTreePath, { ignore: submissionTarIgnore(sourceTreePath), sort: true }),
        createGzip(),
        createWriteStream(tmpPath),
      )
      await rename(tmpPath, finalPath)
    } catch (error) {
      await rm(tmpPath, { force: true }).catch(() => undefined)
      throw error
    }
  }

  /** A readable stream of the stored `.tar.gz` bytes, for the operator download endpoint. */
  stream(id: string): Readable {
    return createReadStream(this.filePath(id))
  }

  /** Whether a snapshot exists for this submission on the volume. */
  async exists(id: string): Promise<boolean> {
    try {
      await stat(this.filePath(id))
      return true
    } catch {
      return false
    }
  }

  /**
   * Extract the snapshot into a fresh temp directory and return a {@link TreeHandle}, a drop-in for the
   * source seam's `fetchTree` result: the rebuild path builds an overlay from `handle.path` and disposes
   * it the same way. This is the single read-and-extract operation (no separate `exists` pre-check, so
   * no stat race); it throws {@link SnapshotMissingError} when absent, which the caller catches to fall
   * back to git for a pre-snapshot row.
   */
  async materialize(id: string): Promise<TreeHandle> {
    const dir = await mkdtemp(join(tmpdir(), 'gs-snapshot-'))
    let disposed = false
    const handle: TreeHandle = {
      path: dir,
      dispose: async () => {
        if (disposed) {
          return
        }
        disposed = true
        await rm(dir, { recursive: true, force: true })
      },
    }
    try {
      await this.materializeInto(id, dir)
      return handle
    } catch (error) {
      await handle.dispose()
      throw error
    }
  }

  /**
   * Extract the snapshot directly into a caller-owned directory (the caller owns its lifetime), used by
   * the whole-season archive. Like {@link materialize}, this is the single operation: a missing snapshot
   * surfaces as {@link SnapshotMissingError} from the read itself rather than a separate `exists` check.
   */
  async materializeInto(id: string, destDir: string): Promise<void> {
    await mkdir(destDir, { recursive: true })
    try {
      await pipeline(createReadStream(this.filePath(id)), createGunzip(), tar.extract(destDir))
    } catch (error) {
      // The only ENOENT source here is the snapshot file (destDir was just created); map it to the typed
      // miss so callers can branch on it without their own stat.
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new SnapshotMissingError(id)
      }
      throw error
    }
  }

  /** Remove a submission's snapshot, tolerant of absence (so a retried cleanup never throws). */
  async delete(id: string): Promise<void> {
    await rm(this.filePath(id), { force: true })
  }

  private filePath(id: string): string {
    return join(this.root, `${id}.tar.gz`)
  }
}
