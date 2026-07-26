/**
 * The execution driver interface, in driver-neutral terms.
 *
 * This module holds types only — no implementation, and deliberately no `dockerode` or any
 * other platform import. It is the seam from [execution.md](../../../docs/specs/execution.md): the
 * orchestrator builds or fetches an image, launches a session against a driver-neutral sandbox
 * profile, streams the session's line channel, and tears it down, all without knowing whether
 * the driver is Docker, Kubernetes, or a test double. The local Docker driver lives in a sibling
 * folder (`driver/docker/`, the one place `dockerode` is allowed); a Kubernetes driver is a pure
 * addition implementing this same interface, and nothing above this file changes.
 *
 * The bidirectional channel between backend and container is part of this abstraction, not
 * something the layer above selects: the interface promises an ordered, newline-delimited,
 * bidirectional UTF-8 text channel and says nothing about how it is carried. The Docker driver
 * carries it over attached stdio; a Kubernetes driver may use attach, exec, or a sidecar.
 */

/**
 * What image a session or a submission load check needs. The session base image is keyed by
 * dependency-set version per [execution.md](../../../docs/specs/execution.md); the
 * submission-overlay image (Stage 5.4) layers a single fetched submission's code onto that base for
 * a single-submission watch run; the session-overlay image (Stage 7.4) composes several submissions,
 * each in its own per-seat directory, for a multi-agent session. Every kind carries `depsVersion`.
 */
export type ImageSpec = SessionBaseImageSpec | SubmissionOverlayImageSpec | SessionOverlayImageSpec

/** The base image for a dependency-set version: Python, the harness, the environments, the deps. */
export interface SessionBaseImageSpec {
  kind: 'session-base'
  /** The dependency-set version `N`, tagged `…:deps-v<N>`. This stage needs only v1. */
  depsVersion: number
}

/**
 * A submission's overlay image (Stage 5.4): the base image for {@link depsVersion} with the
 * submitted code copied into its per-seat directory under `/opt/agents/submissions`. The overlay is
 * **code-only** — there is no per-submission dependency installation, since dependencies come
 * entirely from the versioned base image — so the build is fast. The tag is derived deterministically
 * from the driver's prefix, {@link depsVersion}, and {@link submissionId}, so a built image's
 * submission id is recoverable from its tag (the eviction sweep relies on this).
 */
export interface SubmissionOverlayImageSpec {
  kind: 'submission-overlay'
  /** The dependency-set version whose base image this overlay is built on. */
  depsVersion: number
  /** The submission this overlay belongs to; part of the deterministic tag. */
  submissionId: string
  /** Absolute host path to the prepared source tree (the step-2 checkout or a local-folder copy). */
  sourceTreePath: string
  /** The seat id whose directory the tree is copied into: `/opt/agents/submissions/<seatId>`. */
  seatId: string
}

/**
 * A multi-agent session's composed image: the base image for {@link depsVersion} with every
 * participating submission's code copied into its own per-seat directory under
 * `/opt/agents/submissions`, so one container hosts several submitted agents in isolation. Unlike
 * {@link SubmissionOverlayImageSpec} it is session-scoped, not a per-submission cache entry, so it
 * sits outside the overlay-eviction pool. The same submission may fill more than one seat, each staged
 * independently. The Docker driver composes it by chaining one single-seat overlay per seat onto the
 * base; a Kubernetes driver would map the same spec to its own build.
 */
export interface SessionOverlayImageSpec {
  kind: 'session-overlay'
  /** The dependency-set version whose base image this overlay is built on. */
  depsVersion: number
  /** The submission-filled seats, each staged into its own per-seat directory. */
  seats: SessionOverlaySeat[]
}

/** One submission-filled seat of a {@link SessionOverlayImageSpec}: whose code goes in which seat. */
export interface SessionOverlaySeat {
  /** The seat id whose directory the tree is copied into: `/opt/agents/submissions/<seatId>`. */
  seatId: string
  /** The submission whose code fills this seat. */
  submissionId: string
  /** Absolute host path to the prepared source tree (the snapshot materialization or a fresh clone). */
  sourceTreePath: string
}

/**
 * One overlay image the driver manages, as the eviction sweep (Stage 5.4) sees it: an opaque
 * {@link ref} to pass to {@link OverlayImageManager.removeImage}, the {@link submissionId} recovered
 * from its deterministic tag (so the sweep can exempt active-`ready` submissions without parsing tags
 * itself), and a creation timestamp for oldest-first eviction.
 */
export interface OverlayImage {
  ref: string
  submissionId: string
  /** Epoch milliseconds the image was created, for oldest-first eviction. */
  createdAtMs: number
}

/**
 * The driver-neutral overlay-image capability the eviction sweep drives: enumerate the overlay
 * images the driver manages (filtered to the overlay tag prefix, so base and unrelated images are
 * never touched) and remove one best-effort. Both are pure additions to {@link ExecutionDriver}; a
 * Kubernetes driver implements the same two methods, and nothing above the driver learns Docker
 * specifics.
 */
export interface OverlayImageManager {
  /** Enumerate the overlay images this driver manages, each with its submission id and age. */
  listOverlayImages(): Promise<OverlayImage[]>
  /** Remove one image by its opaque ref, tolerating an already-absent image (best-effort). */
  removeImage(ref: string): Promise<void>
}

/**
 * A resolved, launch-ready image. `ref` is whatever the driver hands its own `launch` to select
 * the image (a tag or id for Docker); callers treat it as opaque and only pass it back in a
 * {@link LaunchSpec}.
 */
export interface ImageRef {
  ref: string
}

/** A writable scratch area inside the otherwise read-only container. */
export interface ScratchSpec {
  containerPath: string
  sizeMb: number
}

/** A host directory mounted into the container — this stage's one use is the recordings volume. */
export interface MountSpec {
  hostPath: string
  containerPath: string
  readOnly: boolean
}

/**
 * The container's network posture. `llm` maps to an isolated per-session network whose only service
 * is the backend proxy relay; it never means general outbound network access.
 */
export type SandboxNetwork = 'none' | 'llm'

/**
 * The sandbox expressed in driver-neutral terms, per [execution.md](../../../docs/specs/execution.md).
 * Each driver maps these onto its platform (the Docker driver onto `NanoCpus`, `Memory`,
 * `ReadonlyRootfs`, `Tmpfs`, `NetworkMode`, and `Binds`).
 */
export interface SandboxProfile {
  cpus: number
  memoryMb: number
  /** Always true: the container root filesystem is read-only, with only {@link scratch} writable. */
  readOnlyRoot: true
  scratch: ScratchSpec
  network: SandboxNetwork
  mounts: MountSpec[]
}

/** Everything needed to launch one session container. */
export interface LaunchSpec {
  /** The image resolved by {@link ExecutionDriver.ensureImage}. */
  image: ImageRef
  /** Argv appended to the image entrypoint — the session config, see transport-and-live-runner. */
  argv: string[]
  /**
   * Replace the image's entrypoint instead of appending {@link argv} to it. The orchestrator
   * never sets this — a session always runs the image's live-runner entrypoint with the config
   * as `argv`. It exists for the driver-level sandbox tests (memory quota, no network), which
   * run an arbitrary command in the base image to exercise the profile mapping rather than a
   * real session; keeping it on the launch spec, not in the image, leaves the production image
   * free of test hooks. A Kubernetes driver maps it onto a container `command` the same way.
   */
  entrypoint?: string[]
  sandbox: SandboxProfile
  /** The session id, used by the driver to label the container for supervision and orphan reaping. */
  sessionId: string
}

/** How a session container exited, in driver-neutral terms. */
export interface ExitInfo {
  /** The process exit code (Docker `StatusCode`; a signal kill surfaces as its conventional code). */
  code: number
  /** Whether the platform killed the container for exceeding its memory quota (Docker `OOMKilled`,
   * Kubernetes `OOMKilled`). The orchestrator maps this to the `oom_killed` termination reason. */
  oomKilled: boolean
}

/**
 * A launched session and its line channel. The channel is ordered, newline-stripped, and
 * bidirectional; protocol framing on top of it is the concern of `protocol/`, not the driver.
 */
export interface SessionProcess {
  /** Protocol lines out of the session (newline-stripped UTF-8), in order. Ends when the session does. */
  output: AsyncIterable<string>
  /** Send one protocol line into the session. */
  send(line: string): void
  /** Session log output for the backend logger — never parsed as protocol. */
  diagnostics: AsyncIterable<string>
  /** Resolves when the session process exits, with its driver-neutral exit info. */
  exited: Promise<ExitInfo>
  /**
   * Forcefully tear the session down, escalating from a polite stop to a hard kill after
   * `graceMs`. This is the orchestrator's backstop; a graceful end is a protocol concern (the
   * `stop` command), not a driver call.
   */
  kill(graceMs: number): Promise<void>
}

/**
 * The execution driver: build or fetch images, launch containers against them, and (Stage 5.4)
 * enumerate and reclaim the overlay images it manages. Everything else a session needs (its channel,
 * its exit, its teardown) hangs off the {@link SessionProcess} that `launch` returns.
 */
export interface ExecutionDriver extends OverlayImageManager {
  /**
   * Resolve an image for `spec`, building or fetching as needed. Whether an existing image is
   * reused or rebuilt is driver configuration (the Docker driver's `imagePolicy`), not caller
   * policy — the caller asks for an image and gets a launch-ready {@link ImageRef}.
   */
  ensureImage(spec: ImageSpec): Promise<ImageRef>
  /** Launch one session container and return its {@link SessionProcess}. */
  launch(spec: LaunchSpec): Promise<SessionProcess>
}
