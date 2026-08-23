export const PLUGIN_ERROR_CODES = [
  "GENIMAGE_CONFIG_INVALID",
  "GENIMAGE_OPENROUTER_KEY_MISSING",
  "GENIMAGE_REFERENCE_REQUIRED",
  "GENIMAGE_REFERENCE_NOT_FOUND",
  "GENIMAGE_REFERENCE_INDEX_INVALID",
  "GENIMAGE_REFERENCE_FORMAT_UNSUPPORTED",
  "GENIMAGE_REFERENCE_TOO_LARGE",
  "GENIMAGE_TOTAL_REFERENCE_SIZE_EXCEEDED",
  "GENIMAGE_REFERENCE_INVALID",
  "GENIMAGE_REFERENCE_URL_INVALID",
  "GENIMAGE_TOO_MANY_REFERENCES",
  "GENIMAGE_ATTACHMENT_ACCESS_FAILED",
  "GENIMAGE_MODEL_NOT_FOUND",
  "GENIMAGE_MODEL_DOES_NOT_SUPPORT_IMAGE_INPUT",
  "GENIMAGE_MODEL_DOES_NOT_SUPPORT_IMAGE_OUTPUT",
  "GENIMAGE_PARAMETER_UNSUPPORTED",
  "GENIMAGE_OPENROUTER_AUTH",
  "GENIMAGE_OPENROUTER_FORBIDDEN",
  "GENIMAGE_INSUFFICIENT_CREDITS",
  "GENIMAGE_RATE_LIMITED",
  "GENIMAGE_BAD_REQUEST",
  "GENIMAGE_REQUEST_TOO_LARGE",
  "GENIMAGE_PROVIDER_ERROR",
  "GENIMAGE_TIMEOUT",
  "GENIMAGE_REQUEST_STATUS_UNKNOWN",
  "GENIMAGE_RESPONSE_INVALID",
  "GENIMAGE_IMAGE_INVALID",
  "GENIMAGE_GATEWAY_BOOTSTRAP_FAILED",
  "GENIMAGE_GATEWAY_SIGNATURE_INVALID",
  "GENIMAGE_GATEWAY_CACHE_EXPIRED",
  "GENIMAGE_GATEWAY_CONNECT_FAILED",
  "GENIMAGE_GATEWAY_TIMEOUT",
  "GENIMAGE_OUTPUT_PATH_INVALID",
  "GENIMAGE_OUTPUT_OUTSIDE_WORKTREE",
  "GENIMAGE_OUTPUT_FORMAT_MISMATCH",
  "GENIMAGE_OUTPUT_WRITE_FAILED",
  "GENIMAGE_SOURCE_OVERWRITE_FORBIDDEN",
] as const

export type PluginErrorCode = (typeof PLUGIN_ERROR_CODES)[number]

export interface PluginErrorShape {
  code: PluginErrorCode
  message: string
  details?: Record<string, unknown>
  suggestion?: string
}

export interface PluginErrorOptions {
  details?: Record<string, unknown>
  suggestion?: string
  cause?: unknown
}

const PLUGIN_ERROR_CODE_SET = new Set<string>(PLUGIN_ERROR_CODES)

export class PluginError extends Error {
  readonly code: PluginErrorCode
  readonly details: Record<string, unknown> | undefined
  readonly suggestion: string | undefined

  constructor(
    code: PluginErrorCode,
    message: string,
    options: PluginErrorOptions = {},
  ) {
    super(message, "cause" in options ? { cause: options.cause } : undefined)
    this.name = "PluginError"
    this.code = code
    this.details = options.details
    this.suggestion = options.suggestion
  }

  toJSON(): PluginErrorShape {
    return {
      code: this.code,
      message: this.message,
      ...(this.details === undefined ? {} : { details: this.details }),
      ...(this.suggestion === undefined
        ? {}
        : { suggestion: this.suggestion }),
    }
  }
}

export function isPluginError(error: unknown): error is PluginError {
  if (error instanceof PluginError) {
    return true
  }

  if (typeof error !== "object" || error === null) {
    return false
  }

  const candidate = error as { code?: unknown; message?: unknown }
  return (
    typeof candidate.code === "string" &&
    PLUGIN_ERROR_CODE_SET.has(candidate.code) &&
    typeof candidate.message === "string"
  )
}
