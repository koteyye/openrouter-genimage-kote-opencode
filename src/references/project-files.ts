import { open, realpath } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"

import { PluginError } from "../openrouter/errors.js"
import { throwIfAborted } from "../utils/abort.js"
import { imageBytesToDataUrl } from "./data-url.js"
import { detectImageFormat, type DetectedImageFormat } from "./formats.js"

export interface LoadedLocalImage {
  bytes: Buffer
  detected: DetectedImageFormat
  dataUrl: string
  canonicalPath: string
}

function pathKey(value: string): string {
  return process.platform === "win32" ? value.toLocaleLowerCase("en-US") : value
}

export function isPathInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate)
  return (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))
  )
}

export function assertSafeRelativePath(value: string): string {
  const windowsAbsolute = path.win32.isAbsolute(value)
  const posixAbsolute = path.posix.isAbsolute(value.replaceAll("\\", "/"))
  const segments = value.replaceAll("\\", "/").split("/")
  if (
    value.trim() === "" ||
    /[\u0000-\u001f\u007f]/u.test(value) ||
    windowsAbsolute ||
    posixAbsolute ||
    segments.includes("..")
  ) {
    throw new PluginError(
      "GENIMAGE_REFERENCE_NOT_FOUND",
      "Project image paths must be relative and remain inside the worktree.",
    )
  }
  return value
}

async function readValidatedFile(
  filePath: string,
  maximumBytes: number,
  signal: AbortSignal,
): Promise<LoadedLocalImage> {
  throwIfAborted(signal)
  let file
  try {
    file = await open(filePath, "r")
  } catch (error) {
    throwIfAborted(signal)
    throw new PluginError(
      "GENIMAGE_REFERENCE_NOT_FOUND",
      "The referenced image file was not found.",
      { cause: error },
    )
  }

  let bytes: Buffer
  try {
    const initialStats = await file.stat({ bigint: true })
    if (!initialStats.isFile()) {
      throw new PluginError(
        "GENIMAGE_REFERENCE_NOT_FOUND",
        "The referenced path is not a regular file.",
      )
    }
    if (initialStats.size > BigInt(maximumBytes)) {
      throw new PluginError(
        "GENIMAGE_REFERENCE_TOO_LARGE",
        "The reference image exceeds the configured file-size limit.",
        {
          details: {
            bytes: Number(initialStats.size),
            maxFileBytes: maximumBytes,
          },
          suggestion: "Resize or compress the reference image.",
        },
      )
    }

    const chunks: Buffer[] = []
    let totalBytes = 0
    while (totalBytes <= maximumBytes) {
      throwIfAborted(signal)
      const remaining = maximumBytes + 1 - totalBytes
      const buffer = Buffer.allocUnsafe(Math.min(64 * 1_024, remaining))
      const { bytesRead } = await file.read(buffer, 0, buffer.byteLength, null)
      if (bytesRead === 0) break
      chunks.push(Buffer.from(buffer.subarray(0, bytesRead)))
      totalBytes += bytesRead
    }
    throwIfAborted(signal)
    if (totalBytes > maximumBytes) {
      throw new PluginError(
        "GENIMAGE_REFERENCE_TOO_LARGE",
        "The reference image changed while it was being read or is too large.",
        {
          details: { bytes: totalBytes, maxFileBytes: maximumBytes },
          suggestion: "Resize or compress the reference image.",
        },
      )
    }

    const finalStats = await file.stat({ bigint: true })
    if (
      finalStats.dev !== initialStats.dev ||
      finalStats.ino !== initialStats.ino ||
      finalStats.size !== initialStats.size ||
      finalStats.mtimeNs !== initialStats.mtimeNs ||
      finalStats.ctimeNs !== initialStats.ctimeNs ||
      BigInt(totalBytes) !== finalStats.size
    ) {
      throw new PluginError(
        "GENIMAGE_REFERENCE_NOT_FOUND",
        "The referenced image changed while it was being read.",
      )
    }
    bytes = Buffer.concat(chunks, totalBytes)
  } catch (error) {
    throwIfAborted(signal)
    if (error instanceof PluginError) throw error
    throw new PluginError(
      "GENIMAGE_REFERENCE_NOT_FOUND",
      "The referenced image file could not be read.",
      { cause: error },
    )
  } finally {
    await file.close().catch(() => undefined)
  }
  throwIfAborted(signal)
  const detected = detectImageFormat(bytes)
  if (detected === undefined) {
    throw new PluginError(
      "GENIMAGE_REFERENCE_FORMAT_UNSUPPORTED",
      "Only PNG, JPEG, and WebP reference images are supported.",
    )
  }
  const canonicalPath = await realpath(filePath)
  return {
    bytes,
    detected,
    dataUrl: imageBytesToDataUrl(bytes, detected.mime),
    canonicalPath,
  }
}

export async function loadProjectImage(
  worktree: string,
  relativePath: string,
  maximumBytes: number,
  signal: AbortSignal,
): Promise<LoadedLocalImage> {
  assertSafeRelativePath(relativePath)
  throwIfAborted(signal)
  const canonicalRoot = await realpath(worktree)
  const lexicalPath = path.resolve(worktree, relativePath)
  if (!isPathInside(path.resolve(worktree), lexicalPath)) {
    throw new PluginError(
      "GENIMAGE_REFERENCE_NOT_FOUND",
      "The project image path escapes the worktree.",
    )
  }

  let canonicalPath: string
  try {
    canonicalPath = await realpath(lexicalPath)
  } catch (error) {
    throwIfAborted(signal)
    throw new PluginError(
      "GENIMAGE_REFERENCE_NOT_FOUND",
      "The referenced image file was not found.",
      { cause: error },
    )
  }
  if (!isPathInside(canonicalRoot, canonicalPath)) {
    throw new PluginError(
      "GENIMAGE_REFERENCE_NOT_FOUND",
      "The project image resolves outside the worktree.",
    )
  }
  const image = await readValidatedFile(canonicalPath, maximumBytes, signal)
  if (!isPathInside(canonicalRoot, image.canonicalPath)) {
    throw new PluginError(
      "GENIMAGE_REFERENCE_NOT_FOUND",
      "The project image resolves outside the worktree.",
    )
  }
  return image
}

export async function loadTrustedAttachmentFile(
  fileUrl: string,
  maximumBytes: number,
  signal: AbortSignal,
): Promise<LoadedLocalImage> {
  let filePath: string
  try {
    const parsed = new URL(fileUrl)
    if (parsed.protocol !== "file:" || parsed.username !== "" || parsed.password !== "") {
      throw new TypeError("not a trusted file URL")
    }
    filePath = fileURLToPath(parsed)
  } catch (error) {
    throw new PluginError(
      "GENIMAGE_ATTACHMENT_ACCESS_FAILED",
      "The OpenCode attachment file URL is invalid.",
      { cause: error },
    )
  }
  return readValidatedFile(filePath, maximumBytes, signal)
}

export function sameCanonicalPath(left: string, right: string): boolean {
  return pathKey(path.resolve(left)) === pathKey(path.resolve(right))
}
