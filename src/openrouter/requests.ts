import type {
  ImageGenerationParameters,
  ResolvedPluginOptions,
} from "../config/types.js"
import {
  generateImageArgsSchema,
  generationParametersSchema,
} from "../config/schema.js"
import { PluginError } from "./errors.js"
import type {
  GenerateImageArgs,
  OpenRouterImageRequest,
  OpenRouterInputReference,
} from "./schemas.js"

const PARAMETER_KEYS = [
  "aspect_ratio",
  "background",
  "n",
  "output_format",
  "output_compression",
  "quality",
  "resolution",
  "seed",
] as const satisfies readonly (keyof ImageGenerationParameters)[]

function parameterError(): PluginError {
  return new PluginError(
    "GENIMAGE_PARAMETER_UNSUPPORTED",
    "Image generation parameters are invalid or incompatible.",
    {
      suggestion:
        "Check the prompt, output format, background, compression, and generation limits.",
    },
  )
}

function parseArgs(rawArgs: unknown): GenerateImageArgs {
  const result = generateImageArgsSchema.safeParse(rawArgs)
  if (!result.success) {
    throw parameterError()
  }

  return result.data
}

function copyDefinedParameters(
  source: ImageGenerationParameters,
): ImageGenerationParameters {
  const result: ImageGenerationParameters = {}

  for (const key of PARAMETER_KEYS) {
    const value = source[key]
    if (value !== undefined) {
      Object.assign(result, { [key]: value })
    }
  }

  return result
}

export function mergeGenerationParameters(
  defaults: ImageGenerationParameters,
  overrides: ImageGenerationParameters,
): ImageGenerationParameters {
  const merged = {
    ...copyDefinedParameters(defaults),
    ...copyDefinedParameters(overrides),
  }
  const result = generationParametersSchema.safeParse(merged)
  if (!result.success) {
    throw parameterError()
  }

  return copyDefinedParameters(result.data)
}

function createBaseRequest(
  options: Pick<ResolvedPluginOptions, "model" | "defaults">,
  rawArgs: unknown,
): OpenRouterImageRequest {
  const args = parseArgs(rawArgs)
  const parameters = mergeGenerationParameters(options.defaults, args)

  return {
    model: options.model,
    prompt: args.prompt,
    ...parameters,
  }
}

export function buildTextToImageRequest(
  options: Pick<ResolvedPluginOptions, "model" | "defaults">,
  args: GenerateImageArgs,
): OpenRouterImageRequest {
  return createBaseRequest(options, args)
}

export function buildImageToImageRequest(
  options: Pick<ResolvedPluginOptions, "model" | "defaults" | "input">,
  args: GenerateImageArgs,
  inputReferences: readonly OpenRouterInputReference[],
): OpenRouterImageRequest {
  if (inputReferences.length === 0) {
    throw new PluginError(
      "GENIMAGE_REFERENCE_REQUIRED",
      "Image editing requires at least one visual reference.",
    )
  }

  if (inputReferences.length > options.input.maxReferences) {
    throw new PluginError(
      "GENIMAGE_TOO_MANY_REFERENCES",
      "The number of image references exceeds the configured limit.",
      { details: { maxReferences: options.input.maxReferences } },
    )
  }

  const references = inputReferences.map((reference) => ({
    type: reference.type,
    image_url: { url: reference.image_url.url },
  }))

  return {
    ...createBaseRequest(options, args),
    input_references: references,
  }
}
