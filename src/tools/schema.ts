import { tool } from "@opencode-ai/plugin"

import {
  IMAGE_ASPECT_RATIOS,
  IMAGE_BACKGROUNDS,
  IMAGE_OUTPUT_FORMATS,
  IMAGE_QUALITIES,
  IMAGE_RESOLUTIONS,
} from "../config/types.js"

const prompt = tool.schema
  .string()
  .max(32_000)
  .refine((value) => value.trim().length > 0, "Prompt must not be empty.")

const outputPath = tool.schema
  .string()
  .max(4_096)
  .refine((value) => value.trim().length > 0, "Output path must not be empty.")

export const generationToolArgs = {
  prompt,
  output_path: outputPath.optional(),
  aspect_ratio: tool.schema.enum(IMAGE_ASPECT_RATIOS).optional(),
  background: tool.schema.enum(IMAGE_BACKGROUNDS).optional(),
  n: tool.schema.number().int().min(1).max(10).optional(),
  output_format: tool.schema.enum(IMAGE_OUTPUT_FORMATS).optional(),
  output_compression: tool.schema.number().int().min(0).max(100).optional(),
  quality: tool.schema.enum(IMAGE_QUALITIES).optional(),
  resolution: tool.schema.enum(IMAGE_RESOLUTIONS).optional(),
  seed: tool.schema.number().int().nonnegative().optional(),
}

export const imageReferenceSchema = tool.schema.discriminatedUnion("type", [
  tool.schema
    .object({
      type: tool.schema.literal("message_attachment"),
      index: tool.schema.number().int().min(1),
    })
    .strict(),
  tool.schema
    .object({
      type: tool.schema.literal("project_file"),
      path: tool.schema.string().min(1).max(4_096),
    })
    .strict(),
  tool.schema
    .object({
      type: tool.schema.literal("https_url"),
      url: tool.schema.string().min(1).max(8_192),
    })
    .strict(),
])

export const editToolArgs = {
  ...generationToolArgs,
  references: tool.schema.array(imageReferenceSchema).max(16).optional(),
}
