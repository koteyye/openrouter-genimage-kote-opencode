import type {
  ImageAspectRatio,
  ImageBackground,
  ImageGenerationParameters,
  ImageOutputFormat,
  ImageQuality,
  ImageResolution,
} from "../config/types.js"

export interface GenerateImageArgs extends ImageGenerationParameters {
  prompt: string
  output_path?: string | undefined
}

export interface OpenRouterInputReference {
  type: "image_url"
  image_url: {
    url: string
  }
}

export interface OpenRouterImageRequest {
  model: string
  prompt: string
  input_references?: OpenRouterInputReference[] | undefined
  aspect_ratio?: ImageAspectRatio | undefined
  background?: ImageBackground | undefined
  n?: number | undefined
  output_format?: ImageOutputFormat | undefined
  output_compression?: number | undefined
  quality?: ImageQuality | undefined
  resolution?: ImageResolution | undefined
  seed?: number | undefined
}

export interface OpenRouterGeneratedImage {
  b64_json: string
  media_type?: string | undefined
}

export interface OpenRouterImageUsage {
  cost?: number | undefined
  [key: string]: unknown
}

export interface OpenRouterImageResponse {
  data: OpenRouterGeneratedImage[]
  usage?: OpenRouterImageUsage | undefined
}
