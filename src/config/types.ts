import type { PluginError } from "../openrouter/errors.js"

export const IMAGE_ASPECT_RATIOS = [
  "1:1",
  "1:2",
  "1:4",
  "1:8",
  "2:1",
  "2:3",
  "2.35:1",
  "3:2",
  "3:4",
  "4:1",
  "4:3",
  "4:5",
  "5:2",
  "5:4",
  "5:7",
  "7:5",
  "8:1",
  "9:16",
  "16:9",
  "9:19.5",
  "19.5:9",
  "9:20",
  "20:9",
  "9:21",
  "21:9",
  "auto",
] as const

export const IMAGE_BACKGROUNDS = ["auto", "transparent", "opaque"] as const
export const IMAGE_OUTPUT_FORMATS = ["png", "jpeg", "webp", "svg"] as const
export const IMAGE_QUALITIES = ["auto", "low", "medium", "high", "xhigh", "max"] as const
export const IMAGE_RESOLUTIONS = ["512", "768", "1K", "1.5K", "2K", "4K"] as const
export const ROUTING_MODES = ["direct", "proxy"] as const

export type ImageAspectRatio = (typeof IMAGE_ASPECT_RATIOS)[number]
export type ImageBackground = (typeof IMAGE_BACKGROUNDS)[number]
export type ImageOutputFormat = (typeof IMAGE_OUTPUT_FORMATS)[number]
export type ImageQuality = (typeof IMAGE_QUALITIES)[number]
export type ImageResolution = (typeof IMAGE_RESOLUTIONS)[number]
export type RoutingMode = (typeof ROUTING_MODES)[number]

export interface ImageGenerationParameters {
  aspect_ratio?: ImageAspectRatio | undefined
  background?: ImageBackground | undefined
  n?: number | undefined
  output_format?: ImageOutputFormat | undefined
  output_compression?: number | undefined
  quality?: ImageQuality | undefined
  resolution?: ImageResolution | undefined
  seed?: number | undefined
}

export type ImageGenerationDefaults = ImageGenerationParameters

export interface PluginInputOptions {
  maxReferences?: number | undefined
  maxFileBytes?: number | undefined
  maxTotalBytes?: number | undefined
}

export interface PluginOptions {
  routing: RoutingMode
  model: string
  apiKey?: string | undefined
  managementApiKey?: string | undefined
  outputDirectory?: string | undefined
  defaults?: ImageGenerationDefaults | undefined
  input?: PluginInputOptions | undefined
  requestTimeoutMs?: number | undefined
  modelCacheTtlMs?: number | undefined
  maxResponseBytes?: number | undefined
  maxDecodedBytes?: number | undefined
}

export interface ResolvedImageGenerationDefaults
  extends ImageGenerationParameters {
  n: number
}

export interface ResolvedPluginInputOptions {
  maxReferences: number
  maxFileBytes: number
  maxTotalBytes: number
}

export interface ResolvedPluginOptions {
  routing: RoutingMode
  model: string
  apiKey: string
  managementApiKey?: string
  outputDirectory: string
  defaults: ResolvedImageGenerationDefaults
  input: ResolvedPluginInputOptions
  requestTimeoutMs: number
  modelCacheTtlMs: number
  maxResponseBytes: number
  maxDecodedBytes: number
}

export interface ConfigEnvironment {
  OPENROUTER_API_KEY?: string | undefined
  OPENROUTER_MANAGEMENT_API_KEY?: string | undefined
}

export type PluginConfigState =
  | {
      blocked: false
      options: ResolvedPluginOptions
    }
  | {
      blocked: true
      error: PluginError
    }
