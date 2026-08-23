import { describe, expect, test } from "bun:test"
import {
  KoteBootstrapSignatureInvalidError,
  type GatewayDescriptor,
  type KoteGatewayClient,
} from "@koteye/kote-gateway-opencode/core"

import {
  noopLogger,
  type SafeLogFields,
  type SafeLogger,
} from "../../src/logging.js"
import {
  DirectTransport,
  type FetchLike,
} from "../../src/transport/direct.js"
import { KoteGatewayTransport } from "../../src/transport/kote-gateway.js"
import { GatewayTransportError } from "../../src/transport/types.js"

interface TargetCall {
  readonly init: RequestInit & { proxy?: unknown }
  readonly url: string
}

interface LogRecord {
  readonly fields?: SafeLogFields
  readonly message: string
}

function inputUrl(input: string | URL | Request): string {
  if (typeof input === "string") return input
  if (input instanceof URL) return input.toString()
  return input.url
}

function asBunFetch(implementation: FetchLike): typeof globalThis.fetch {
  return implementation as unknown as typeof globalThis.fetch
}

function targetCallAt(calls: readonly TargetCall[], index: number): TargetCall {
  const call = calls.at(index)
  if (call === undefined) throw new Error(`Missing target call ${index}`)
  return call
}

function fakeGatewayClient(
  getGateway: (...arguments_: unknown[]) => Promise<GatewayDescriptor>,
  invalidateGateway: () => void = () => undefined,
): KoteGatewayClient {
  return {
    status: "ready",
    config: {
      version: 1,
      default: "proxy",
      strict: true,
      providers: { openrouter: "proxy" },
      auxiliaryOrigins: {},
    },
    configPath: "test-kote-gateway.json",
    resolveRoute(providerID) {
      void providerID
      return "proxy"
    },
    resolveProviderByOrigin(origin) {
      void origin
      return undefined
    },
    getGateway,
    invalidateGateway,
  }
}

function captureLogger(records: LogRecord[]): SafeLogger {
  return {
    log(_level, message, fields) {
      records.push({
        message,
        ...(fields === undefined ? {} : { fields }),
      })
    },
  }
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

async function gatewayError(
  promise: Promise<unknown>,
): Promise<GatewayTransportError> {
  const error = await captureError(promise)
  expect(error).toBeInstanceOf(GatewayTransportError)
  if (!(error instanceof GatewayTransportError)) {
    throw new Error("Expected GatewayTransportError")
  }
  return error
}

describe("HTTP transports", () => {
  test("default direct transport bypasses a plugin-installed global fetch wrapper", async () => {
    const originalFetch = globalThis.fetch
    let wrapperCalls = 0
    const wrapper = asBunFetch(() => {
      wrapperCalls += 1
      return Promise.reject(new Error("global wrapper must not be used"))
    })
    globalThis.fetch = wrapper
    try {
      const response = await new DirectTransport().request(
        new URL("data:text/plain,native"),
        { method: "GET" },
        new AbortController().signal,
      )
      expect(await response.text()).toBe("native")
      expect(wrapperCalls).toBe(0)
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test("direct transport calls only its injected fetch and leaves globals untouched", async () => {
    const originalFetch = globalThis.fetch
    const calls: TargetCall[] = []
    const fakeFetch: FetchLike = (input, init = {}) => {
      calls.push({
        url: inputUrl(input),
        init: init as RequestInit & { proxy?: unknown },
      })
      return Promise.resolve(new Response("direct"))
    }
    const transport = new DirectTransport(fakeFetch)
    const signal = new AbortController().signal
    const headers = new Headers({ Authorization: "Bearer target-secret" })

    const response = await transport.request(
      new URL("https://openrouter.test/api/v1/images"),
      { method: "POST", headers, body: "encrypted-target-body" },
      signal,
    )

    expect(await response.text()).toBe("direct")
    expect(calls).toHaveLength(1)
    const call = targetCallAt(calls, 0)
    expect(call.url).toBe("https://openrouter.test/api/v1/images")
    expect(call.init.method).toBe("POST")
    expect(call.init.body).toBe("encrypted-target-body")
    expect(call.init.signal).toBe(signal)
    expect(call.init.proxy).toBeUndefined()
    expect(globalThis.fetch).toBe(originalFetch)
  })

  test("proxy client creation is lazy and reused without a global interceptor", async () => {
    const originalFetch = globalThis.fetch
    let factoryCalls = 0
    let descriptorCalls = 0
    const targetCalls: TargetCall[] = []
    const gatewayClient = fakeGatewayClient(() => {
      descriptorCalls += 1
      return Promise.resolve({ proxyUrl: "https://gateway.test:8443" })
    })
    const bunFetch = asBunFetch((input, init = {}) => {
      targetCalls.push({
        url: inputUrl(input),
        init: init as RequestInit & { proxy?: unknown },
      })
      return Promise.resolve(new Response("proxied"))
    })
    const transport = new KoteGatewayTransport({
      logger: noopLogger,
      gatewayClientFactory() {
        factoryCalls += 1
        return Promise.resolve(gatewayClient)
      },
      bunFetch,
      forceRuntime: "bun",
    })

    expect(factoryCalls).toBe(0)
    expect(descriptorCalls).toBe(0)
    expect(targetCalls).toHaveLength(0)

    const signal = new AbortController().signal
    await transport.request(
      new URL("https://openrouter.test/api/v1/images/models"),
      { method: "GET" },
      signal,
    )
    await transport.request(
      new URL("https://openrouter.test/api/v1/key"),
      { method: "GET" },
      signal,
    )

    expect(factoryCalls).toBe(1)
    expect(descriptorCalls).toBe(2)
    expect(targetCalls).toHaveLength(2)
    expect(globalThis.fetch).toBe(originalFetch)
  })

  test("proxy mode is fail-closed when bootstrap cannot create a client", async () => {
    let proxyFetchCalls = 0
    const bunFetch = asBunFetch(() => {
      proxyFetchCalls += 1
      return Promise.resolve(new Response("must not be called"))
    })
    const transport = new KoteGatewayTransport({
      logger: noopLogger,
      gatewayClientFactory: () =>
        Promise.reject(new Error("bootstrap service unavailable")),
      bunFetch,
      forceRuntime: "bun",
    })

    const error = await gatewayError(
      transport.request(
        new URL("https://openrouter.test/api/v1/images"),
        { method: "POST", body: "private prompt" },
        new AbortController().signal,
      ),
    )

    expect(error.code).toBe("GENIMAGE_GATEWAY_CONNECT_FAILED")
    expect(error.message).toContain("Direct fallback is disabled")
    expect(proxyFetchCalls).toBe(0)
  })

  test("caller abort stops waiting for a gateway descriptor", async () => {
    const controller = new AbortController()
    const reason = new DOMException("cancelled", "AbortError")
    let proxyFetchCalls = 0
    const gatewayClient = fakeGatewayClient(
      () => new Promise<GatewayDescriptor>(() => undefined),
    )
    const transport = new KoteGatewayTransport({
      logger: noopLogger,
      gatewayClientFactory: () => Promise.resolve(gatewayClient),
      bunFetch: asBunFetch(() => {
        proxyFetchCalls += 1
        return Promise.resolve(new Response("must not be called"))
      }),
      forceRuntime: "bun",
    })

    const pending = transport.request(
      new URL("https://openrouter.test/api/v1/images"),
      { method: "POST" },
      controller.signal,
    )
    queueMicrotask(() => controller.abort(reason))

    expect(await captureError(pending)).toBe(reason)
    expect(proxyFetchCalls).toBe(0)
  })

  test("dispose aborts a request waiting for a descriptor before proxy I/O", async () => {
    let resolveDescriptor: ((descriptor: GatewayDescriptor) => void) | undefined
    const descriptorStarted = Promise.withResolvers<undefined>()
    let proxyFetchCalls = 0
    const gatewayClient = fakeGatewayClient(
      () =>
        new Promise<GatewayDescriptor>((resolve) => {
          resolveDescriptor = resolve
          descriptorStarted.resolve(undefined)
        }),
    )
    const transport = new KoteGatewayTransport({
      logger: noopLogger,
      gatewayClientFactory: () => Promise.resolve(gatewayClient),
      bunFetch: asBunFetch(() => {
        proxyFetchCalls += 1
        return Promise.resolve(new Response("must not be called"))
      }),
      forceRuntime: "bun",
    })

    const observed = captureError(
      transport.request(
        new URL("https://openrouter.test/api/v1/images"),
        { method: "POST" },
        new AbortController().signal,
      ),
    )
    await descriptorStarted.promise
    await transport.dispose()
    if (resolveDescriptor === undefined) throw new Error("Descriptor did not start")
    resolveDescriptor({ proxyUrl: "https://gateway.test" })

    const error = await observed
    expect(error).toBeInstanceOf(DOMException)
    expect((error as DOMException).name).toBe("AbortError")
    expect(proxyFetchCalls).toBe(0)
  })

  test("maps gateway verification failures and never retries directly", async () => {
    let invalidations = 0
    let proxyFetchCalls = 0
    const gatewayClient = fakeGatewayClient(
      () =>
        Promise.reject(
          new KoteBootstrapSignatureInvalidError({
            message: "signature failed",
          }),
        ),
      () => {
        invalidations += 1
      },
    )
    const transport = new KoteGatewayTransport({
      logger: noopLogger,
      gatewayClientFactory: () => Promise.resolve(gatewayClient),
      bunFetch: asBunFetch(() => {
        proxyFetchCalls += 1
        return Promise.resolve(new Response("must not be called"))
      }),
      forceRuntime: "bun",
    })

    const error = await gatewayError(
      transport.request(
        new URL("https://openrouter.test/api/v1/images"),
        { method: "POST" },
        new AbortController().signal,
      ),
    )
    await Promise.resolve()

    expect(error.code).toBe("GENIMAGE_GATEWAY_SIGNATURE_INVALID")
    expect(proxyFetchCalls).toBe(0)
    expect(invalidations).toBe(1)
  })

  test("rejects malformed, non-HTTP, and credential-bearing descriptors", async () => {
    const descriptors: GatewayDescriptor[] = [
      { proxyUrl: "not a URL" },
      { proxyUrl: "ftp://gateway.test" },
      { proxyUrl: "https://user:password@gateway.test" },
      {
        proxyUrl: "https://gateway.test",
        proxyHeaders: { "Proxy-Authorization": "secret\r\nX-Evil: injected" },
      },
    ]

    for (const descriptor of descriptors) {
      let proxyFetchCalls = 0
      const transport = new KoteGatewayTransport({
        logger: noopLogger,
        gatewayClientFactory: () =>
          Promise.resolve(
            fakeGatewayClient(() => Promise.resolve(descriptor)),
          ),
        bunFetch: asBunFetch(() => {
          proxyFetchCalls += 1
          return Promise.resolve(new Response("must not be called"))
        }),
        forceRuntime: "bun",
      })

      const error = await gatewayError(
        transport.request(
          new URL("https://openrouter.test/api/v1/key"),
          { method: "GET" },
          new AbortController().signal,
        ),
      )

      expect(error.code).toBe("GENIMAGE_GATEWAY_BOOTSTRAP_FAILED")
      expect(proxyFetchCalls).toBe(0)
    }
  })

  test("keeps proxy descriptor headers separate from target headers and payload", async () => {
    const gatewayArguments: unknown[][] = []
    const targetCalls: TargetCall[] = []
    const records: LogRecord[] = []
    const descriptor: GatewayDescriptor = {
      proxyUrl: "https://gateway.test:8443/connect",
      proxyHeaders: {
        "Proxy-Authorization": "Basic gateway-secret",
        "X-Gateway-Token": "gateway-token",
      },
    }
    const gatewayClient = fakeGatewayClient((...arguments_) => {
      gatewayArguments.push(arguments_)
      return Promise.resolve(descriptor)
    })
    const bunFetch = asBunFetch((input, init = {}) => {
      targetCalls.push({
        url: inputUrl(input),
        init: init as RequestInit & { proxy?: unknown },
      })
      return Promise.resolve(new Response("ok"))
    })
    const transport = new KoteGatewayTransport({
      logger: captureLogger(records),
      gatewayClientFactory: () => Promise.resolve(gatewayClient),
      bunFetch,
      forceRuntime: "bun",
    })
    const targetHeaders = new Headers({
      Authorization: "Bearer openrouter-secret",
      "Content-Type": "application/json",
    })
    const targetBody = JSON.stringify({
      prompt: "private prompt",
      input_references: [
        {
          type: "image_url",
          image_url: { url: "data:image/png;base64,cHJpdmF0ZS1pbWFnZQ==" },
        },
      ],
    })

    await transport.request(
      new URL("https://openrouter.test/api/v1/images?internal=true"),
      { method: "POST", headers: targetHeaders, body: targetBody },
      new AbortController().signal,
    )

    expect(gatewayArguments).toEqual([[]])
    expect(targetCalls).toHaveLength(1)
    const targetCall = targetCallAt(targetCalls, 0)
    expect(targetCall.url).toBe(
      "https://openrouter.test/api/v1/images?internal=true",
    )
    expect(targetCall.init.proxy).toEqual({
      url: descriptor.proxyUrl,
      headers: descriptor.proxyHeaders,
    })
    const forwardedTargetHeaders = new Headers(targetCall.init.headers)
    expect(forwardedTargetHeaders.get("authorization")).toBe(
      "Bearer openrouter-secret",
    )
    expect(forwardedTargetHeaders.get("proxy-authorization")).toBeNull()
    expect(forwardedTargetHeaders.get("x-gateway-token")).toBeNull()
    expect(targetCall.init.body).toBe(targetBody)

    const logSurface = JSON.stringify(records)
    expect(logSurface).toContain("https://gateway.test:8443")
    expect(logSurface).not.toContain("/connect")
    expect(logSurface).not.toContain("openrouter.test")
    expect(logSurface).not.toContain("openrouter-secret")
    expect(logSurface).not.toContain("private prompt")
    expect(logSurface).not.toContain("cHJpdmF0ZS1pbWFnZQ==")
  })
})
