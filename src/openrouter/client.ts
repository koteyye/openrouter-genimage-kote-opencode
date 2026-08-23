import { createHash } from "node:crypto"

import type { ResolvedPluginOptions, RoutingMode } from "../config/types.js"
import type { SafeLogger } from "../logging.js"
import type { HttpTransport } from "../transport/types.js"
import { GatewayTransportError } from "../transport/types.js"
import {
  abortableStreamRead,
  abortableDelay,
  createDeadlineSignal,
  isAbortError,
} from "../utils/abort.js"
import { PluginError } from "./errors.js"
import {
  parseImageModelEndpointsResponse,
  parseImageModelsResponse,
  type ImageModel,
  type ImageModelEndpoints,
} from "./models.js"
import type {
  OpenRouterImageRequest,
  OpenRouterImageResponse,
} from "./schemas.js"

export const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1/"

const RETRYABLE_GET_STATUS = new Set([429, 500, 502, 503, 504, 524, 529])
const MAX_GET_RETRIES = 2
const MAX_RETRY_DELAY_MS = 30_000

export interface OpenRouterKeyInfo {
  label?: string
  usage?: number
  usage_daily?: number
  usage_weekly?: number
  usage_monthly?: number
  byok_usage?: number
  byok_usage_daily?: number
  byok_usage_weekly?: number
  byok_usage_monthly?: number
  limit?: number | null
  limit_remaining?: number | null
  limit_reset?: string | null
  is_free_tier?: boolean
  is_management_key?: boolean
  expires_at?: string | null
}

export interface OpenRouterCredits {
  total_credits: number
  total_usage: number
}

export interface OpenRouterImageClient {
  listImageModels(signal: AbortSignal): Promise<ImageModel[]>
  listImageModelEndpoints(
    path: string,
    signal: AbortSignal,
  ): Promise<ImageModelEndpoints>
  generateImage(
    request: OpenRouterImageRequest,
    signal: AbortSignal,
  ): Promise<OpenRouterImageResponse>
  getCurrentKey(signal: AbortSignal): Promise<OpenRouterKeyInfo>
  getCredits(
    managementApiKey: string,
    signal: AbortSignal,
  ): Promise<OpenRouterCredits>
}

export interface OpenRouterClientOptions {
  pluginOptions: ResolvedPluginOptions
  transport: HttpTransport
  logger: SafeLogger
  baseUrl?: string
  sleep?: (milliseconds: number, signal: AbortSignal) => Promise<void>
  random?: () => number
}

interface RequestJsonOptions {
  method: "GET" | "POST"
  url: URL
  apiKey: string
  body?: OpenRouterImageRequest
  signal: AbortSignal
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function optionalFiniteNumber(
  record: Record<string, unknown>,
  name: string,
): number | undefined {
  const value = record[name]
  if (value === undefined) return undefined
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new TypeError(`Invalid numeric field: ${name}`)
  }
  return value
}

function optionalNullableNumber(
  record: Record<string, unknown>,
  name: string,
): number | null | undefined {
  const value = record[name]
  if (value === undefined || value === null) return value
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new TypeError(`Invalid numeric field: ${name}`)
  }
  return value
}

function optionalString(
  record: Record<string, unknown>,
  name: string,
): string | undefined {
  const value = record[name]
  if (value === undefined) return undefined
  if (typeof value !== "string") throw new TypeError(`Invalid string field: ${name}`)
  return value
}

function optionalNullableString(
  record: Record<string, unknown>,
  name: string,
): string | null | undefined {
  const value = record[name]
  if (value === undefined || value === null) return value
  if (typeof value !== "string") throw new TypeError(`Invalid string field: ${name}`)
  return value
}

function optionalLimitReset(
  record: Record<string, unknown>,
): string | null | undefined {
  const value = optionalNullableString(record, "limit_reset")
  if (
    typeof value === "string" &&
    !/^[A-Za-z0-9][A-Za-z0-9_.:+/-]{0,63}$/u.test(value)
  ) {
    throw new TypeError("Invalid string field: limit_reset")
  }
  return value
}

function optionalExpiryTimestamp(
  record: Record<string, unknown>,
): string | null | undefined {
  const value = optionalNullableString(record, "expires_at")
  if (
    typeof value === "string" &&
    (value.length > 64 ||
      /[\u0000-\u001f\u007f]/u.test(value) ||
      !Number.isFinite(Date.parse(value)))
  ) {
    throw new TypeError("Invalid string field: expires_at")
  }
  return value
}

function optionalBoolean(
  record: Record<string, unknown>,
  name: string,
): boolean | undefined {
  const value = record[name]
  if (value === undefined) return undefined
  if (typeof value !== "boolean") throw new TypeError(`Invalid boolean field: ${name}`)
  return value
}

function parseKeyInfo(value: unknown): OpenRouterKeyInfo {
  if (!isRecord(value) || !isRecord(value.data)) {
    throw new TypeError("OpenRouter key response has an invalid shape.")
  }
  const data = value.data
  return {
    ...optionalProperty("label", optionalString(data, "label")),
    ...optionalProperty("usage", optionalFiniteNumber(data, "usage")),
    ...optionalProperty("usage_daily", optionalFiniteNumber(data, "usage_daily")),
    ...optionalProperty("usage_weekly", optionalFiniteNumber(data, "usage_weekly")),
    ...optionalProperty("usage_monthly", optionalFiniteNumber(data, "usage_monthly")),
    ...optionalProperty("byok_usage", optionalFiniteNumber(data, "byok_usage")),
    ...optionalProperty(
      "byok_usage_daily",
      optionalFiniteNumber(data, "byok_usage_daily"),
    ),
    ...optionalProperty(
      "byok_usage_weekly",
      optionalFiniteNumber(data, "byok_usage_weekly"),
    ),
    ...optionalProperty(
      "byok_usage_monthly",
      optionalFiniteNumber(data, "byok_usage_monthly"),
    ),
    ...optionalProperty("limit", optionalNullableNumber(data, "limit")),
    ...optionalProperty(
      "limit_remaining",
      optionalNullableNumber(data, "limit_remaining"),
    ),
    ...optionalProperty("limit_reset", optionalLimitReset(data)),
    ...optionalProperty("is_free_tier", optionalBoolean(data, "is_free_tier")),
    ...optionalProperty(
      "is_management_key",
      optionalBoolean(data, "is_management_key"),
    ),
    ...optionalProperty("expires_at", optionalExpiryTimestamp(data)),
  }
}

function optionalProperty<Key extends string, Value>(
  key: Key,
  value: Value | undefined,
): { [Property in Key]?: Value } {
  return value === undefined ? {} : ({ [key]: value } as { [Property in Key]: Value })
}

function parseCredits(value: unknown): OpenRouterCredits {
  if (!isRecord(value) || !isRecord(value.data)) {
    throw new TypeError("OpenRouter credits response has an invalid shape.")
  }
  const totalCredits = optionalFiniteNumber(value.data, "total_credits")
  const totalUsage = optionalFiniteNumber(value.data, "total_usage")
  if (totalCredits === undefined || totalUsage === undefined) {
    throw new TypeError("OpenRouter credits response is missing required fields.")
  }
  return { total_credits: totalCredits, total_usage: totalUsage }
}

function parseRetryAfter(value: string | null, now = Date.now()): number | undefined {
  if (value === null) return undefined
  const seconds = Number(value)
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1_000
  const date = Date.parse(value)
  if (!Number.isFinite(date)) return undefined
  return Math.max(0, date - now)
}

function safeRequestId(
  value: string | null,
  sensitiveValues: readonly (string | undefined)[],
): string | undefined {
  if (value === null || value.length === 0 || value.length > 1_024) return undefined
  if (
    sensitiveValues.some(
      (sensitive) =>
        sensitive !== undefined &&
        sensitive !== "" &&
        (value.includes(sensitive) || sensitive.includes(value)),
    )
  ) {
    return undefined
  }
  return `sha256:${createHash("sha256").update(value).digest("hex").slice(0, 16)}`
}

function mapStatus(status: number, requestId: string | undefined): PluginError {
  const details = {
    status,
    ...(requestId === undefined ? {} : { requestId }),
  }
  switch (status) {
    case 400:
      return new PluginError(
        "GENIMAGE_BAD_REQUEST",
        "OpenRouter rejected the image request.",
        { details },
      )
    case 401:
      return new PluginError(
        "GENIMAGE_OPENROUTER_AUTH",
        "OpenRouter rejected the configured API key.",
        { details },
      )
    case 402:
      return new PluginError(
        "GENIMAGE_INSUFFICIENT_CREDITS",
        "OpenRouter reports insufficient credits for this request.",
        { details },
      )
    case 403:
      return new PluginError(
        "GENIMAGE_OPENROUTER_FORBIDDEN",
        "OpenRouter denied this request.",
        { details },
      )
    case 413:
      return new PluginError(
        "GENIMAGE_REQUEST_TOO_LARGE",
        "OpenRouter rejected the request because it is too large.",
        { details },
      )
    case 429:
      return new PluginError(
        "GENIMAGE_RATE_LIMITED",
        "OpenRouter rate-limited this request.",
        { details },
      )
    default:
      return new PluginError(
        "GENIMAGE_PROVIDER_ERROR",
        "OpenRouter could not complete the request.",
        { details },
      )
  }
}

async function readBoundedBody(
  response: Response,
  maximumBytes: number,
  signal: AbortSignal,
): Promise<Uint8Array> {
  const contentLength = response.headers.get("content-length")
  if (contentLength !== null) {
    const parsed = Number(contentLength)
    if (Number.isFinite(parsed) && parsed > maximumBytes) {
      await response.body?.cancel().catch(() => {})
      throw new PluginError(
        "GENIMAGE_RESPONSE_INVALID",
        "OpenRouter response exceeds the configured size limit.",
        { details: { maxResponseBytes: maximumBytes } },
      )
    }
  }

  if (response.body === null) return new Uint8Array()
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0

  try {
    for (;;) {
      if (signal.aborted) throw signal.reason
      const chunk = await abortableStreamRead(reader, signal)
      if (chunk.done) break
      total += chunk.value.byteLength
      if (total > maximumBytes) {
        await reader.cancel("response size limit exceeded").catch(() => {})
        throw new PluginError(
          "GENIMAGE_RESPONSE_INVALID",
          "OpenRouter response exceeds the configured size limit.",
          { details: { maxResponseBytes: maximumBytes } },
        )
      }
      chunks.push(chunk.value)
    }
  } finally {
    try {
      reader.releaseLock()
    } catch {
      void reader.cancel().catch(() => {})
    }
  }

  const result = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    result.set(chunk, offset)
    offset += chunk.byteLength
  }
  return result
}

function parseJson(bytes: Uint8Array): unknown {
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as unknown
  } catch (error) {
    throw new PluginError(
      "GENIMAGE_RESPONSE_INVALID",
      "OpenRouter returned invalid JSON.",
      { cause: error },
    )
  }
}

export class DefaultOpenRouterImageClient implements OpenRouterImageClient {
  readonly #options: ResolvedPluginOptions
  readonly #transport: HttpTransport
  readonly #logger: SafeLogger
  readonly #baseUrl: URL
  readonly #sleep: (milliseconds: number, signal: AbortSignal) => Promise<void>
  readonly #random: () => number

  constructor(options: OpenRouterClientOptions) {
    this.#options = options.pluginOptions
    this.#transport = options.transport
    this.#logger = options.logger
    this.#baseUrl = new URL(options.baseUrl ?? OPENROUTER_BASE_URL)
    this.#sleep = options.sleep ?? abortableDelay
    this.#random = options.random ?? Math.random
  }

  async listImageModels(signal: AbortSignal): Promise<ImageModel[]> {
    const data = await this.#requestJson({
      method: "GET",
      url: new URL("images/models", this.#baseUrl),
      apiKey: this.#options.apiKey,
      signal,
    })
    try {
      return parseImageModelsResponse(data)
    } catch (error) {
      throw new PluginError(
        "GENIMAGE_RESPONSE_INVALID",
        "OpenRouter returned invalid image-model metadata.",
        { cause: error },
      )
    }
  }

  async listImageModelEndpoints(
    path: string,
    signal: AbortSignal,
  ): Promise<ImageModelEndpoints> {
    const url = this.#validateCapabilityUrl(path)
    const data = await this.#requestJson({
      method: "GET",
      url,
      apiKey: this.#options.apiKey,
      signal,
    })
    try {
      return parseImageModelEndpointsResponse(data)
    } catch (error) {
      throw new PluginError(
        "GENIMAGE_RESPONSE_INVALID",
        "OpenRouter returned invalid endpoint capabilities.",
        { cause: error },
      )
    }
  }

  async generateImage(
    request: OpenRouterImageRequest,
    signal: AbortSignal,
  ): Promise<OpenRouterImageResponse> {
    const data = await this.#requestJson({
      method: "POST",
      url: new URL("images", this.#baseUrl),
      apiKey: this.#options.apiKey,
      body: request,
      signal,
    })
    if (!isRecord(data)) {
      throw new PluginError(
        "GENIMAGE_RESPONSE_INVALID",
        "OpenRouter returned an invalid image response.",
      )
    }
    return data as unknown as OpenRouterImageResponse
  }

  async getCurrentKey(signal: AbortSignal): Promise<OpenRouterKeyInfo> {
    const data = await this.#requestJson({
      method: "GET",
      url: new URL("key", this.#baseUrl),
      apiKey: this.#options.apiKey,
      signal,
    })
    try {
      return parseKeyInfo(data)
    } catch (error) {
      throw new PluginError(
        "GENIMAGE_RESPONSE_INVALID",
        "OpenRouter returned invalid API-key information.",
        { cause: error },
      )
    }
  }

  async getCredits(
    managementApiKey: string,
    signal: AbortSignal,
  ): Promise<OpenRouterCredits> {
    const data = await this.#requestJson({
      method: "GET",
      url: new URL("credits", this.#baseUrl),
      apiKey: managementApiKey,
      signal,
    })
    try {
      return parseCredits(data)
    } catch (error) {
      throw new PluginError(
        "GENIMAGE_RESPONSE_INVALID",
        "OpenRouter returned invalid account credit information.",
        { cause: error },
      )
    }
  }

  #validateCapabilityUrl(path: string): URL {
    let url: URL
    try {
      url = new URL(path, this.#baseUrl)
    } catch (error) {
      throw new PluginError(
        "GENIMAGE_RESPONSE_INVALID",
        "OpenRouter returned an invalid endpoint-capabilities URL.",
        { cause: error },
      )
    }

    const requiredPrefix = `${this.#baseUrl.pathname}images/models/`
    if (
      url.origin !== this.#baseUrl.origin ||
      !url.pathname.startsWith(requiredPrefix) ||
      !url.pathname.endsWith("/endpoints") ||
      url.username !== "" ||
      url.password !== "" ||
      url.search !== "" ||
      url.hash !== ""
    ) {
      throw new PluginError(
        "GENIMAGE_RESPONSE_INVALID",
        "OpenRouter returned an unsafe endpoint-capabilities URL.",
      )
    }
    return url
  }

  async #requestJson(options: RequestJsonOptions): Promise<unknown> {
    let headers: Headers
    try {
      headers = new Headers({
        Authorization: `Bearer ${options.apiKey}`,
        Accept: "application/json",
        "X-Title": "openrouter-genimage-kote-opencode",
      })
    } catch {
      throw new PluginError(
        "GENIMAGE_CONFIG_INVALID",
        "The configured OpenRouter credential cannot be used as an HTTP authorization header.",
        {
          suggestion: "Configure a single-line OpenRouter API key.",
        },
      )
    }
    const body = options.body === undefined ? undefined : JSON.stringify(options.body)
    if (body !== undefined) headers.set("Content-Type", "application/json")

    const deadline = createDeadlineSignal(
      options.signal,
      this.#options.requestTimeoutMs,
    )
    const maximumAttempts = options.method === "GET" ? MAX_GET_RETRIES + 1 : 1
    try {
      for (let attempt = 0; attempt < maximumAttempts; attempt += 1) {
        let response: Response
        try {
          response = await this.#transport.request(
            options.url,
            {
              method: options.method,
              headers,
              redirect: "manual",
              ...(body === undefined ? {} : { body }),
            },
            deadline.signal,
          )
        } catch (error) {
          if (error instanceof GatewayTransportError) {
            throw new PluginError(error.code, error.message, { cause: error })
          }
          if (deadline.didTimeout()) {
            const code =
              this.#options.routing === "proxy"
                ? "GENIMAGE_GATEWAY_TIMEOUT"
                : "GENIMAGE_TIMEOUT"
            throw new PluginError(code, "The OpenRouter request timed out.", {
              cause: error,
            })
          }
          if (options.signal.aborted || isAbortError(error)) throw error
          if (options.method === "POST") {
            throw new PluginError(
              "GENIMAGE_REQUEST_STATUS_UNKNOWN",
              "The connection ended before OpenRouter confirmed the generation status. The request was not retried to avoid duplicate charges.",
              {
                cause: error,
                suggestion:
                  "Check OpenRouter activity before manually trying the generation again.",
              },
            )
          }
          if (attempt + 1 >= maximumAttempts) {
            throw new PluginError(
              "GENIMAGE_PROVIDER_ERROR",
              "OpenRouter could not be reached after retrying the read-only request.",
              { cause: error },
            )
          }
          await this.#sleep(250 + Math.floor(this.#random() * 250), deadline.signal)
          continue
        }

        const requestId = safeRequestId(
          response.headers.get("x-request-id") ??
            response.headers.get("x-openrouter-request-id"),
          [
            this.#options.apiKey,
            this.#options.managementApiKey,
            options.body?.prompt,
          ],
        )
        this.#logger.log("debug", "OpenRouter request completed.", {
          routing: this.#options.routing,
          model: this.#options.model,
          httpStatus: response.status,
          ...(requestId === undefined ? {} : { requestId }),
        })

        if (
          !response.ok &&
          options.method === "GET" &&
          RETRYABLE_GET_STATUS.has(response.status) &&
          attempt + 1 < maximumAttempts
        ) {
          await response.body?.cancel().catch(() => {})
          const retryAfter = parseRetryAfter(response.headers.get("retry-after"))
          const jitter = Math.floor(this.#random() * 250)
          const delay = Math.min(
            MAX_RETRY_DELAY_MS,
            retryAfter ?? 250 * 2 ** attempt,
          )
          await this.#sleep(delay + jitter, deadline.signal)
          continue
        }

        if (!response.ok) {
          await response.body?.cancel().catch(() => {})
          throw mapStatus(response.status, requestId)
        }

        let bytes: Uint8Array
        try {
          bytes = await readBoundedBody(
            response,
            this.#options.maxResponseBytes,
            deadline.signal,
          )
        } catch (error) {
          if (error instanceof PluginError) throw error
          if (deadline.didTimeout()) {
            const code =
              this.#options.routing === "proxy"
                ? "GENIMAGE_GATEWAY_TIMEOUT"
                : "GENIMAGE_TIMEOUT"
            throw new PluginError(code, "The OpenRouter response timed out.", {
              cause: error,
            })
          }
          if (options.signal.aborted || isAbortError(error)) throw error
          if (options.method === "POST") {
            throw new PluginError(
              "GENIMAGE_REQUEST_STATUS_UNKNOWN",
              "OpenRouter accepted the request but its response ended before the generated image could be read. The request was not retried to avoid duplicate charges.",
              { cause: error },
            )
          }
          if (attempt + 1 < maximumAttempts) {
            await this.#sleep(
              250 + Math.floor(this.#random() * 250),
              deadline.signal,
            )
            continue
          }
          throw new PluginError(
            "GENIMAGE_PROVIDER_ERROR",
            "OpenRouter response streaming failed after retrying the read-only request.",
            { cause: error },
          )
        }
        return parseJson(bytes)
      }

      throw new PluginError(
        "GENIMAGE_PROVIDER_ERROR",
        "OpenRouter request attempts were exhausted.",
      )
    } finally {
      deadline.dispose()
    }
  }
}

export function createOpenRouterClient(
  pluginOptions: ResolvedPluginOptions,
  transport: HttpTransport,
  logger: SafeLogger,
  overrides: Pick<OpenRouterClientOptions, "baseUrl" | "sleep" | "random"> = {},
): DefaultOpenRouterImageClient {
  return new DefaultOpenRouterImageClient({
    pluginOptions,
    transport,
    logger,
    ...overrides,
  })
}

export function routingForClient(options: ResolvedPluginOptions): RoutingMode {
  return options.routing
}
