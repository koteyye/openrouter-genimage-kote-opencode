import { randomBytes } from "node:crypto"
import { lstat, mkdir, realpath } from "node:fs/promises"
import path from "node:path"

import { PluginError } from "../openrouter/errors.js"
import {
  isPathInside,
  sameCanonicalPath,
} from "../references/project-files.js"
import {
  outputFormatFromExtension,
  type DetectedOutputImageFormat,
} from "../references/formats.js"

export interface OutputPathRequest {
  worktree: string
  outputDirectory: string
  outputPath?: string | undefined
  detectedFormats: readonly DetectedOutputImageFormat[]
  sourcePaths?: readonly string[] | undefined
  now?: Date | undefined
  randomId?: (() => string) | undefined
}

export interface PlannedOutputPath {
  absolutePath: string
  relativePath: string
  filename: string
  warnings: string[]
  /** Unsuffixed candidate used to continue a collision sequence atomically. */
  collisionBaseRelativePath: string
  collisionNumber: number
}

export interface OutputPathPlan {
  canonicalWorktree: string
  paths: PlannedOutputPath[]
}

const WINDOWS_DRIVE_PREFIX = /^[A-Za-z]:/u
const WINDOWS_UNC_PREFIX = /^(?:\\\\|\/\/)/u

function pathError(message: string): PluginError {
  return new PluginError("GENIMAGE_OUTPUT_PATH_INVALID", message)
}

function outsideError(message: string, cause?: unknown): PluginError {
  return new PluginError("GENIMAGE_OUTPUT_OUTSIDE_WORKTREE", message, {
    ...(cause === undefined ? {} : { cause }),
  })
}

function normalizeSeparators(value: string): string {
  return value.replaceAll("\\", "/")
}

function toNativeRelativePath(value: string): string {
  return normalizeSeparators(value).split("/").join(path.sep)
}

function portableRelativePath(value: string): string {
  return value.split(path.sep).join("/")
}

function containsControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index)
    if (codeUnit <= 0x1f || codeUnit === 0x7f) return true
  }
  return false
}

function pathExistsError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  )
}

/** Validate a portable, worktree-relative path without resolving it. */
export function assertSafeOutputRelativePath(
  value: string,
  kind: "file" | "directory" = "file",
): string {
  const portable = normalizeSeparators(value)
  const segments = portable.split("/")
  if (
    value.trim() === "" ||
    containsControlCharacter(value) ||
    path.posix.isAbsolute(portable) ||
    path.win32.isAbsolute(value) ||
    WINDOWS_DRIVE_PREFIX.test(value) ||
    WINDOWS_UNC_PREFIX.test(value)
  ) {
    throw pathError("Output paths must be relative to the OpenCode worktree.")
  }
  if (segments.includes("..")) {
    throw outsideError("The output path may not traverse outside the worktree.")
  }
  if (
    kind === "file" &&
    (portable.endsWith("/") || segments.at(-1) === "" || segments.at(-1) === ".")
  ) {
    throw pathError("The output path must name a file, not a directory.")
  }
  return portable
}

export function isExistingPathError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "EEXIST"
  )
}

export async function findNearestExistingAncestor(value: string): Promise<string> {
  let current = path.resolve(value)
  let atFilesystemRoot = false
  while (!atFilesystemRoot) {
    try {
      await lstat(current)
      return current
    } catch (error) {
      if (!pathExistsError(error)) throw error
    }
    const parent = path.dirname(current)
    atFilesystemRoot = parent === current
    current = parent
  }
  throw outsideError("No existing output ancestor was found.")
}

export async function assertOutputParentContained(
  canonicalWorktree: string,
  parent: string,
): Promise<void> {
  let ancestor: string
  let canonicalAncestor: string
  try {
    ancestor = await findNearestExistingAncestor(parent)
    canonicalAncestor = await realpath(ancestor)
  } catch (error) {
    if (error instanceof PluginError) throw error
    throw new PluginError(
      "GENIMAGE_OUTPUT_WRITE_FAILED",
      "The output directory could not be inspected.",
      { cause: error },
    )
  }
  if (!isPathInside(canonicalWorktree, canonicalAncestor)) {
    throw outsideError("The output directory resolves outside the worktree.")
  }
}

/** Create an output parent, then canonicalize it again to catch symlink escapes. */
export async function ensureSafeOutputParent(
  canonicalWorktree: string,
  parent: string,
): Promise<string> {
  await assertOutputParentContained(canonicalWorktree, parent)
  try {
    await mkdir(parent, { recursive: true })
    const canonicalParent = await realpath(parent)
    if (!isPathInside(canonicalWorktree, canonicalParent)) {
      throw outsideError("The output directory resolves outside the worktree.")
    }
    return canonicalParent
  } catch (error) {
    if (error instanceof PluginError) throw error
    throw new PluginError(
      "GENIMAGE_OUTPUT_WRITE_FAILED",
      "The output directory could not be created.",
      { cause: error },
    )
  }
}

export async function recheckSafeOutputParent(
  canonicalWorktree: string,
  parent: string,
): Promise<void> {
  let canonicalParent: string
  try {
    canonicalParent = await realpath(parent)
  } catch (error) {
    throw new PluginError(
      "GENIMAGE_OUTPUT_WRITE_FAILED",
      "The output directory could not be verified before publication.",
      { cause: error },
    )
  }
  if (!isPathInside(canonicalWorktree, canonicalParent)) {
    throw outsideError("The output directory changed to point outside the worktree.")
  }
}

function utcTimestamp(value: Date): string {
  if (!Number.isFinite(value.getTime())) throw new TypeError("now must be a valid Date")
  return value.toISOString().replaceAll("-", "").replaceAll(":", "").replace(".", "")
}

function safeShortId(randomId: (() => string) | undefined): string {
  const supplied = randomId?.()
  const normalized = supplied?.replace(/[^A-Za-z0-9_-]/gu, "").slice(0, 12)
  return normalized === undefined || normalized === ""
    ? randomBytes(4).toString("hex")
    : normalized
}

function replaceWithActualExtension(
  relativePath: string,
  detected: DetectedOutputImageFormat,
): { relativePath: string; warning?: string | undefined } {
  const parsed = path.posix.parse(relativePath)
  const requestedFormat = outputFormatFromExtension(parsed.ext)
  if (requestedFormat === detected.format) return { relativePath }

  const corrected = path.posix.join(
    parsed.dir,
    `${parsed.name === "" ? parsed.base : parsed.name}${detected.extension}`,
  )
  if (parsed.ext === "") return { relativePath: corrected }
  return {
    relativePath: corrected,
    warning: `Output extension ${parsed.ext} did not match the returned ${detected.format.toUpperCase()} bytes; the file was saved as ${detected.extension}.`,
  }
}

function addOrdinalSuffix(
  relativePath: string,
  index: number,
  count: number,
): string {
  if (count === 1) return relativePath
  const parsed = path.posix.parse(relativePath)
  const width = Math.max(2, String(count).length)
  return path.posix.join(
    parsed.dir,
    `${parsed.name}-${String(index + 1).padStart(width, "0")}${parsed.ext}`,
  )
}

export function addCollisionSuffix(relativePath: string, collision: number): string {
  if (collision < 2 || !Number.isSafeInteger(collision)) {
    throw new TypeError("collision must be an integer greater than one")
  }
  const parsed = path.posix.parse(relativePath)
  return path.posix.join(parsed.dir, `${parsed.name}-${collision}${parsed.ext}`)
}

async function canonicalizeSourcePaths(
  worktree: string,
  sourcePaths: readonly string[],
): Promise<string[]> {
  return Promise.all(
    sourcePaths.map(async (source) => {
      const absolute = path.isAbsolute(source) ? path.resolve(source) : path.resolve(worktree, source)
      try {
        return await realpath(absolute)
      } catch {
        return absolute
      }
    }),
  )
}

function assertNotSource(
  target: string,
  canonicalTarget: string | undefined,
  sourcePaths: readonly string[],
): void {
  if (
    sourcePaths.some(
      (source) =>
        sameCanonicalPath(source, target) ||
        (canonicalTarget !== undefined && sameCanonicalPath(source, canonicalTarget)),
    )
  ) {
    throw new PluginError(
      "GENIMAGE_SOURCE_OVERWRITE_FORBIDDEN",
      "The output path may not overwrite a source image.",
    )
  }
}

async function inspectTarget(
  target: string,
  canonicalWorktree: string,
  sourcePaths: readonly string[],
): Promise<{ exists: boolean; isDirectory: boolean }> {
  let stats
  try {
    stats = await lstat(target)
  } catch (error) {
    if (pathExistsError(error)) {
      assertNotSource(target, undefined, sourcePaths)
      return { exists: false, isDirectory: false }
    }
    throw new PluginError(
      "GENIMAGE_OUTPUT_WRITE_FAILED",
      "The output path could not be inspected.",
      { cause: error },
    )
  }

  let canonicalTarget: string
  try {
    canonicalTarget = await realpath(target)
  } catch (error) {
    throw new PluginError(
      "GENIMAGE_OUTPUT_WRITE_FAILED",
      "The existing output path could not be resolved.",
      { cause: error },
    )
  }
  if (!isPathInside(canonicalWorktree, canonicalTarget)) {
    throw outsideError("The output path resolves outside the worktree.")
  }
  assertNotSource(target, canonicalTarget, sourcePaths)
  return { exists: true, isDirectory: stats.isDirectory() }
}

function resolveInsideLexically(worktree: string, relativePath: string): string {
  const target = path.resolve(worktree, toNativeRelativePath(relativePath))
  if (!isPathInside(path.resolve(worktree), target)) {
    throw outsideError("The output path escapes the worktree.")
  }
  return target
}

/**
 * Plans non-conflicting destinations. This is advisory only: the writer still
 * uses an atomic no-clobber operation to close the check/write race.
 */
export async function planOutputPaths(
  request: OutputPathRequest,
): Promise<OutputPathPlan> {
  if (request.detectedFormats.length === 0) {
    return { canonicalWorktree: await realpath(request.worktree), paths: [] }
  }

  let canonicalWorktree: string
  try {
    canonicalWorktree = await realpath(request.worktree)
  } catch (error) {
    throw new PluginError(
      "GENIMAGE_OUTPUT_WRITE_FAILED",
      "The OpenCode worktree could not be resolved.",
      { cause: error },
    )
  }

  const outputDirectory = assertSafeOutputRelativePath(
    request.outputDirectory,
    "directory",
  )
  const requestedOutput =
    request.outputPath === undefined
      ? undefined
      : assertSafeOutputRelativePath(request.outputPath)
  const basePath =
    requestedOutput ??
    `${outputDirectory.replace(/\/$/u, "")}/generated-${utcTimestamp(request.now ?? new Date())}-${safeShortId(request.randomId)}`
  const sourcePaths = await canonicalizeSourcePaths(
    request.worktree,
    request.sourcePaths ?? [],
  )

  // An explicit path naming a source is forbidden even when multi-image
  // suffixing would otherwise make the eventual paths different.
  if (requestedOutput !== undefined) {
    const requestedAbsolute = resolveInsideLexically(request.worktree, requestedOutput)
    let canonicalRequested: string | undefined
    try {
      canonicalRequested = await realpath(requestedAbsolute)
      const requestedStats = await lstat(requestedAbsolute)
      if (requestedStats.isDirectory()) {
        throw pathError("The output path points to an existing directory.")
      }
    } catch (error) {
      if (error instanceof PluginError) throw error
      if (!pathExistsError(error)) {
        throw new PluginError(
          "GENIMAGE_OUTPUT_WRITE_FAILED",
          "The requested output path could not be inspected.",
          { cause: error },
        )
      }
    }
    assertNotSource(requestedAbsolute, canonicalRequested, sourcePaths)
  }

  const planned: PlannedOutputPath[] = []
  const reserved = new Set<string>()
  for (const [index, detected] of request.detectedFormats.entries()) {
    const corrected = replaceWithActualExtension(basePath, detected)
    const ordinal = addOrdinalSuffix(
      corrected.relativePath,
      index,
      request.detectedFormats.length,
    )
    let selected = false
    for (let collision = 1; collision < Number.MAX_SAFE_INTEGER; collision += 1) {
      const relativePath =
        collision === 1 ? ordinal : addCollisionSuffix(ordinal, collision)
      const absolutePath = resolveInsideLexically(request.worktree, relativePath)
      await assertOutputParentContained(canonicalWorktree, path.dirname(absolutePath))
      const inspection = await inspectTarget(
        absolutePath,
        canonicalWorktree,
        sourcePaths,
      )
      if (inspection.isDirectory) {
        throw pathError("The output path points to an existing directory.")
      }
      const key = process.platform === "win32" ? absolutePath.toLowerCase() : absolutePath
      if (!inspection.exists && !reserved.has(key)) {
        reserved.add(key)
        planned.push({
          absolutePath,
          relativePath: portableRelativePath(path.relative(request.worktree, absolutePath)),
          filename: path.basename(absolutePath),
          warnings:
            corrected.warning === undefined ? [] : [corrected.warning],
          collisionBaseRelativePath: ordinal,
          collisionNumber: collision,
        })
        selected = true
        break
      }
    }
    if (!selected) {
      throw new PluginError(
        "GENIMAGE_OUTPUT_WRITE_FAILED",
        "No available output filename could be selected.",
      )
    }
  }

  return { canonicalWorktree, paths: planned }
}
