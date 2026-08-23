export type RasterImageFormat = "png" | "jpeg" | "webp"
export type RasterImageMime = "image/png" | "image/jpeg" | "image/webp"

export interface DetectedImageFormat {
  format: RasterImageFormat
  mime: RasterImageMime
  extension: ".png" | ".jpeg" | ".webp"
}

const PNG_SIGNATURE = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10])

function startsWith(bytes: Uint8Array, signature: Uint8Array): boolean {
  if (bytes.byteLength < signature.byteLength) return false
  return signature.every((value, index) => bytes[index] === value)
}

export function detectImageFormat(bytes: Uint8Array): DetectedImageFormat | undefined {
  if (startsWith(bytes, PNG_SIGNATURE)) {
    return { format: "png", mime: "image/png", extension: ".png" }
  }

  if (
    bytes.byteLength >= 3 &&
    bytes[0] === 0xff &&
    bytes[1] === 0xd8 &&
    bytes[2] === 0xff
  ) {
    return { format: "jpeg", mime: "image/jpeg", extension: ".jpeg" }
  }

  if (
    bytes.byteLength >= 12 &&
    String.fromCharCode(...bytes.subarray(0, 4)) === "RIFF" &&
    String.fromCharCode(...bytes.subarray(8, 12)) === "WEBP"
  ) {
    return { format: "webp", mime: "image/webp", extension: ".webp" }
  }

  return undefined
}

export function isSupportedImageMime(value: string): value is RasterImageMime {
  return value === "image/png" || value === "image/jpeg" || value === "image/webp"
}

export function formatFromExtension(extension: string): RasterImageFormat | undefined {
  switch (extension.toLowerCase()) {
    case ".png":
      return "png"
    case ".jpg":
    case ".jpeg":
      return "jpeg"
    case ".webp":
      return "webp"
    default:
      return undefined
  }
}

export function mimeForFormat(format: RasterImageFormat): RasterImageMime {
  return format === "png"
    ? "image/png"
    : format === "jpeg"
      ? "image/jpeg"
      : "image/webp"
}

export function extensionForFormat(
  format: RasterImageFormat,
): DetectedImageFormat["extension"] {
  return format === "png" ? ".png" : format === "jpeg" ? ".jpeg" : ".webp"
}
