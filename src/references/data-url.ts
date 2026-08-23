import { Buffer } from "node:buffer"

import { PluginError } from "../openrouter/errors.js"
import {
  detectImageFormat,
  isSupportedImageMime,
  type DetectedImageFormat,
  type RasterImageMime,
} from "./formats.js"

export interface DecodedImageData {
  bytes: Buffer
  detected: DetectedImageFormat
  dataUrl: string
}

function normalizeBase64(value: string): string {
  if (value === "" || /\s/u.test(value) || /[^A-Za-z0-9+/=]/u.test(value)) {
    throw new PluginError(
      "GENIMAGE_REFERENCE_INVALID",
      "The image contains invalid base64 data.",
    )
  }

  const firstPadding = value.indexOf("=")
  if (firstPadding !== -1 && !/^={1,2}$/u.test(value.slice(firstPadding))) {
    throw new PluginError(
      "GENIMAGE_REFERENCE_INVALID",
      "The image contains invalid base64 padding.",
    )
  }

  const unpadded = firstPadding === -1 ? value : value.slice(0, firstPadding)
  if (unpadded.length % 4 === 1) {
    throw new PluginError(
      "GENIMAGE_REFERENCE_INVALID",
      "The image contains invalid base64 data.",
    )
  }
  const padded = `${unpadded}${"=".repeat((4 - (unpadded.length % 4)) % 4)}`
  if (firstPadding !== -1 && padded !== value) {
    throw new PluginError(
      "GENIMAGE_REFERENCE_INVALID",
      "The image contains non-canonical base64 padding.",
    )
  }
  return padded
}

export function estimatedDecodedBase64Bytes(value: string): number {
  const padded = normalizeBase64(value)
  const padding = padded.endsWith("==") ? 2 : padded.endsWith("=") ? 1 : 0
  return (padded.length / 4) * 3 - padding
}

export function decodeStrictBase64(value: string, maximumBytes?: number): Buffer {
  const padded = normalizeBase64(value)
  const estimated = estimatedDecodedBase64Bytes(padded)
  if (maximumBytes !== undefined && estimated > maximumBytes) {
    throw new PluginError(
      "GENIMAGE_REFERENCE_TOO_LARGE",
      "The reference image exceeds the configured file-size limit.",
      {
        details: { maxFileBytes: maximumBytes },
        suggestion:
          "Resize or compress the image, use fewer references, or provide a public HTTPS URL.",
      },
    )
  }

  const bytes = Buffer.from(padded, "base64")
  if (bytes.toString("base64") !== padded) {
    throw new PluginError(
      "GENIMAGE_REFERENCE_INVALID",
      "The image contains invalid base64 data.",
    )
  }
  return bytes
}

export function imageBytesToDataUrl(
  bytes: Uint8Array,
  mime: RasterImageMime,
): string {
  return `data:${mime};base64,${Buffer.from(bytes).toString("base64")}`
}

export function parseImageDataUrl(
  value: string,
  maximumBytes?: number,
): DecodedImageData {
  if (
    maximumBytes !== undefined &&
    value.length > Math.ceil(maximumBytes / 3) * 4 + 64
  ) {
    throw new PluginError(
      "GENIMAGE_REFERENCE_TOO_LARGE",
      "The reference image exceeds the configured file-size limit.",
      { details: { maxFileBytes: maximumBytes } },
    )
  }
  const match = /^data:([^;,]+);base64,([A-Za-z0-9+/=]+)$/u.exec(value)
  if (match === null) {
    throw new PluginError(
      "GENIMAGE_REFERENCE_INVALID",
      "The attachment is not a valid base64 image data URL.",
    )
  }

  const declaredMime = match[1]
  const encoded = match[2]
  if (
    declaredMime === undefined ||
    encoded === undefined ||
    !isSupportedImageMime(declaredMime)
  ) {
    throw new PluginError(
      "GENIMAGE_REFERENCE_FORMAT_UNSUPPORTED",
      "Only PNG, JPEG, and WebP reference images are supported.",
    )
  }

  const bytes = decodeStrictBase64(encoded, maximumBytes)
  const detected = detectImageFormat(bytes)
  if (detected === undefined) {
    throw new PluginError(
      "GENIMAGE_REFERENCE_FORMAT_UNSUPPORTED",
      "The reference image is not a supported PNG, JPEG, or WebP file.",
    )
  }
  if (detected.mime !== declaredMime) {
    throw new PluginError(
      "GENIMAGE_REFERENCE_INVALID",
      "The reference image MIME type does not match its binary format.",
    )
  }

  return {
    bytes,
    detected,
    dataUrl: imageBytesToDataUrl(bytes, detected.mime),
  }
}
