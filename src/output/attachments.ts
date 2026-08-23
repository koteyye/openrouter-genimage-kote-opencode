import { imageBytesToDataUrl } from "../references/data-url.js"
import type { SavedImage } from "./writer.js"

export interface ToolFileAttachment {
  type: "file"
  mime: SavedImage["mime"]
  filename: string
  url: string
}

export function createToolAttachment(image: SavedImage): ToolFileAttachment {
  return {
    type: "file",
    mime: image.mime,
    filename: image.filename,
    url: imageBytesToDataUrl(image.data, image.mime),
  }
}

export function createToolAttachments(
  images: readonly SavedImage[],
): ToolFileAttachment[] {
  return images.map(createToolAttachment)
}
