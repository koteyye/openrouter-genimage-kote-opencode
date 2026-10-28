import { describe, expect, test } from "bun:test"

import { resolvePluginOptions } from "../../src/config/resolve.js"
import type { ResolvedPluginOptions, RoutingMode } from "../../src/config/types.js"
import type { SafeLogFields, SafeLogger } from "../../src/logging.js"
import {
  createOpenRouterClient,
  type DefaultOpenRouterImageClient,
} from "../../src/openrouter/client.js"
import { PluginError } from "../../src/openrouter/errors.js"
import type { OpenRouterImageRequest } from "../../src/openrouter/schemas.js"
import type { HttpTransport } from "../../src/transport/types.js"

const BASE_URL = "https://openrouter.test/api/v1/"
const MODEL_ID = "vendor/image-model"
const GENERATION_KEY = "generation-secret"
const MANAGEMENT_KEY = "management-secret"

interface CapturedRequest {
  readonly init: RequestInit
  readonly signal: AbortSignal
  readonly url: string
}

type RequestHandler = (
  request: CapturedRequest,
  attempt: number,
) => Promise<Response> | Response

class ScriptedTransport implements HttpTransport {
  readonly requests: CapturedRequest[] = []

  constructor(readonly handler: RequestHandler) {}

  request(url: URL, init: RequestInit, signal: AbortSignal): Promise<Response> {
    const captured = { url: url.toString(), init, signal }
    this.requests.push(captured)
    return Promise.resolve(this.handler(captured, this.requests.length - 1))
  }
}

interface LogRecord {
  readonly fields?: SafeLogFields
  readonly message: string
}

function logger(records: LogRecord[] = []): SafeLogger {
  return {
    log(_level, message, fields) {
      records.push({
        message,
        ...(fields === undefined ? {} : { fields }),
      })
    },
  }
}

function options(
  routing: RoutingMode = "direct",
  overrides: Partial<ResolvedPluginOptions> = {},
): ResolvedPluginOptions {
  return {
    ...resolvePluginOptions(
      {
        routing,
        model: MODEL_ID,
        apiKey: GENERATION_KEY,
        managementApiKey: MANAGEMENT_KEY,
        requestTimeoutMs: 1_000,
        maxResponseBytes: 1_024 * 1_024,
      },
      {},
    ),
    ...overrides,
  }
}

function client(
  transport: HttpTransport,
  pluginOptions = options(),
  overrides: Parameters<typeof createOpenRouterClient>[3] = {},
  safeLogger: SafeLogger = logger(),
): DefaultOpenRouterImageClient {
  return createOpenRouterClient(pluginOptions, transport, safeLogger, {
    baseUrl: BASE_URL,
    ...overrides,
  })
}

function jsonResponse(value: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(value), {
    ...init,
    headers: new Headers({
      "content-type": "application/json",
      ...Object.fromEntries(new Headers(init.headers).entries()),
    }),
  })
}

function modelResponse(): Response {
  return jsonResponse({
    data: [
      {
        id: MODEL_ID,
        architecture: {
          input_modalities: ["text", "image"],
          output_modalities: ["image"],
        },
        supported_parameters: {},
      },
    ],
  })
}

function authorization(request: CapturedRequest): string | null {
  return new Headers(request.init.headers).get("authorization")
}

function requestAt(requests: readonly CapturedRequest[], index: number): CapturedRequest {
  const request = requests.at(index)
  if (request === undefined) throw new Error(`Missing captured request ${index}`)
  return request
}

async function captureError(promise: Promise<unknown>): Promise<unknown> {
  let caught: unknown
  let rejected = false
  try {
    await promise
  } catch (error) {
    rejected = true
    caught = error
  }
  expect(rejected).toBe(true)
  return caught
}

async function pluginError(promise: Promise<unknown>): Promise<PluginError> {
  const error = await captureError(promise)
  expect(error).toBeInstanceOf(PluginError)
  if (!(error instanceof PluginError)) {
    throw new Error("Expected PluginError")
  }
  return error
}

function waitForAbort(signal: AbortSignal): Promise<Response> {
  return new Promise((_resolve, reject) => {
    const watchdog = setTimeout(() => {
      reject(new Error("Expected the request signal to abort"))
    }, 1_000)
    const rejectWithReason = () => {
      clearTimeout(watchdog)
      reject(
        signal.reason instanceof Error
          ? signal.reason
          : new DOMException("The operation was aborted", "AbortError"),
      )
    }
    if (signal.aborted) {
      rejectWithReason()
      return
    }
    signal.addEventListener("abort", rejectWithReason, { once: true })
  })
}

describe("OpenRouter HTTP client", () => {
  test("uses the exact endpoints, methods, authorization, and manual redirects", async () => {
    const responses = [
      modelResponse(),
      jsonResponse({ id: MODEL_ID, endpoints: [] }),
      jsonResponse({ data: [{ b64_json: "aW1hZ2U=" }] }),
      jsonResponse({ data: { label: "generation key", usage: 1.5 } }),
      jsonResponse({ data: { total_credits: 20, total_usage: 3.25 } }),
    ]
    const transport = new ScriptedTransport((_request, attempt) => {
      const response = responses.at(attempt)
      if (response === undefined) throw new Error("Unexpected request")
      return response
    })
    const openRouter = client(transport)
    const signal = new AbortController().signal
    const imageRequest: OpenRouterImageRequest = {
      model: MODEL_ID,
      prompt: "Create an inventory icon",
      n: 1,
    }

    await openRouter.listImageModels(signal)
    await openRouter.listImageModelEndpoints(
      "/api/v1/images/models/vendor%2Fimage-model/endpoints",
      signal,
    )
    await openRouter.generateImage(imageRequest, signal)
    await openRouter.getCurrentKey(signal)
    await openRouter.getCredits(MANAGEMENT_KEY, signal)

    expect(transport.requests.map((request) => request.url)).toEqual([
      `${BASE_URL}images/models`,
      `${BASE_URL}images/models/vendor%2Fimage-model/endpoints`,
      `${BASE_URL}images`,
      `${BASE_URL}key`,
      `${BASE_URL}credits`,
    ])
    expect(transport.requests.map((request) => request.init.method)).toEqual([
      "GET",
      "GET",
      "POST",
      "GET",
      "GET",
    ])
    expect(
      transport.requests.map((request) => request.init.redirect),
    ).toEqual(["manual", "manual", "manual", "manual", "manual"])
    expect(transport.requests.slice(0, 4).map(authorization)).toEqual([
      `Bearer ${GENERATION_KEY}`,
      `Bearer ${GENERATION_KEY}`,
      `Bearer ${GENERATION_KEY}`,
      `Bearer ${GENERATION_KEY}`,
    ])
    expect(authorization(requestAt(transport.requests, 4))).toBe(
      `Bearer ${MANAGEMENT_KEY}`,
    )

    const generation = requestAt(transport.requests, 2)
    const generationHeaders = new Headers(generation.init.headers)
    expect(generationHeaders.get("accept")).toBe("application/json")
    expect(generationHeaders.get("content-type")).toBe("application/json")
    expect(generationHeaders.get("x-title")).toBe(
      "openrouter-genimage-kote-opencode",
    )
    expect(generation.init.body).toBe(JSON.stringify(imageRequest))
    expect(
      new Headers(requestAt(transport.requests, 0).init.headers).has(
        "content-type",
      ),
    ).toBe(false)
  })

  test("rejects unsafe key reset and expiry strings before returning metadata", async () => {
    const unsafeValues = [
      { limit_reset: `monthly\n${GENERATION_KEY}` },
      { limit_reset: "x".repeat(65) },
      { expires_at: `2027-01-01T00:00:00Z\n${GENERATION_KEY}` },
      { expires_at: "not-a-timestamp" },
    ]

    for (const unsafe of unsafeValues) {
      const transport = new ScriptedTransport(() =>
        jsonResponse({ data: unsafe }),
      )
      const error = await pluginError(
        client(transport).getCurrentKey(new AbortController().signal),
      )
      expect(error.code).toBe("GENIMAGE_RESPONSE_INVALID")
      expect(JSON.stringify(error.toJSON())).not.toContain(GENERATION_KEY)
    }
  })

  test("parses configured and effective key budgets", async () => {
    const budget = {
      scope: "member",
      limit_usd: 50,
      spend_usd: 32.5,
      remaining_usd: 17.5,
      reset_interval: "weekly" as const,
      resets_at: "2026-10-12T00:00:00.000Z",
      include_byok: false,
    }
    const transport = new ScriptedTransport(() =>
      jsonResponse({ data: { budgets: [budget], effective_budget: budget } }),
    )

    const key = await client(transport).getCurrentKey(new AbortController().signal)

    expect(key.budgets).toEqual([budget])
    expect(key.effective_budget).toEqual(budget)
  })

  test("retries only read-only GET failures and honors retry timing", async () => {
    const delays: number[] = []
    const transport = new ScriptedTransport((_request, attempt) => {
      if (attempt === 0) return Promise.reject(new Error("connection reset"))
      if (attempt === 1) return new Response("temporary", { status: 503 })
      return modelResponse()
    })
    const openRouter = client(transport, options(), {
      random: () => 0,
      sleep(milliseconds) {
        delays.push(milliseconds)
        return Promise.resolve()
      },
    })

    const models = await openRouter.listImageModels(
      new AbortController().signal,
    )

    expect(models.map((model) => model.id)).toEqual([MODEL_ID])
    expect(transport.requests).toHaveLength(3)
    expect(delays).toEqual([250, 500])
    expect(new Set(transport.requests.map((request) => request.url))).toEqual(
      new Set([`${BASE_URL}images/models`]),
    )
  })

  test("does not retry POST after an ambiguous connection failure", async () => {
    const delays: number[] = []
    const secretPrompt = "private prompt that must not enter the error"
    const transport = new ScriptedTransport(() =>
      Promise.reject(new Error("socket closed before response")),
    )
    const openRouter = client(transport, options(), {
      random: () => 0,
      sleep(milliseconds) {
        delays.push(milliseconds)
        return Promise.resolve()
      },
    })

    const error = await pluginError(
      openRouter.generateImage(
        {
          model: MODEL_ID,
          prompt: secretPrompt,
          input_references: [
            {
              type: "image_url",
              image_url: { url: "data:image/png;base64,cHJpdmF0ZQ==" },
            },
          ],
        },
        new AbortController().signal,
      ),
    )

    expect(error.code).toBe("GENIMAGE_REQUEST_STATUS_UNKNOWN")
    expect(error.suggestion).toContain("OpenRouter activity")
    expect(transport.requests).toHaveLength(1)
    expect(delays).toEqual([])
    expect(JSON.stringify(error.toJSON())).not.toContain(secretPrompt)
    expect(JSON.stringify(error.toJSON())).not.toContain("cHJpdmF0ZQ==")
  })

  test("maps deadline expiry according to direct or proxy routing", async () => {
    for (const [routing, code] of [
      ["direct", "GENIMAGE_TIMEOUT"],
      ["proxy", "GENIMAGE_GATEWAY_TIMEOUT"],
    ] as const) {
      const transport = new ScriptedTransport((request) =>
        waitForAbort(request.signal),
      )
      const openRouter = client(
        transport,
        options(routing, { requestTimeoutMs: 10 }),
      )

      const error = await pluginError(
        openRouter.getCurrentKey(new AbortController().signal),
      )

      expect(error.code).toBe(code)
      expect(transport.requests).toHaveLength(1)
    }
  })

  test("maps a deadline that expires while reading a successful response body", async () => {
    for (const [routing, code] of [
      ["direct", "GENIMAGE_TIMEOUT"],
      ["proxy", "GENIMAGE_GATEWAY_TIMEOUT"],
    ] as const) {
      const transport = new ScriptedTransport((request) =>
        new Response(
          new ReadableStream({
            start(controller) {
              request.signal.addEventListener(
                "abort",
                () => controller.error(request.signal.reason),
                { once: true },
              )
            },
          }),
        ),
      )
      const openRouter = client(
        transport,
        options(routing, { requestTimeoutMs: 10 }),
      )

      const error = await pluginError(
        openRouter.getCurrentKey(new AbortController().signal),
      )

      expect(error.code).toBe(code)
      expect(transport.requests).toHaveLength(1)
    }
  })

  test("does not retry POST when a successful response body is interrupted", async () => {
    const transport = new ScriptedTransport(() =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.error(new Error("response stream interrupted"))
          },
        }),
      ),
    )
    const openRouter = client(transport)

    const error = await pluginError(
      openRouter.generateImage(
        { model: MODEL_ID, prompt: "private prompt" },
        new AbortController().signal,
      ),
    )

    expect(error.code).toBe("GENIMAGE_REQUEST_STATUS_UNKNOWN")
    expect(transport.requests).toHaveLength(1)
    expect(JSON.stringify(error.toJSON())).not.toContain("private prompt")
  })

  test("propagates caller abort without converting it to a provider error", async () => {
    const controller = new AbortController()
    const reason = new DOMException("cancelled by caller", "AbortError")
    const transport = new ScriptedTransport((request) => {
      queueMicrotask(() => controller.abort(reason))
      return waitForAbort(request.signal)
    })
    const openRouter = client(transport)

    const error = await captureError(openRouter.getCurrentKey(controller.signal))

    expect(error).toBe(reason)
    expect(transport.requests).toHaveLength(1)
  })

  test("enforces both declared and streamed response-size limits", async () => {
    const responses = [
      new Response("{}", {
        headers: { "content-length": "128" },
      }),
      new Response("x".repeat(128)),
    ]

    for (const response of responses) {
      const transport = new ScriptedTransport(() => response)
      const openRouter = client(
        transport,
        options("direct", { maxResponseBytes: 32 }),
      )

      const error = await pluginError(
        openRouter.getCurrentKey(new AbortController().signal),
      )

      expect(error.code).toBe("GENIMAGE_RESPONSE_INVALID")
      expect(error.details).toEqual({ maxResponseBytes: 32 })
    }
  })

  test("never exposes an upstream body, API key, prompt, or base64 in safe errors", async () => {
    const upstreamSecret =
      "upstream-body generation-secret private-prompt c2VjcmV0LWltYWdl"
    const records: LogRecord[] = []
    const transport = new ScriptedTransport(() =>
      jsonResponse(
        { error: { message: upstreamSecret, stack: upstreamSecret } },
        {
          status: 400,
          headers: { "x-request-id": "safe-request-id" },
        },
      ),
    )
    const openRouter = client(transport, options(), {}, logger(records))

    const error = await pluginError(
      openRouter.generateImage(
        {
          model: MODEL_ID,
          prompt: "private-prompt",
          input_references: [
            {
              type: "image_url",
              image_url: { url: "data:image/png;base64,c2VjcmV0LWltYWdl" },
            },
          ],
        },
        new AbortController().signal,
      ),
    )

    expect(error.code).toBe("GENIMAGE_BAD_REQUEST")
    expect(error.details?.status).toBe(400)
    expect(error.details?.requestId).toMatch(/^sha256:[a-f0-9]{16}$/u)
    expect(error.details?.requestId).not.toBe("safe-request-id")
    const safeSurface = JSON.stringify({ error: error.toJSON(), records })
    expect(safeSurface).not.toContain(upstreamSecret)
    expect(safeSurface).not.toContain(GENERATION_KEY)
    expect(safeSurface).not.toContain("private-prompt")
    expect(safeSurface).not.toContain("c2VjcmV0LWltYWdl")
  })

  test("uses allowlisted error metadata for transient budgets and retry timing", async () => {
    const secret = "private upstream message"
    const transport = new ScriptedTransport(() =>
      jsonResponse(
        {
          error: {
            code: 402,
            message: secret,
            metadata: {
              error_type: "payment_required",
              reason: "in_flight_budget_exhausted",
              limit_source: "openrouter_in_flight_budget",
              remedy_hint: secret,
            },
          },
        },
        { status: 402, headers: { "retry-after": "7" } },
      ),
    )

    const error = await pluginError(
      client(transport).generateImage(
        { model: MODEL_ID, prompt: "private prompt" },
        new AbortController().signal,
      ),
    )

    expect(error.code).toBe("GENIMAGE_INSUFFICIENT_CREDITS")
    expect(error.message).toContain("in-flight spending budget")
    expect(error.suggestion).toContain("7 second(s)")
    expect(error.details).toEqual({
      status: 402,
      retryAfterMs: 7_000,
      errorType: "payment_required",
      reason: "in_flight_budget_exhausted",
      limitSource: "openrouter_in_flight_budget",
    })
    expect(JSON.stringify(error.toJSON())).not.toContain(secret)
  })

  test("reports budget 403, timeout 408, and rate-limit retry details", async () => {
    const budget = await pluginError(
      client(
        new ScriptedTransport(() =>
          jsonResponse(
            {
              error: {
                metadata: {
                  limit_source: "openrouter_workspace_budget",
                  scope: "workspace",
                  limit_usd: 50,
                  spend_usd: 52,
                  remaining_usd: -2,
                  resets_at: "2026-10-12T00:00:00.000Z",
                },
              },
            },
            { status: 403 },
          ),
        ),
      ).getCurrentKey(new AbortController().signal),
    )
    expect(budget.message).toContain("spending budget")
    expect(budget.suggestion).toContain("2026-10-12")
    expect(budget.details).toMatchObject({
      limitSource: "openrouter_workspace_budget",
      scope: "workspace",
      limitUsd: 50,
      spendUsd: 52,
      remainingUsd: -2,
    })

    const timeout = await pluginError(
      client(new ScriptedTransport(() => jsonResponse({}, { status: 408 })))
        .getCurrentKey(new AbortController().signal),
    )
    expect(timeout.code).toBe("GENIMAGE_TIMEOUT")

    const limited = await pluginError(
      client(
        new ScriptedTransport(() =>
          jsonResponse({}, { status: 429, headers: { "retry-after": "3" } }),
        ),
      ).generateImage(
        { model: MODEL_ID, prompt: "test" },
        new AbortController().signal,
      ),
    )
    expect(limited.code).toBe("GENIMAGE_RATE_LIMITED")
    expect(limited.details?.retryAfterMs).toBe(3_000)
    expect(limited.suggestion).toContain("3 second(s)")
  })

  test("maps typed image failures and falls back safely for malformed error bodies", async () => {
    const cases = [
      ["invalid_image", "GENIMAGE_REFERENCE_INVALID"],
      ["image_too_large", "GENIMAGE_REFERENCE_TOO_LARGE"],
      ["unsupported_image_format", "GENIMAGE_REFERENCE_FORMAT_UNSUPPORTED"],
      ["image_not_found", "GENIMAGE_REFERENCE_NOT_FOUND"],
      ["image_download_failed", "GENIMAGE_REFERENCE_URL_INVALID"],
    ] as const
    for (const [errorType, code] of cases) {
      const error = await pluginError(
        client(
          new ScriptedTransport(() =>
            jsonResponse(
              { error: { metadata: { error_type: errorType } } },
              { status: 400 },
            ),
          ),
        ).generateImage(
          { model: MODEL_ID, prompt: "test" },
          new AbortController().signal,
        ),
      )
      expect(error.code).toBe(code)
      expect(error.details?.errorType).toBe(errorType)
    }

    for (const body of ["not json", "x".repeat(128)]) {
      const error = await pluginError(
        client(
          new ScriptedTransport(() => new Response(body, { status: 400 })),
          options("direct", { maxResponseBytes: 32 }),
        ).getCurrentKey(new AbortController().signal),
      )
      expect(error.code).toBe("GENIMAGE_BAD_REQUEST")
      expect(error.details).toEqual({ status: 400 })
    }
  })

  test("drops an upstream request ID that reflects a configured secret", async () => {
    const transport = new ScriptedTransport(() =>
      jsonResponse(
        { error: { message: "denied" } },
        {
          status: 401,
          headers: { "x-request-id": GENERATION_KEY },
        },
      ),
    )
    const openRouter = client(transport)

    const error = await pluginError(
      openRouter.getCurrentKey(new AbortController().signal),
    )

    expect(error.code).toBe("GENIMAGE_OPENROUTER_AUTH")
    expect(error.details).toEqual({ status: 401 })
    expect(JSON.stringify(error.toJSON())).not.toContain(GENERATION_KEY)
  })

  test("sanitizes a credential rejected while constructing HTTP headers", async () => {
    const secret = "management-secret\r\nX-Evil: injected"
    const transport = new ScriptedTransport(() => {
      throw new Error("transport must not be called")
    })

    const error = await pluginError(
      client(transport).getCredits(secret, new AbortController().signal),
    )

    expect(error.code).toBe("GENIMAGE_CONFIG_INVALID")
    expect(error.cause).toBeUndefined()
    expect(JSON.stringify(error.toJSON())).not.toContain(secret)
    expect(transport.requests).toHaveLength(0)
  })

  test("maps account-credit authorization failures without exposing the management key", async () => {
    for (const [status, code] of [
      [401, "GENIMAGE_OPENROUTER_AUTH"],
      [403, "GENIMAGE_OPENROUTER_FORBIDDEN"],
    ] as const) {
      const transport = new ScriptedTransport(() =>
        jsonResponse({ error: { message: MANAGEMENT_KEY } }, { status }),
      )
      const error = await pluginError(
        client(transport).getCredits(
          MANAGEMENT_KEY,
          new AbortController().signal,
        ),
      )

      expect(error.code).toBe(code)
      expect(JSON.stringify(error.toJSON())).not.toContain(MANAGEMENT_KEY)
    }
  })

  test("allows only same-origin model endpoint capability paths", async () => {
    const transport = new ScriptedTransport(() =>
      jsonResponse({ id: MODEL_ID, endpoints: [] }),
    )
    const openRouter = client(transport)
    const signal = new AbortController().signal

    await openRouter.listImageModelEndpoints(
      `${BASE_URL}images/models/vendor%2Fimage-model/endpoints`,
      signal,
    )
    expect(transport.requests).toHaveLength(1)

    const unsafePaths = [
      "https://attacker.test/api/v1/images/models/vendor/endpoints",
      "//attacker.test/api/v1/images/models/vendor/endpoints",
      "/api/v1/images/models/vendor/endpoints?token=leak",
      "/api/v1/images/models/vendor/not-endpoints",
      "/api/v1/key",
      "https://user:pass@openrouter.test/api/v1/images/models/vendor/endpoints",
    ]
    for (const path of unsafePaths) {
      const error = await pluginError(
        openRouter.listImageModelEndpoints(path, signal),
      )
      expect(error.code).toBe("GENIMAGE_RESPONSE_INVALID")
    }

    expect(transport.requests).toHaveLength(1)
  })
})
