/**
 * The static validator (Stage 5.3): a pure check over a fetched tree (the read-only checkout from
 * step 2) that runs **no participant code**. It mirrors the static half of the harness loader
 * (`load_manifest` in [manifest.py](../../../../harness/src/game_sandbox_harness/manifest.py)) plus
 * the checks this layer owns — entry-point-file existence, a known `template_version`, and matching
 * the open iteration's `deps_version` — and returns either a typed accept or one specific,
 * owner-visible rejection reason.
 *
 * The function is the first manifest gate in the submission pipeline and the first demonstrable slice
 * of the stage: a tree that fails it never reaches the sandboxed load check or the build. It stays a
 * pure function — it returns the typed accept/reason and the worker (step 5) is what writes the
 * per-stage validation log — so it is fully unit-testable against local fixtures with no Docker.
 *
 * The required-fields, field-types, and no-unknown-keys rules are the shared manifest contract; this
 * file and `manifest.py` are kept deliberately in lockstep (a change to one is a change to both).
 */
import { readFile, realpath, stat } from 'node:fs/promises'
import { join, sep } from 'node:path'

import { z } from 'zod'

const MANIFEST_FILENAME = 'manifest.json'
/** The manifest's required keys, in the order field errors are reported. Lockstep with manifest.py. */
const REQUIRED_FIELDS = ['entry_point', 'class_name', 'template_version'] as const

/**
 * The manifest contract as a single strict zod object: exactly the required fields, the right types,
 * and no unknown keys (`strictObject` rejects extras). It and `manifest.py` are kept deliberately in
 * lockstep. {@link checkFields} maps a parse failure back to the closed {@link StaticReason} set so
 * the owner-visible code/field/key vocabulary is unchanged by the validation-library switch.
 */
const MANIFEST_SCHEMA = z.strictObject({
  entry_point: z.string().min(1),
  class_name: z.string().min(1),
  // typeof distinguishes a JSON number from a JSON boolean (unlike Python), and `.int()` rejects a
  // float like 1.5, matching the prior hand-written guard.
  template_version: z.number().int(),
})

/** A parsed, validated `manifest.json`, mirroring the harness `Manifest` dataclass. */
export type ParsedManifest = z.infer<typeof MANIFEST_SCHEMA>

/**
 * The closed set of static rejection reasons, each carrying an owner-facing `message`. The codes
 * trace to [submission.md](../../../../docs/specs/submission.md)'s static-checks list; the worker
 * (step 5) records the offending code as the failed `static` stage's detail. Reachability and
 * ref-resolution failures from step 2 are folded into the same vocabulary by the worker, not here.
 */
export type StaticReason =
  | { code: 'manifest_missing'; message: string }
  | { code: 'manifest_invalid_json'; message: string }
  | { code: 'manifest_field_invalid'; field: string; message: string }
  | { code: 'manifest_unknown_key'; key: string; message: string }
  | { code: 'entry_point_missing'; message: string }
  | { code: 'unknown_template_version'; message: string }
  | { code: 'template_version_mismatch'; message: string }

/** A typed accept with the parsed manifest, or a typed rejection with one specific reason. */
export type StaticResult =
  | { ok: true; manifest: ParsedManifest }
  | { ok: false; reason: StaticReason }

/**
 * Run the static checks over the tree rooted at `treeRoot` (a {@link TreeHandle.path}). `depsVersion`
 * is the open iteration's pinned dependency-set version; `knownTemplateVersions` is the set of
 * versions the deployment has a base image for. The checks run in the order of the spec's list and
 * short-circuit on the first failure.
 */
export async function validateStatic(
  treeRoot: string,
  depsVersion: number,
  knownTemplateVersions: ReadonlySet<number>,
): Promise<StaticResult> {
  // Resolve the tree root's real path up front so every subsequent containment check compares against
  // a canonical prefix: a temp checkout dir can itself sit behind a symlink (e.g. /var -> /private/var
  // on macOS), so without this the manifest/entry-point real paths would never match a non-canonical
  // root and every tree would look like an escape.
  let realRoot: string
  try {
    realRoot = await realpath(treeRoot)
  } catch {
    // The tree root itself is gone — treat as a missing manifest rather than crashing the worker.
    return reject({
      code: 'manifest_missing',
      message: `no ${MANIFEST_FILENAME} at the repository root`,
    })
  }

  // 1-2: manifest.json present at the tree root (and not symlinked out of it) and valid JSON.
  const manifestPath = await containedFile(realRoot, join(realRoot, MANIFEST_FILENAME))
  if (manifestPath === null) {
    return reject({
      code: 'manifest_missing',
      message: `no ${MANIFEST_FILENAME} at the repository root`,
    })
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(await readFile(manifestPath, 'utf8'))
  } catch (error) {
    return reject({
      code: 'manifest_invalid_json',
      message: `${MANIFEST_FILENAME} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    })
  }

  // 3: exactly the required fields, right types, no unknown keys.
  const fieldsResult = checkFields(parsed)
  if (!fieldsResult.ok) {
    return fieldsResult
  }
  const manifest = fieldsResult.manifest

  // 4: the named entry-point module file exists inside the tree (and is not symlinked out of it).
  if (!(await entryPointExists(realRoot, manifest.entry_point))) {
    return reject({
      code: 'entry_point_missing',
      message: `entry-point module '${manifest.entry_point}' names no file in the repository (looked for ${manifest.entry_point.replace(/\./g, '/')}.py or ${manifest.entry_point.replace(/\./g, '/')}/__init__.py)`,
    })
  }

  // 5: the template_version has a deployment base image. In the single-version Stage 5 deployment any
  // version other than 1 stops here, so check 6 only becomes reachable on a multi-version deployment.
  if (!knownTemplateVersions.has(manifest.template_version)) {
    return reject({
      code: 'unknown_template_version',
      message: `template_version ${manifest.template_version} has no base image on this deployment`,
    })
  }

  // 6: the template_version matches the open iteration's pinned deps_version.
  if (manifest.template_version !== depsVersion) {
    return reject({
      code: 'template_version_mismatch',
      message: `template_version ${manifest.template_version} does not match the open iteration's dependency set (version ${depsVersion})`,
    })
  }

  return { ok: true, manifest }
}

/** The per-field "what was wrong" message, shared by the missing and bad-type cases (lockstep). */
const FIELD_MESSAGE: Record<(typeof REQUIRED_FIELDS)[number], string> = {
  entry_point: "field 'entry_point' must be a non-empty string",
  class_name: "field 'class_name' must be a non-empty string",
  template_version: "field 'template_version' must be an integer",
}

/**
 * Validate the parsed JSON against {@link MANIFEST_SCHEMA} and translate the first relevant zod issue
 * into the closed {@link StaticReason} vocabulary, preserving the prior reporting order: a missing or
 * mistyped required field (in {@link REQUIRED_FIELDS} order) before an unknown key. The codes/fields
 * are exactly what the worker records and the form shows, so the switch to zod is invisible to them.
 */
function checkFields(
  parsed: unknown,
): { ok: true; manifest: ParsedManifest } | { ok: false; reason: StaticReason } {
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return reject({
      code: 'manifest_invalid_json',
      message: `${MANIFEST_FILENAME} must be a JSON object`,
    })
  }

  const result = MANIFEST_SCHEMA.safeParse(parsed)
  if (result.success) {
    return { ok: true, manifest: result.data }
  }
  const issues = result.error.issues

  // A required field that is missing or has the wrong type, reported in declaration order.
  for (const field of REQUIRED_FIELDS) {
    if (issues.some((issue) => issue.path[0] === field)) {
      return reject({ code: 'manifest_field_invalid', field, message: FIELD_MESSAGE[field] })
    }
  }

  // An unknown key (strictObject's `unrecognized_keys` issue), naming the first offending key.
  const unknown = issues.find((issue) => issue.code === 'unrecognized_keys')
  if (unknown !== undefined && 'keys' in unknown && Array.isArray(unknown.keys)) {
    const key = [...(unknown.keys as string[])].sort()[0] ?? ''
    return reject({
      code: 'manifest_unknown_key',
      key,
      message: `${MANIFEST_FILENAME} has unknown key '${key}'; allowed keys are ${REQUIRED_FIELDS.join(', ')}`,
    })
  }

  // No issue should fall through, but keep a typed rejection rather than throwing if one does.
  return reject({
    code: 'manifest_invalid_json',
    message: `${MANIFEST_FILENAME} does not match the manifest contract`,
  })
}

/**
 * Does the manifest's entry point name a file inside the tree? Treat `entry_point` as a Python module
 * path rooted at the repo: `agent` resolves to `agent.py` or `agent/__init__.py`, `package.agent` to
 * `package/agent.py` or `package/agent/__init__.py`. Existence of **either** candidate passes — this
 * is deliberately looser than CPython's package-over-module precedence, because step 4's load check
 * imports under real Python semantics and is the authority on which file loads; this layer only rules
 * out the "named a file that simply isn't there" case. Each candidate must resolve inside the tree
 * root and not follow a symlink out of it (the check runs in the unsandboxed backend over an
 * attacker-influenced checkout), mirroring the harness's own out-of-root rejection.
 */
async function entryPointExists(realRoot: string, entryPoint: string): Promise<boolean> {
  const relative = entryPoint.split('.')
  const moduleFile = join(realRoot, `${relative.join(sep)}.py`)
  const packageFile = join(realRoot, ...relative, '__init__.py')
  for (const candidate of [moduleFile, packageFile]) {
    if ((await containedFile(realRoot, candidate)) !== null) {
      return true
    }
  }
  return false
}

/**
 * Resolve `candidate` to its real path and return it only when it is an existing regular file whose
 * real path stays inside `realRoot`; otherwise null. Resolving the whole chain with `realpath` catches
 * an escape through any symlinked component, not just the final one.
 */
async function containedFile(realRoot: string, candidate: string): Promise<string | null> {
  let real: string
  try {
    real = await realpath(candidate)
  } catch {
    return null
  }
  if (real !== realRoot && !real.startsWith(realRoot + sep)) {
    return null
  }
  try {
    const info = await stat(real)
    return info.isFile() ? real : null
  } catch {
    return null
  }
}

function reject(reason: StaticReason): { ok: false; reason: StaticReason } {
  return { ok: false, reason }
}
