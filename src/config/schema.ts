import { z } from "zod"

import {
  IMAGE_ASPECT_RATIOS,
  IMAGE_BACKGROUNDS,
  IMAGE_OUTPUT_FORMATS,
  IMAGE_QUALITIES,
  IMAGE_RESOLUTIONS,
  ROUTING_MODES,
} from "./types.js"
import type {
  ResolvedPluginInputOptions,
} from "./types.js"

const positiveInteger = z.number().int().positive()

function addParameterCompatibilityChecks(
  parameters: {
    background?: string | undefined
    output_format?: string | undefined
    output_compression?: number | undefined
  },
  context: z.RefinementCtx,
  requireCompressionFormat = true,
): void {
  if (
    parameters.background === "transparent" &&
    ((requireCompressionFormat && parameters.output_format === undefined) ||
      parameters.output_format === "jpeg")
  ) {
    context.addIssue({
      code: "custom",
      path: ["background"],
      message: "Transparent backgrounds are not supported for JPEG output.",
    })
  }

  if (
    parameters.output_compression !== undefined &&
    (requireCompressionFormat || parameters.output_format !== undefined) &&
    parameters.output_format !== "jpeg" &&
    parameters.output_format !== "webp"
  ) {
    context.addIssue({
      code: "custom",
      path: ["output_compression"],
      message: "Output compression requires JPEG or WebP output.",
    })
  }
}

function isSafeRelativeDirectory(value: string): boolean {
  if (
    value.length > 4_096 ||
    /^[A-Za-z]:/u.test(value) ||
    /^(?:[\\/]|\\\\)/u.test(value) ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    return false
  }

  return !value.split(/[\\/]/u).includes("..")
}

export const generationParametersSchema = z
  .strictObject({
    aspect_ratio: z.enum(IMAGE_ASPECT_RATIOS).optional(),
    background: z.enum(IMAGE_BACKGROUNDS).optional(),
    n: z.number().int().min(1).max(10).optional(),
    output_format: z.enum(IMAGE_OUTPUT_FORMATS).optional(),
    output_compression: z.number().int().min(0).max(100).optional(),
    quality: z.enum(IMAGE_QUALITIES).optional(),
    resolution: z.enum(IMAGE_RESOLUTIONS).optional(),
    seed: z.number().int().nonnegative().optional(),
  })
  .superRefine(addParameterCompatibilityChecks)

const promptSchema = z
  .string()
  .max(32_000)
  .refine((prompt) => prompt.trim().length > 0, {
    message: "Prompt must not be empty.",
  })

const outputPathSchema = z
  .string()
  .max(4_096)
  .refine((outputPath) => outputPath.trim().length > 0, {
    message: "Output path must not be empty.",
  })

export const generateImageArgsSchema = z
  .strictObject({
    prompt: promptSchema,
    output_path: outputPathSchema.optional(),
    aspect_ratio: z.enum(IMAGE_ASPECT_RATIOS).optional(),
    background: z.enum(IMAGE_BACKGROUNDS).optional(),
    n: z.number().int().min(1).max(10).optional(),
    output_format: z.enum(IMAGE_OUTPUT_FORMATS).optional(),
    output_compression: z.number().int().min(0).max(100).optional(),
    quality: z.enum(IMAGE_QUALITIES).optional(),
    resolution: z.enum(IMAGE_RESOLUTIONS).optional(),
    seed: z.number().int().nonnegative().optional(),
  })
  .superRefine((args, context) => {
    addParameterCompatibilityChecks(args, context, false)
  })

const pluginInputSchema = z
  .strictObject({
    maxReferences: positiveInteger.max(16).optional(),
    maxFileBytes: positiveInteger.optional(),
    maxTotalBytes: positiveInteger.optional(),
  })
  .superRefine((input, context) => {
    if (
      input.maxFileBytes !== undefined &&
      input.maxTotalBytes !== undefined &&
      input.maxTotalBytes < input.maxFileBytes
    ) {
      context.addIssue({
        code: "custom",
        path: ["maxTotalBytes"],
        message: "Total input size cannot be smaller than per-file size.",
      })
    }
  })

const credentialSchema = z
  .string()
  .trim()
  .min(1)
  .max(4_096)
  .refine((value) => !/[\u0000-\u001f\u007f]/u.test(value), {
    message: "Credentials cannot contain control characters.",
  })

export const pluginOptionsSchema = z
  .strictObject({
    routing: z.enum(ROUTING_MODES),
    model: z.string().trim().min(1),
    apiKey: credentialSchema.optional(),
    managementApiKey: credentialSchema.optional(),
    outputDirectory: z
      .string()
      .trim()
      .min(1)
      .refine(isSafeRelativeDirectory, {
        message: "Output directory must be a safe worktree-relative path.",
      })
      .optional(),
    defaults: generationParametersSchema.optional(),
    input: pluginInputSchema.optional(),
    requestTimeoutMs: positiveInteger.optional(),
    modelCacheTtlMs: positiveInteger.optional(),
    maxResponseBytes: positiveInteger.optional(),
    maxDecodedBytes: positiveInteger.optional(),
  })
  .superRefine((options, context) => {
    const maxFileBytes = options.input?.maxFileBytes ?? DEFAULT_OPTIONS.input.maxFileBytes
    const maxTotalBytes =
      options.input?.maxTotalBytes ?? DEFAULT_OPTIONS.input.maxTotalBytes

    if (maxTotalBytes < maxFileBytes) {
      context.addIssue({
        code: "custom",
        path: ["input", "maxTotalBytes"],
        message: "Total input size cannot be smaller than per-file size.",
      })
    }
  })

export const DEFAULT_OPTIONS: {
  readonly outputDirectory: string
  readonly defaults: Readonly<{ n: number }>
  readonly input: Readonly<ResolvedPluginInputOptions>
  readonly requestTimeoutMs: number
  readonly modelCacheTtlMs: number
  readonly maxResponseBytes: number
  readonly maxDecodedBytes: number
} = Object.freeze({
  outputDirectory: "assets/generated",
  defaults: Object.freeze({ n: 1 }),
  input: Object.freeze({
    maxReferences: 16,
    maxFileBytes: 20 * 1024 * 1024,
    maxTotalBytes: 50 * 1024 * 1024,
  }),
  requestTimeoutMs: 300_000,
  modelCacheTtlMs: 3_600_000,
  maxResponseBytes: 128 * 1024 * 1024,
  maxDecodedBytes: 128 * 1024 * 1024,
})
