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

export type OutputImageFormat = RasterImageFormat | "svg"
export type OutputImageMime = RasterImageMime | "image/svg+xml"

export interface DetectedOutputImageFormat {
  format: OutputImageFormat
  mime: OutputImageMime
  extension: ".png" | ".jpeg" | ".webp" | ".svg"
}

const SVG_DOCUMENT =
  /^(?:\s|<\?xml[\s\S]*?\?>|<!--[\s\S]*?-->)*<svg(?:\s[^>]*)?(?:\/>|>[\s\S]*<\/svg>)(?:\s|<!--[\s\S]*?-->)*$/iu
const SVG_UNSAFE_CONTENT =
  /<!(?:DOCTYPE|ENTITY)\b|<(?:script|foreignObject|iframe|object|embed)\b|\son[a-z]+\s*=|javascript\s*:|data\s*:\s*text\/html|(?:href|src)\s*=\s*["']\s*(?:https?:)?\/\/|url\(\s*["']?(?:https?:)?\/\//iu

function detectSvg(bytes: Uint8Array): DetectedOutputImageFormat | undefined {
  let text: string
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes)
  } catch {
    return undefined
  }
  const document = text.replace(/^\uFEFF/u, "")
  if (SVG_UNSAFE_CONTENT.test(document) || !SVG_DOCUMENT.test(document)) return undefined
  return { format: "svg", mime: "image/svg+xml", extension: ".svg" }
}

export function detectOutputImageFormat(
  bytes: Uint8Array,
): DetectedOutputImageFormat | undefined {
  return detectImageFormat(bytes) ?? detectSvg(bytes)
}

export function isSupportedOutputImageMime(value: string): value is OutputImageMime {
  return isSupportedImageMime(value) || value === "image/svg+xml"
}

export function outputFormatFromExtension(extension: string): OutputImageFormat | undefined {
  return extension.toLowerCase() === ".svg" ? "svg" : formatFromExtension(extension)
}
