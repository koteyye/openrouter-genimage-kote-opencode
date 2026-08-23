import { Buffer } from "node:buffer"

import { PluginError } from "../openrouter/errors.js"
import type { OpenRouterInputReference } from "../openrouter/schemas.js"
import { abortableStreamRead, throwIfAborted } from "../utils/abort.js"
import { imageBytesToDataUrl, parseImageDataUrl } from "./data-url.js"
import {
  detectImageFormat,
  isSupportedImageMime,
  type DetectedImageFormat,
} from "./formats.js"
import { ReferenceBudget, type ReferenceLimits } from "./limits.js"
import {
  loadProjectImage,
  loadTrustedAttachmentFile,
  type LoadedLocalImage,
} from "./project-files.js"
import { validatePublicHttpsUrl } from "./remote-urls.js"

export interface MessageAttachmentReference {
  type: "message_attachment"
  index: number
}

export interface ProjectFileReference {
  type: "project_file"
  path: string
}

export interface HttpsUrlReference {
  type: "https_url"
  url: string
}

export type ImageReference =
  | MessageAttachmentReference
  | ProjectFileReference
  | HttpsUrlReference

export interface OpenCodeFilePart {
  type: "file"
  mime: string
  filename?: string
  url: string
}

interface OpenCodeMessageData {
  info: {
    role: "user" | "assistant"
    parentID?: string
  }
  parts: Array<OpenCodeFilePart | { type: string; [key: string]: unknown }>
}

export interface OpenCodeMessageClient {
  session: {
    message(options: {
      path: { id: string; messageID: string }
      query?: { directory?: string }
      signal?: AbortSignal
    }): Promise<{ data?: OpenCodeMessageData; error?: unknown }>
  }
}

export interface ReferenceToolContext {
  sessionID: string
  messageID: string
  directory: string
  worktree: string
  abort: AbortSignal
}

export interface ResolvedReference {
  source: ImageReference["type"]
  openRouterReference: OpenRouterInputReference
  byteLength?: number
  detected?: DetectedImageFormat
  canonicalSourcePath?: string
}

export interface ResolveReferencesOptions {
  references: readonly ImageReference[] | undefined
  context: ReferenceToolContext
  client: OpenCodeMessageClient
  serverUrl: URL
  limits: ReferenceLimits
  promptLength: number
  fetch?: typeof globalThis.fetch
}

export interface ResolvedReferences {
  references: ResolvedReference[]
  inputReferences: OpenRouterInputReference[]
  canonicalSourcePaths: ReadonlySet<string>
  localBytes: number
}

function isImagePart(
  part: OpenCodeMessageData["parts"][number],
): part is OpenCodeFilePart {
  return (
    part.type === "file" &&
    typeof part.mime === "string" &&
    part.mime.startsWith("image/") &&
    typeof part.url === "string"
  )
}

async function getMessage(
  client: OpenCodeMessageClient,
  sessionID: string,
  messageID: string,
  directory: string,
  signal: AbortSignal,
): Promise<OpenCodeMessageData> {
  throwIfAborted(signal)
  try {
    const response = await client.session.message({
      path: { id: sessionID, messageID },
      query: { directory },
      signal,
    })
    if (response.data === undefined) throw new TypeError("message unavailable")
    return response.data
  } catch (error) {
    throwIfAborted(signal)
    throw new PluginError(
      "GENIMAGE_ATTACHMENT_ACCESS_FAILED",
      "OpenCode could not provide the current message attachments.",
      { cause: error },
    )
  }
}

export async function getCurrentUserImageParts(
  client: OpenCodeMessageClient,
  context: ReferenceToolContext,
): Promise<OpenCodeFilePart[]> {
  const assistant = await getMessage(
    client,
    context.sessionID,
    context.messageID,
    context.directory,
    context.abort,
  )
  if (assistant.info.role !== "assistant" || typeof assistant.info.parentID !== "string") {
    throw new PluginError(
      "GENIMAGE_ATTACHMENT_ACCESS_FAILED",
      "The current assistant message does not identify its parent user message.",
    )
  }

  const user = await getMessage(
    client,
    context.sessionID,
    assistant.info.parentID,
    context.directory,
    context.abort,
  )
  if (user.info.role !== "user") {
    throw new PluginError(
      "GENIMAGE_ATTACHMENT_ACCESS_FAILED",
      "The parent OpenCode message is not a user message.",
    )
  }
  return user.parts.filter(isImagePart)
}

async function readAttachmentResponse(
  response: Response,
  maximumBytes: number,
  signal: AbortSignal,
): Promise<Buffer> {
  if (!response.ok || response.status >= 300) {
    await response.body?.cancel().catch(() => {})
    throw new PluginError(
      "GENIMAGE_ATTACHMENT_ACCESS_FAILED",
      "OpenCode could not read the managed image attachment.",
      { details: { status: response.status } },
    )
  }

  const contentLength = response.headers.get("content-length")
  if (contentLength !== null) {
    const parsed = Number(contentLength)
    if (Number.isFinite(parsed) && parsed > maximumBytes) {
      await response.body?.cancel().catch(() => {})
      throw new PluginError(
        "GENIMAGE_REFERENCE_TOO_LARGE",
        "The managed attachment exceeds the configured file-size limit.",
        { details: { maxFileBytes: maximumBytes } },
      )
    }
  }
  if (response.body === null) {
    throw new PluginError(
      "GENIMAGE_ATTACHMENT_ACCESS_FAILED",
      "The managed image attachment has no response body.",
    )
  }

  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    for (;;) {
      throwIfAborted(signal)
      const chunk = await abortableStreamRead(reader, signal)
      if (chunk.done) break
      total += chunk.value.byteLength
      if (total > maximumBytes) {
        await reader.cancel("attachment size limit exceeded").catch(() => {})
        throw new PluginError(
          "GENIMAGE_REFERENCE_TOO_LARGE",
          "The managed attachment exceeds the configured file-size limit.",
          { details: { maxFileBytes: maximumBytes } },
        )
      }
      chunks.push(chunk.value)
    }
  } finally {
    try {
      reader.releaseLock()
    } catch {
      void reader.cancel().catch(() => {})
    }
  }

  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)), total)
}

async function loadManagedAttachment(
  part: OpenCodeFilePart,
  url: URL,
  maximumBytes: number,
  signal: AbortSignal,
  fetchImplementation: typeof globalThis.fetch,
): Promise<LoadedLocalImage> {
  if (!isSupportedImageMime(part.mime)) {
    throw new PluginError(
      "GENIMAGE_REFERENCE_FORMAT_UNSUPPORTED",
      "Only PNG, JPEG, and WebP attachments are supported.",
    )
  }

  let response: Response
  try {
    response = await fetchImplementation(url, {
      method: "GET",
      redirect: "manual",
      signal,
      headers: { Accept: "image/png, image/jpeg, image/webp" },
    })
  } catch (error) {
    throwIfAborted(signal)
    throw new PluginError(
      "GENIMAGE_ATTACHMENT_ACCESS_FAILED",
      "OpenCode could not read the managed image attachment.",
      { cause: error },
    )
  }
  const bytes = await readAttachmentResponse(response, maximumBytes, signal)
  const detected = detectImageFormat(bytes)
  if (detected === undefined) {
    throw new PluginError(
      "GENIMAGE_REFERENCE_FORMAT_UNSUPPORTED",
      "The attachment is not a supported PNG, JPEG, or WebP image.",
    )
  }
  if (detected.mime !== part.mime) {
    throw new PluginError(
      "GENIMAGE_REFERENCE_INVALID",
      "The attachment MIME type does not match its binary format.",
    )
  }

  return {
    bytes,
    detected,
    dataUrl: imageBytesToDataUrl(bytes, detected.mime),
    canonicalPath: "",
  }
}

function fromLocalImage(
  source: ResolvedReference["source"],
  image: LoadedLocalImage,
): ResolvedReference {
  return {
    source,
    openRouterReference: {
      type: "image_url",
      image_url: { url: image.dataUrl },
    },
    byteLength: image.bytes.byteLength,
    detected: image.detected,
    ...(image.canonicalPath === "" ? {} : { canonicalSourcePath: image.canonicalPath }),
  }
}

async function resolveMessagePart(
  part: OpenCodeFilePart,
  serverUrl: URL,
  maximumBytes: number,
  signal: AbortSignal,
  fetchImplementation: typeof globalThis.fetch,
): Promise<ResolvedReference> {
  if (part.url.startsWith("data:")) {
    const decoded = parseImageDataUrl(part.url, maximumBytes)
    if (decoded.detected.mime !== part.mime) {
      throw new PluginError(
        "GENIMAGE_REFERENCE_INVALID",
        "The attachment MIME type does not match its data URL.",
      )
    }
    return {
      source: "message_attachment",
      openRouterReference: {
        type: "image_url",
        image_url: { url: decoded.dataUrl },
      },
      byteLength: decoded.bytes.byteLength,
      detected: decoded.detected,
    }
  }

  let url: URL
  try {
    url = new URL(part.url)
  } catch (error) {
    throw new PluginError(
      "GENIMAGE_ATTACHMENT_ACCESS_FAILED",
      "The OpenCode attachment URL is invalid.",
      { cause: error },
    )
  }
  if (url.username !== "" || url.password !== "") {
    throw new PluginError(
      "GENIMAGE_ATTACHMENT_ACCESS_FAILED",
      "The OpenCode attachment URL contains credentials.",
    )
  }

  if (url.protocol === "file:") {
    return fromLocalImage(
      "message_attachment",
      await loadTrustedAttachmentFile(part.url, maximumBytes, signal),
    )
  }

  const isManaged = url.origin === serverUrl.origin || url.protocol === "blob:"
  if (isManaged) {
    return fromLocalImage(
      "message_attachment",
      await loadManagedAttachment(
        part,
        url,
        maximumBytes,
        signal,
        fetchImplementation,
      ),
    )
  }

  if (url.protocol === "https:") {
    validatePublicHttpsUrl(part.url)
    return {
      source: "message_attachment",
      openRouterReference: {
        type: "image_url",
        image_url: { url: part.url },
      },
    }
  }

  throw new PluginError(
    "GENIMAGE_ATTACHMENT_ACCESS_FAILED",
    "The OpenCode attachment uses an unsupported URL scheme.",
  )
}

export async function resolveImageReferences(
  options: ResolveReferencesOptions,
): Promise<ResolvedReferences> {
  const fetchImplementation = options.fetch ?? globalThis.fetch.bind(globalThis)
  const budget = new ReferenceBudget(options.limits)
  const parts =
    options.references === undefined ||
    options.references.some((reference) => reference.type === "message_attachment")
      ? await getCurrentUserImageParts(options.client, options.context)
      : []

  const requested: readonly ImageReference[] =
    options.references ?? parts.map((_, index) => ({ type: "message_attachment", index: index + 1 }))
  if (requested.length === 0) {
    throw new PluginError(
      "GENIMAGE_REFERENCE_REQUIRED",
      "Image editing requires at least one visual reference.",
    )
  }
  if (requested.length > options.limits.maxReferences || requested.length > 16) {
    throw new PluginError(
      "GENIMAGE_TOO_MANY_REFERENCES",
      "Too many image references were supplied.",
      { details: { maxReferences: Math.min(options.limits.maxReferences, 16) } },
    )
  }

  const resolved: ResolvedReference[] = []
  let urlCharacters = 0
  for (const reference of requested) {
    throwIfAborted(options.context.abort)
    let item: ResolvedReference
    switch (reference.type) {
      case "message_attachment": {
        if (!Number.isInteger(reference.index) || reference.index < 1) {
          throw new PluginError(
            "GENIMAGE_REFERENCE_INDEX_INVALID",
            "Attachment indexes start at 1 and must be integers.",
          )
        }
        const part = parts[reference.index - 1]
        if (part === undefined) {
          throw new PluginError(
            "GENIMAGE_REFERENCE_INDEX_INVALID",
            "The requested image attachment index does not exist in the current user message.",
            { details: { index: reference.index, available: parts.length } },
          )
        }
        item = await resolveMessagePart(
          part,
          options.serverUrl,
          options.limits.maxFileBytes,
          options.context.abort,
          fetchImplementation,
        )
        break
      }
      case "project_file":
        item = fromLocalImage(
          "project_file",
          await loadProjectImage(
            options.context.worktree,
            reference.path,
            options.limits.maxFileBytes,
            options.context.abort,
          ),
        )
        break
      case "https_url": {
        const url = validatePublicHttpsUrl(reference.url)
        item = {
          source: "https_url",
          openRouterReference: {
            type: "image_url",
            image_url: { url },
          },
        }
        break
      }
    }

    if (item.byteLength === undefined) {
      budget.addRemoteReference()
      urlCharacters += item.openRouterReference.image_url.url.length
    } else {
      budget.addLocalReference(item.byteLength)
    }
    resolved.push(item)
  }

  budget.assertEstimatedRequestSize(options.promptLength, urlCharacters)
  return {
    references: resolved,
    inputReferences: resolved.map((item) => item.openRouterReference),
    canonicalSourcePaths: new Set(
      resolved.flatMap((item) =>
        item.canonicalSourcePath === undefined ? [] : [item.canonicalSourcePath],
      ),
    ),
    localBytes: budget.localBytes,
  }
}
