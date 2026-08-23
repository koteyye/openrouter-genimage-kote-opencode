import type { Buffer } from "node:buffer"

import type { ImageOutputFormat } from "../config/types.js"
import { PluginError, isPluginError } from "../openrouter/errors.js"
import { decodeStrictBase64 } from "../references/data-url.js"
import {
  detectImageFormat,
  isSupportedImageMime,
  type DetectedImageFormat,
  type RasterImageMime,
} from "../references/formats.js"

export interface EncodedOutputImage {
  b64_json: string
  media_type?: string | undefined
}

export interface ValidatedImage {
  bytes: Buffer
  detected: DetectedImageFormat
  warnings?: readonly string[] | undefined
}

export interface DecodedImage extends ValidatedImage {
  warnings: string[]
}

export interface DecodeOutputImageOptions {
  maxDecodedBytes: number
  expectedFormat?: ImageOutputFormat | undefined
  /** One-based result index, used only in safe diagnostic messages. */
  index?: number | undefined
}

export interface DecodeOutputImagesOptions {
  maxDecodedBytes: number
  expectedFormat?: ImageOutputFormat | undefined
}

export interface DecodedOutputImages {
  images: DecodedImage[]
  warnings: string[]
  invalidCount: number
}

interface EncodedPayload {
  encoded: string
  declaredMime?: string | undefined
}

function imageLabel(index: number | undefined): string {
  return index === undefined ? "The returned image" : `Returned image ${index}`
}

function invalidImage(message: string, cause?: unknown): PluginError {
  return new PluginError("GENIMAGE_IMAGE_INVALID", message, {
    ...(cause === undefined ? {} : { cause }),
  })
}

function extractEncodedPayload(value: string): EncodedPayload {
  if (!value.startsWith("data:")) return { encoded: value }

  const match = /^data:([^;,]+);base64,(.*)$/u.exec(value)
  const declaredMime = match?.[1]
  const encoded = match?.[2]
  if (declaredMime === undefined || encoded === undefined || encoded === "") {
    throw invalidImage("OpenRouter returned an invalid image data URL.")
  }
  return { encoded, declaredMime }
}

function normalizeDeclaredMime(value: string): string {
  return value.trim().toLowerCase()
}

function addDeclaredMimeWarning(
  warnings: string[],
  declaredMime: string | undefined,
  actualMime: RasterImageMime,
  index: number | undefined,
): void {
  if (declaredMime === undefined) return

  const normalized = normalizeDeclaredMime(declaredMime)
  if (normalized === actualMime) return

  const declaration = isSupportedImageMime(normalized)
    ? normalized
    : "an unsupported media type"
  warnings.push(
    `${imageLabel(index)} was declared as ${declaration}, but its bytes are ${actualMime}; the binary format was used.`,
  )
}

function addExpectedFormatWarning(
  warnings: string[],
  expectedFormat: ImageOutputFormat | undefined,
  detected: DetectedImageFormat,
  index: number | undefined,
): void {
  if (expectedFormat === undefined || expectedFormat === detected.format) return
  warnings.push(
    `${imageLabel(index)} is ${detected.format.toUpperCase()}, although ${expectedFormat.toUpperCase()} was requested; it will be saved with the actual format extension.`,
  )
}

/**
 * Strictly decodes one OpenRouter image result and classifies it from magic
 * bytes. Provider media-type fields are advisory and can only produce a
 * warning; they never override the binary format.
 */
export function decodeOutputImage(
  image: unknown,
  options: DecodeOutputImageOptions,
): DecodedImage {
  if (!Number.isSafeInteger(options.maxDecodedBytes) || options.maxDecodedBytes <= 0) {
    throw new TypeError("maxDecodedBytes must be a positive safe integer")
  }
  if (
    typeof image !== "object" ||
    image === null ||
    Array.isArray(image) ||
    !("b64_json" in image) ||
    typeof image.b64_json !== "string" ||
    image.b64_json === "" ||
    ("media_type" in image &&
      image.media_type !== undefined &&
      typeof image.media_type !== "string")
  ) {
    throw invalidImage("OpenRouter returned an image without valid base64 data.")
  }

  const encodedImage = image as EncodedOutputImage
  const payload = extractEncodedPayload(encodedImage.b64_json)
  let bytes: Buffer
  try {
    bytes = decodeStrictBase64(payload.encoded, options.maxDecodedBytes)
  } catch (error) {
    throw invalidImage(
      "OpenRouter returned invalid or oversized base64 image data.",
      error,
    )
  }

  const detected = detectImageFormat(bytes)
  if (detected === undefined) {
    throw invalidImage(
      "OpenRouter returned an unsupported image binary; only PNG, JPEG, and WebP are accepted.",
    )
  }

  const warnings: string[] = []
  addDeclaredMimeWarning(warnings, payload.declaredMime, detected.mime, options.index)
  if (
    encodedImage.media_type !== undefined &&
    normalizeDeclaredMime(encodedImage.media_type) !==
      normalizeDeclaredMime(payload.declaredMime ?? "")
  ) {
    addDeclaredMimeWarning(
      warnings,
      encodedImage.media_type,
      detected.mime,
      options.index,
    )
  }
  addExpectedFormatWarning(
    warnings,
    options.expectedFormat,
    detected,
    options.index,
  )

  return { bytes, detected, warnings }
}

/**
 * Decodes a response defensively. Invalid entries are skipped so callers can
 * report partial success. The decoded-byte budget applies to the full set.
 */
export function decodeOutputImages(
  data: unknown,
  options: DecodeOutputImagesOptions,
): DecodedOutputImages {
  if (!Array.isArray(data) || data.length === 0) {
    throw new PluginError(
      "GENIMAGE_RESPONSE_INVALID",
      "OpenRouter returned no generated images.",
    )
  }
  if (!Number.isSafeInteger(options.maxDecodedBytes) || options.maxDecodedBytes <= 0) {
    throw new TypeError("maxDecodedBytes must be a positive safe integer")
  }

  const entries: readonly unknown[] = data
  const images: DecodedImage[] = []
  const warnings: string[] = []
  let decodedBytes = 0
  let invalidCount = 0

  for (const [zeroBasedIndex, image] of entries.entries()) {
    const index = zeroBasedIndex + 1
    try {
      const decoded = decodeOutputImage(image, {
        maxDecodedBytes: options.maxDecodedBytes - decodedBytes,
        ...(options.expectedFormat === undefined
          ? {}
          : { expectedFormat: options.expectedFormat }),
        index,
      })
      decodedBytes += decoded.bytes.byteLength
      images.push(decoded)
      warnings.push(...decoded.warnings)
    } catch (error) {
      invalidCount += 1
      const code = isPluginError(error) ? error.code : "GENIMAGE_IMAGE_INVALID"
      warnings.push(`Returned image ${index} was invalid and was skipped (${code}).`)
    }
  }

  if (images.length === 0) {
    throw new PluginError(
      "GENIMAGE_IMAGE_INVALID",
      "OpenRouter did not return any valid PNG, JPEG, or WebP images.",
      { details: { returnedCount: entries.length, invalidCount } },
    )
  }

  return { images, warnings, invalidCount }
}
