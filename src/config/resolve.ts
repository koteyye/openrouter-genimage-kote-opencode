import type { z } from "zod"

import { PluginError, isPluginError } from "../openrouter/errors.js"
import { DEFAULT_OPTIONS, pluginOptionsSchema } from "./schema.js"
import type {
  ConfigEnvironment,
  PluginConfigState,
  ResolvedPluginOptions,
} from "./types.js"

function validationDetails(error: z.ZodError): Record<string, unknown> {
  return {
    issues: error.issues.map((issue) => ({
      code: issue.code,
      path: issue.path.map(String).join("."),
      message: issue.message,
    })),
  }
}

function normalizeEnvironmentKey(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined
  }

  const normalized = value.trim()
  if (normalized.length === 0) return undefined
  if (
    normalized.length > 4_096 ||
    /[\u0000-\u001f\u007f]/u.test(normalized)
  ) {
    throw new PluginError(
      "GENIMAGE_CONFIG_INVALID",
      "An OpenRouter credential from the environment is invalid.",
      {
        suggestion:
          "Set a single-line OPENROUTER_API_KEY or OPENROUTER_MANAGEMENT_API_KEY value.",
      },
    )
  }
  return normalized
}

export function resolvePluginOptions(
  rawOptions: unknown,
  environment: ConfigEnvironment = {
    OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY,
    OPENROUTER_MANAGEMENT_API_KEY:
      process.env.OPENROUTER_MANAGEMENT_API_KEY,
  },
): ResolvedPluginOptions {
  const parsed = pluginOptionsSchema.safeParse(rawOptions)
  if (!parsed.success) {
    throw new PluginError(
      "GENIMAGE_CONFIG_INVALID",
      "OpenRouter image plugin configuration is invalid.",
      {
        details: validationDetails(parsed.error),
        suggestion: "Check the plugin tuple options in opencode.jsonc.",
      },
    )
  }

  const apiKey =
    parsed.data.apiKey ??
    normalizeEnvironmentKey(environment.OPENROUTER_API_KEY)
  if (apiKey === undefined) {
    throw new PluginError(
      "GENIMAGE_OPENROUTER_KEY_MISSING",
      "An OpenRouter API key is required.",
      {
        suggestion:
          "Set apiKey in plugin options or OPENROUTER_API_KEY in the environment.",
      },
    )
  }

  const managementApiKey =
    parsed.data.managementApiKey ??
    normalizeEnvironmentKey(environment.OPENROUTER_MANAGEMENT_API_KEY)

  return {
    routing: parsed.data.routing,
    model: parsed.data.model,
    apiKey,
    ...(managementApiKey === undefined ? {} : { managementApiKey }),
    outputDirectory:
      parsed.data.outputDirectory ?? DEFAULT_OPTIONS.outputDirectory,
    defaults: {
      ...(parsed.data.defaults?.aspect_ratio === undefined
        ? {}
        : { aspect_ratio: parsed.data.defaults.aspect_ratio }),
      ...(parsed.data.defaults?.background === undefined
        ? {}
        : { background: parsed.data.defaults.background }),
      n: parsed.data.defaults?.n ?? DEFAULT_OPTIONS.defaults.n,
      ...(parsed.data.defaults?.output_format === undefined
        ? {}
        : { output_format: parsed.data.defaults.output_format }),
      ...(parsed.data.defaults?.output_compression === undefined
        ? {}
        : { output_compression: parsed.data.defaults.output_compression }),
      ...(parsed.data.defaults?.quality === undefined
        ? {}
        : { quality: parsed.data.defaults.quality }),
      ...(parsed.data.defaults?.resolution === undefined
        ? {}
        : { resolution: parsed.data.defaults.resolution }),
      ...(parsed.data.defaults?.seed === undefined
        ? {}
        : { seed: parsed.data.defaults.seed }),
    },
    input: {
      maxReferences:
        parsed.data.input?.maxReferences ??
        DEFAULT_OPTIONS.input.maxReferences,
      maxFileBytes:
        parsed.data.input?.maxFileBytes ?? DEFAULT_OPTIONS.input.maxFileBytes,
      maxTotalBytes:
        parsed.data.input?.maxTotalBytes ??
        DEFAULT_OPTIONS.input.maxTotalBytes,
    },
    requestTimeoutMs:
      parsed.data.requestTimeoutMs ?? DEFAULT_OPTIONS.requestTimeoutMs,
    modelCacheTtlMs:
      parsed.data.modelCacheTtlMs ?? DEFAULT_OPTIONS.modelCacheTtlMs,
    maxResponseBytes:
      parsed.data.maxResponseBytes ?? DEFAULT_OPTIONS.maxResponseBytes,
    maxDecodedBytes:
      parsed.data.maxDecodedBytes ?? DEFAULT_OPTIONS.maxDecodedBytes,
  }
}

export function resolvePluginConfig(
  rawOptions: unknown,
  environment: ConfigEnvironment = {
    OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY,
    OPENROUTER_MANAGEMENT_API_KEY:
      process.env.OPENROUTER_MANAGEMENT_API_KEY,
  },
): PluginConfigState {
  try {
    return {
      blocked: false,
      options: resolvePluginOptions(rawOptions, environment),
    }
  } catch (error) {
    if (isPluginError(error)) {
      return { blocked: true, error }
    }

    throw error
  }
}

export function requireResolvedPluginOptions(
  state: PluginConfigState,
): ResolvedPluginOptions {
  if (state.blocked) {
    throw state.error
  }

  return state.options
}
