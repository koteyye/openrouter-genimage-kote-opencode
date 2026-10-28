import { randomUUID } from "node:crypto"
import { link, open, unlink } from "node:fs/promises"
import path from "node:path"

import { PluginError, isPluginError } from "../openrouter/errors.js"
import {
  detectOutputImageFormat,
  type DetectedOutputImageFormat,
} from "../references/formats.js"
import { isAbortError, throwIfAborted } from "../utils/abort.js"
import type { ValidatedImage } from "./formats.js"
import {
  addCollisionSuffix,
  ensureSafeOutputParent,
  isExistingPathError,
  planOutputPaths,
  recheckSafeOutputParent,
  type PlannedOutputPath,
} from "./paths.js"

export interface SaveImagesOptions {
  images: readonly ValidatedImage[]
  outputPath?: string | undefined
  outputDirectory: string
  worktree: string
  sourcePaths?: readonly string[] | undefined
  signal?: AbortSignal | undefined
  now?: Date | undefined
  randomId?: (() => string) | undefined
}

export interface SavedImage {
  absolutePath: string
  relativePath: string
  filename: string
  mime: DetectedOutputImageFormat["mime"]
  bytes: number
  data: Buffer
  detected: DetectedOutputImageFormat
  warnings: string[]
}

export class ImageSaveError extends PluginError {
  readonly savedImages: readonly SavedImage[]

  constructor(error: PluginError, savedImages: readonly SavedImage[]) {
    super(error.code, error.message, {
      details: {
        ...(error.details ?? {}),
        savedCount: savedImages.length,
      },
      ...(error.suggestion === undefined ? {} : { suggestion: error.suggestion }),
      cause: error,
    })
    this.name = "ImageSaveError"
    this.savedImages = [...savedImages]
  }
}

const NEVER_ABORTED = new AbortController().signal

function outputWriteError(message: string, cause: unknown): PluginError {
  return new PluginError("GENIMAGE_OUTPUT_WRITE_FAILED", message, { cause })
}

function validatedActualImage(image: ValidatedImage): ValidatedImage {
  const actual = detectOutputImageFormat(image.bytes)
  if (actual === undefined) {
    throw new PluginError(
      "GENIMAGE_IMAGE_INVALID",
      "An output image failed binary format validation before it was saved.",
    )
  }

  const warnings = [...(image.warnings ?? [])]
  if (actual.format !== image.detected.format) {
    warnings.push(
      `Output metadata said ${image.detected.format.toUpperCase()}, but the bytes are ${actual.format.toUpperCase()}; the binary format was used.`,
    )
  }
  return { bytes: image.bytes, detected: actual, warnings }
}

async function removeTemporaryFile(temporaryPath: string): Promise<void> {
  try {
    await unlink(temporaryPath)
  } catch (error) {
    if (
      typeof error !== "object" ||
      error === null ||
      !("code" in error) ||
      (error as { code?: unknown }).code !== "ENOENT"
    ) {
      throw error
    }
  }
}

async function writeCompleteTemporaryFile(
  temporaryPath: string,
  bytes: Buffer,
  signal: AbortSignal,
): Promise<void> {
  let handle
  try {
    handle = await open(temporaryPath, "wx", 0o600)
    throwIfAborted(signal)
    await handle.writeFile(bytes)
    throwIfAborted(signal)
    await handle.sync()
  } finally {
    await handle?.close()
  }
}

function withCollision(
  originalAbsolute: string,
  originalRelative: string,
  collision: number,
): { absolutePath: string; relativePath: string; filename: string } {
  const relativePath = addCollisionSuffix(originalRelative, collision)
  const absolutePath = path.resolve(path.dirname(originalAbsolute), path.basename(relativePath))
  return { absolutePath, relativePath, filename: path.basename(absolutePath) }
}

async function publishOne(
  initial: PlannedOutputPath,
  image: ValidatedImage,
  canonicalWorktree: string,
  signal: AbortSignal,
): Promise<SavedImage> {
  const lexicalParent = path.dirname(initial.absolutePath)
  const parent = await ensureSafeOutputParent(canonicalWorktree, lexicalParent)
  throwIfAborted(signal)

  const canonicalInitial = {
    absolutePath: path.join(parent, initial.filename),
    relativePath: initial.relativePath,
    filename: initial.filename,
  }

  const temporaryPath = path.join(
    parent,
    `.${initial.filename}.${randomUUID()}.tmp`,
  )
  try {
    await writeCompleteTemporaryFile(temporaryPath, image.bytes, signal)
    let destination = canonicalInitial
    for (
      let collision = initial.collisionNumber;
      collision < Number.MAX_SAFE_INTEGER;
      collision += 1
    ) {
      throwIfAborted(signal)
      await recheckSafeOutputParent(canonicalWorktree, parent)
      try {
        // Linking a complete same-directory temporary file is atomic and, in
        // contrast to rename on POSIX, is guaranteed not to replace a target.
        await link(temporaryPath, destination.absolutePath)
        try {
          await removeTemporaryFile(temporaryPath)
        } catch {
          // Publication succeeded. Cleanup is retried in finally and must not
          // turn a complete, visible result into a reported write failure.
        }
        return {
          absolutePath: destination.absolutePath,
          relativePath: destination.relativePath,
          filename: destination.filename,
          mime: image.detected.mime,
          bytes: image.bytes.byteLength,
          data: image.bytes,
          detected: image.detected,
          warnings: [...(image.warnings ?? [])],
        }
      } catch (error) {
        if (!isExistingPathError(error)) throw error
        destination = withCollision(
          canonicalInitial.absolutePath,
          initial.collisionBaseRelativePath,
          collision + 1,
        )
      }
    }
    throw new Error("output filename collision limit exhausted")
  } catch (error) {
    if (signal.aborted || isAbortError(error)) throw error
    if (isPluginError(error)) throw error
    throw outputWriteError("The generated image could not be written atomically.", error)
  } finally {
    try {
      await removeTemporaryFile(temporaryPath)
    } catch {
      // The intended final path is either absent or fully published. A failed
      // cleanup is deliberately not allowed to mask that primary outcome.
    }
  }
}

/**
 * Saves validated images in response order. If a later write fails, the thrown
 * ImageSaveError exposes already published images for partial-success handling.
 */
export async function saveImages(options: SaveImagesOptions): Promise<SavedImage[]> {
  const signal = options.signal ?? NEVER_ABORTED
  throwIfAborted(signal)
  if (options.images.length === 0) {
    throw new PluginError(
      "GENIMAGE_IMAGE_INVALID",
      "No valid generated images were available to save.",
    )
  }
  const images = options.images.map(validatedActualImage)
  const plan = await planOutputPaths({
    worktree: options.worktree,
    outputDirectory: options.outputDirectory,
    ...(options.outputPath === undefined ? {} : { outputPath: options.outputPath }),
    detectedFormats: images.map((image) => image.detected),
    ...(options.sourcePaths === undefined ? {} : { sourcePaths: options.sourcePaths }),
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.randomId === undefined ? {} : { randomId: options.randomId }),
  })

  const saved: SavedImage[] = []
  try {
    for (const [index, image] of images.entries()) {
      const destination = plan.paths[index]
      if (destination === undefined) {
        throw outputWriteError(
          "An output destination could not be planned.",
          new Error("missing output path"),
        )
      }
      const result = await publishOne(
        destination,
        {
          ...image,
          warnings: [...(image.warnings ?? []), ...destination.warnings],
        },
        plan.canonicalWorktree,
        signal,
      )
      saved.push(result)
    }
    return saved
  } catch (error) {
    if (signal.aborted || isAbortError(error)) throw error
    const pluginError = isPluginError(error)
      ? error
      : outputWriteError("The generated image could not be saved.", error)
    throw new ImageSaveError(pluginError, saved)
  }
}
