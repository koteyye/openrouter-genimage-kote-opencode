import { realpath } from "node:fs/promises"
import path from "node:path"
import type { ToolContext, ToolResult } from "@opencode-ai/plugin"

import { promptFingerprint } from "../logging.js"
import { PluginError } from "../openrouter/errors.js"
import type {
  GenerateImageArgs,
  OpenRouterImageRequest,
  OpenRouterImageResponse,
} from "../openrouter/schemas.js"
import {
  ImageSaveError,
  assertOutputParentContained,
  assertSafeOutputRelativePath,
  createToolAttachments,
  decodeOutputImages,
  saveImages,
  type SavedImage,
} from "../output/index.js"
import { sameCanonicalPath } from "../references/project-files.js"
import type { ResolvedReferences } from "../references/attachments.js"
import type { RuntimeServices, ToolDependencies } from "./types.js"

export type GenerationOperation = "edit" | "generate"

interface FinishGenerationOptions {
  operation: GenerationOperation
  args: GenerateImageArgs
  request: OpenRouterImageRequest
  response: OpenRouterImageResponse
  runtime: RuntimeServices
  dependencies: ToolDependencies
  context: ToolContext
  references?: ResolvedReferences
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function responseData(response: OpenRouterImageResponse): Array<{
  b64_json: string
  media_type?: string
}> {
  if (!isRecord(response) || !Array.isArray(response.data) || response.data.length === 0) {
    throw new PluginError(
      "GENIMAGE_RESPONSE_INVALID",
      "OpenRouter returned no generated images.",
    )
  }
  if (response.data.length > 10) {
    throw new PluginError(
      "GENIMAGE_RESPONSE_INVALID",
      "OpenRouter returned more than the maximum of 10 images.",
    )
  }
  return response.data as Array<{ b64_json: string; media_type?: string }>
}

function responseCost(response: OpenRouterImageResponse): number | undefined {
  if (!isRecord(response) || !isRecord(response.usage)) return undefined
  const cost = response.usage.cost
  return typeof cost === "number" && Number.isFinite(cost) && cost >= 0
    ? cost
    : undefined
}

function formatCost(value: number | undefined): string {
  if (value === undefined) return "not reported"
  if (value !== 0 && value < 0.000001) return `$${value.toExponential(6)}`
  return `$${value.toFixed(6)}`
}

export async function preflightOutput(
  runtime: RuntimeServices,
  args: GenerateImageArgs,
  context: ToolContext,
  sourcePaths: ReadonlySet<string> = new Set(),
): Promise<void> {
  const configuredDirectory = assertSafeOutputRelativePath(
    runtime.options.outputDirectory,
    "directory",
  )
  const relative =
    args.output_path === undefined
      ? configuredDirectory
      : assertSafeOutputRelativePath(args.output_path)
  const absolute = path.resolve(context.worktree, relative.replaceAll("/", path.sep))
  const canonicalWorktree = await realpath(context.worktree)
  await assertOutputParentContained(
    canonicalWorktree,
    args.output_path === undefined ? absolute : path.dirname(absolute),
  )

  if ([...sourcePaths].some((source) => sameCanonicalPath(source, absolute))) {
    throw new PluginError(
      "GENIMAGE_SOURCE_OVERWRITE_FORBIDDEN",
      "The output path may not overwrite a source image.",
    )
  }
}

function toolResult(
  operation: GenerationOperation,
  runtime: RuntimeServices,
  saved: readonly SavedImage[],
  requestedCount: number,
  referenceCount: number,
  costUsd: number | undefined,
  warnings: readonly string[],
): ToolResult {
  const verb = operation === "edit" ? "Edited" : "Generated"
  const lines = [
    `${verb} ${saved.length} image${saved.length === 1 ? "" : "s"}.`,
    "",
    ...saved.map((image) => `- \`${image.relativePath}\``),
    "",
    `Model: ${runtime.options.model}`,
    `Routing: ${runtime.options.routing}`,
    `References: ${referenceCount}`,
    `Requested: ${requestedCount}`,
    `Returned: ${saved.length}`,
    `OpenRouter cost: ${formatCost(costUsd)}`,
  ]
  if (warnings.length > 0) {
    lines.push("", "Warnings:", ...warnings.map((warning) => `- ${warning}`))
  }

  return {
    title: `${verb} ${saved.length} image${saved.length === 1 ? "" : "s"}`,
    output: lines.join("\n"),
    metadata: {
      model: runtime.options.model,
      routing: runtime.options.routing,
      referenceCount,
      requestedCount,
      returnedCount: saved.length,
      ...(costUsd === undefined ? {} : { costUsd }),
      images: saved.map((image) => ({
        path: image.relativePath,
        mime: image.mime,
        bytes: image.bytes,
      })),
      warnings: [...warnings],
    },
    attachments: createToolAttachments(saved),
  }
}

export async function finishGeneration(
  options: FinishGenerationOptions,
): Promise<ToolResult> {
  const rawImages = responseData(options.response)
  const requestedCount = options.request.n ?? 1
  const decoded = decodeOutputImages(rawImages, {
    maxDecodedBytes: options.runtime.options.maxDecodedBytes,
    ...(options.request.output_format === undefined
      ? {}
      : { expectedFormat: options.request.output_format }),
  })
  const warnings = [...decoded.warnings]
  if (rawImages.length < requestedCount) {
    warnings.push(
      `OpenRouter returned ${rawImages.length} image(s), fewer than the ${requestedCount} requested.`,
    )
  }

  let saved: SavedImage[]
  try {
    saved = await saveImages({
      images: decoded.images,
      outputDirectory: options.runtime.options.outputDirectory,
      ...(options.args.output_path === undefined
        ? {}
        : { outputPath: options.args.output_path }),
      worktree: options.context.worktree,
      sourcePaths: [...(options.references?.canonicalSourcePaths ?? [])],
      signal: options.context.abort,
    })
  } catch (error) {
    if (!(error instanceof ImageSaveError) || error.savedImages.length === 0) throw error
    saved = [...error.savedImages]
    warnings.push(
      `${saved.length} image(s) were saved before a later output write failed (${error.code}).`,
    )
  }

  warnings.push(...saved.flatMap((image) => image.warnings))
  const uniqueWarnings = [...new Set(warnings)]
  options.dependencies.logger.log("info", "OpenRouter image generation completed.", {
    routing: options.runtime.options.routing,
    model: options.runtime.options.model,
    referenceCount: options.references?.references.length ?? 0,
    inputBytes: options.references?.localBytes ?? 0,
    outputBytes: saved.reduce((total, image) => total + image.bytes, 0),
    requestedCount,
    returnedCount: saved.length,
    ...promptFingerprint(options.args.prompt),
  })

  return toolResult(
    options.operation,
    options.runtime,
    saved,
    requestedCount,
    options.references?.references.length ?? 0,
    responseCost(options.response),
    uniqueWarnings,
  )
}
