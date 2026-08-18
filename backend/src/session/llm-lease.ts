/**
 * The launch-scoped LLM lease handle shared by the two launch owners: the live orchestrator and the
 * headless workflow runner. Both issue an official lease (`official-grants.ts`) and stage its
 * per-player keys into a read-only mounted file (`llm-keys-file.ts`), then must tear both down
 * together on every exit path.
 *
 * The pairing is one resource, not two: a keys-file write that fails after a successful issue must
 * not strand a live, chargeable grant, and a later failure must remove the staged key material as
 * well. The handle stages both through one {@link stage}, derives the exact argv block and sandbox
 * mount from the staged file ({@link block} and {@link withKeysMount}), and tears both down through
 * one idempotent {@link teardown}. Every error path then needs only the single teardown call — there
 * is no second resource a catch block can forget to clean up. The two launch owners still decide
 * their own issuance inputs and how a failure surfaces (an HTTP error versus an infrastructure
 * fault); they share how the resources are owned and released.
 */
import type { MountSpec } from '../driver/index.js'
import { assembleLlmKeysFileConfig, type LlmKeysFileConfig } from './launch-config.js'
import { type LlmKeysFileHandoff, writeLlmKeysFile } from './llm-keys-file.js'
import type {
  IssueOfficialGrantsInput,
  OfficialGrantIssuer,
  OfficialGrantLease,
} from './official-grants.js'

/** One launch's official lease plus its staged keys file, staged and torn down as a single unit. */
export class LlmLeaseHandle {
  private leaseValue: OfficialGrantLease | undefined
  private keysFile: LlmKeysFileHandoff | null = null

  /** The issued official lease once {@link stage} succeeds; `undefined` before then. */
  get lease(): OfficialGrantLease | undefined {
    return this.leaseValue
  }

  /**
   * Issue the official lease for `input` and stage its per-player keys to a session-scoped read-only
   * file. On a throw the handle retains whatever was already acquired — the lease, or the lease plus
   * a staged file — so the caller's error path only ever needs the one {@link teardown} call. Returns
   * the issued lease so callers that register it elsewhere (the workflow's in-flight table, watchdogs)
   * can without reading the handle back.
   */
  async stage(
    issuer: OfficialGrantIssuer,
    input: IssueOfficialGrantsInput,
    keysDir: string,
    sessionId: string,
  ): Promise<OfficialGrantLease> {
    const lease = await issuer.issue(input)
    this.leaseValue = lease
    this.keysFile = await writeLlmKeysFile(keysDir, sessionId, lease.keys)
    return lease
  }

  /** The session-config argv block: a `keys_file` pointer when a file is staged, no block otherwise. */
  block(internalPort: number): LlmKeysFileConfig | Record<string, never> {
    return this.keysFile === null
      ? {}
      : assembleLlmKeysFileConfig(internalPort, this.keysFile.keysFile)
  }

  /** Append the staged keys-file mount (when present) to a caller's base sandbox mount list. */
  withKeysMount(base: readonly MountSpec[]): MountSpec[] {
    return [...base, ...(this.keysFile === null ? [] : [this.keysFile.mount])]
  }

  /**
   * Remove the staged keys file and revoke the official lease together. Safe on every path: before
   * either resource exists, after a partial {@link stage} failure, and repeated — the underlying
   * cleanup (`rm --force`) and lease revocation are both idempotent.
   */
  async teardown(): Promise<void> {
    await this.keysFile?.cleanup()
    await this.leaseValue?.revoke()
  }
}
