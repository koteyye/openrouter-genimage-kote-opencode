import { createHash } from "node:crypto"

export type LogLevel = "debug" | "info" | "warn" | "error"

export type SafeLogFields = Partial<{
  routing: "direct" | "proxy"
  model: string
  requestId: string
  errorCode: string
  httpStatus: number
  referenceCount: number
  inputBytes: number
  outputBytes: number
  outputPath: string
  requestedCount: number
  returnedCount: number
  cacheStatus: "hit" | "miss" | "expired"
  gatewayOrigin: string
  promptLength: number
  promptSha256Prefix: string
}>

export interface SafeLogger {
  log(level: LogLevel, message: string, fields?: SafeLogFields): void
}

export const noopLogger: SafeLogger = {
  log() {},
}

type OpenCodeLogClient = {
  app: {
    log(options: {
      body: {
        service: string
        level: LogLevel
        message: string
        extra?: Record<string, unknown>
      }
      query?: { directory?: string }
    }): Promise<unknown>
  }
}

const SECRET_PATTERNS = [
  /sk-or-[^\s,;]+/giu,
  /\bBearer\s+[^\s,;]+/giu,
  /\b(?:Proxy-)?Authorization\b\s*[:=]\s*[^\s,;]+/giu,
  /\bOPENROUTER_(?:MANAGEMENT_)?API_KEY\b\s*[:=]\s*[^\s,;]+/giu,
] as const

export function redactSecrets(value: string): string {
  let result = value
  for (const pattern of SECRET_PATTERNS) {
    result = result.replace(pattern, "[REDACTED]")
  }
  return result
}

export function safeUrlOrigin(value: string | URL): string | undefined {
  try {
    return new URL(value).origin
  } catch {
    return undefined
  }
}

export function promptFingerprint(prompt: string): {
  promptLength: number
  promptSha256Prefix: string
} {
  return {
    promptLength: Array.from(prompt).length,
    promptSha256Prefix: createHash("sha256").update(prompt).digest("hex").slice(0, 12),
  }
}

function sanitizeLogFields(fields: SafeLogFields): SafeLogFields {
  return Object.fromEntries(
    Object.entries(fields).map(([key, value]) => [
      key,
      typeof value === "string"
        ? redactSecrets(value)
            .replace(/[\u0000-\u001f\u007f]+/gu, " ")
            .slice(0, 512)
        : value,
    ]),
  ) as SafeLogFields
}

export function createOpenCodeLogger(
  client: OpenCodeLogClient,
  directory: string,
): SafeLogger {
  return {
    log(level, message, fields) {
      const safeMessage = redactSecrets(message).slice(0, 512)
      const body = {
        service: "openrouter-genimage-kote-opencode",
        level,
        message: safeMessage,
        ...(fields === undefined ? {} : { extra: sanitizeLogFields(fields) }),
      }

      void client.app.log({ body, query: { directory } }).catch(() => {
        // Logging must never change routing or tool behavior.
      })
    },
  }
}
