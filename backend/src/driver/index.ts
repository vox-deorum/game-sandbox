/**
 * The execution driver interface, in driver-neutral terms.
 *
 * This module holds types only — no implementation, and deliberately no `dockerode` or any
 * other platform import. It is the seam from [execution.md](../../../specs/execution.md): the
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
 * What image a session needs. The only kind this stage builds is the session base image, keyed
 * by dependency-set version per [execution.md](../../../specs/execution.md). Stage 5 adds the
 * submission-overlay kind to this union; the union is the extension point.
 */
export type ImageSpec = SessionBaseImageSpec

/** The base image for a dependency-set version: Python, the harness, the environments, the deps. */
export interface SessionBaseImageSpec {
  kind: 'session-base'
  /** The dependency-set version `N`, tagged `…:deps-v<N>`. This stage needs only v1. */
  depsVersion: number
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
 * The container's network posture. `none` is the only value this stage uses; the internal,
 * gateway-only value for LLM-enabled sessions arrives in Stage 7 as a new member of this union.
 */
export type SandboxNetwork = 'none'

/**
 * The sandbox expressed in driver-neutral terms, per [execution.md](../../../specs/execution.md).
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
 * The execution driver: build or fetch images, and launch sessions against them. Two methods,
 * both async; everything else a session needs (its channel, its exit, its teardown) hangs off the
 * {@link SessionProcess} that `launch` returns.
 */
export interface ExecutionDriver {
  /**
   * Resolve an image for `spec`, building or fetching as needed. Whether an existing image is
   * reused or rebuilt is driver configuration (the Docker driver's `imagePolicy`), not caller
   * policy — the caller asks for an image and gets a launch-ready {@link ImageRef}.
   */
  ensureImage(spec: ImageSpec): Promise<ImageRef>
  /** Launch one session container and return its {@link SessionProcess}. */
  launch(spec: LaunchSpec): Promise<SessionProcess>
}
