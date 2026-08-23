import {
  createKoteGatewayClient,
  KoteGatewayError,
  type GatewayDescriptor,
  type KoteGatewayClient,
} from "@koteye/kote-gateway-opencode/core"
import {
  fetch as undiciFetch,
  ProxyAgent,
} from "undici"
import { createHash } from "node:crypto"

import { safeUrlOrigin, type SafeLogger } from "../logging.js"
import {
  abortablePromise,
  createLinkedAbortSignal,
  isAbortError,
  throwIfAborted,
} from "../utils/abort.js"
import { nativeFetch, type FetchLike } from "./direct.js"
import {
  GatewayTransportError,
  type GatewayErrorCode,
  type HttpTransport,
} from "./types.js"

type GatewayClientFactory = () => Promise<KoteGatewayClient>
const MAX_CACHED_DISPATCHERS = 8

export interface KoteGatewayTransportOptions {
  logger: SafeLogger
  gatewayClientFactory?: GatewayClientFactory
  bunFetch?: FetchLike
  forceRuntime?: "bun" | "node"
}

type BunProxyInit = RequestInit & {
  proxy:
    | string
    | {
        url: string
        headers?: Record<string, string>
      }
}

function defaultGatewayClientFactory(
  disposeSignal: AbortSignal,
): Promise<KoteGatewayClient> {
  const fetchUntilDisposed: FetchLike = async (input, init = {}) => {
    const signals = [disposeSignal]
    if (init.signal !== undefined && init.signal !== null) {
      signals.push(init.signal)
    }
    const linked = createLinkedAbortSignal(signals)
    try {
      return await nativeFetch(input, { ...init, signal: linked.signal })
    } finally {
      linked.dispose()
    }
  }
  return createKoteGatewayClient({
    fetch: fetchUntilDisposed,
    config: {
      version: 1,
      default: "proxy",
      strict: true,
      providers: { openrouter: "proxy" },
    },
  })
}

function mapGatewayError(error: unknown): GatewayTransportError {
  if (error instanceof GatewayTransportError) return error

  let code: GatewayErrorCode = "GENIMAGE_GATEWAY_CONNECT_FAILED"
  if (error instanceof KoteGatewayError) {
    switch (error.code) {
      case "KOTE_BOOTSTRAP_SIGNATURE_INVALID":
        code = "GENIMAGE_GATEWAY_SIGNATURE_INVALID"
        break
      case "KOTE_BOOTSTRAP_EXPIRED":
        code = "GENIMAGE_GATEWAY_CACHE_EXPIRED"
        break
      case "KOTE_BOOTSTRAP_UNAVAILABLE":
      case "KOTE_BOOTSTRAP_INVALID":
      case "KOTE_CONFIG_INVALID":
      case "KOTE_CONFIG_NOT_FOUND":
        code = "GENIMAGE_GATEWAY_BOOTSTRAP_FAILED"
        break
      case "KOTE_GATEWAY_UNAVAILABLE":
      case "KOTE_PROXY_REQUEST_FAILED":
      case "KOTE_UNSUPPORTED_TRANSPORT":
      default:
        code = "GENIMAGE_GATEWAY_CONNECT_FAILED"
    }
  }

  return new GatewayTransportError(
    code,
    "KoteGateway could not complete the proxied OpenRouter request. Direct fallback is disabled.",
  )
}

function validateDescriptor(descriptor: GatewayDescriptor): GatewayDescriptor {
  let url: URL
  try {
    url = new URL(descriptor.proxyUrl)
  } catch (error) {
    throw new GatewayTransportError(
      "GENIMAGE_GATEWAY_BOOTSTRAP_FAILED",
      "KoteGateway returned an invalid proxy descriptor.",
      { cause: error },
    )
  }

  if (
    (url.protocol !== "https:" && url.protocol !== "http:") ||
    url.username !== "" ||
    url.password !== "" ||
    descriptor.proxyUrl.length > 4_096
  ) {
    throw new GatewayTransportError(
      "GENIMAGE_GATEWAY_BOOTSTRAP_FAILED",
      "KoteGateway returned an unsafe proxy descriptor.",
    )
  }

  const proxyHeaders = descriptor.proxyHeaders as unknown
  if (
    proxyHeaders !== undefined &&
    (typeof proxyHeaders !== "object" ||
      proxyHeaders === null ||
      Array.isArray(proxyHeaders))
  ) {
    throw new GatewayTransportError(
      "GENIMAGE_GATEWAY_BOOTSTRAP_FAILED",
      "KoteGateway returned invalid proxy headers.",
    )
  }
  for (const [name, value] of Object.entries(proxyHeaders ?? {})) {
    if (
      !/^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,256}$/u.test(name) ||
      typeof value !== "string" ||
      value.length > 4_096 ||
      /[\u0000-\u001f\u007f]/u.test(value)
    ) {
      throw new GatewayTransportError(
        "GENIMAGE_GATEWAY_BOOTSTRAP_FAILED",
        "KoteGateway returned invalid proxy headers.",
      )
    }
  }

  return descriptor
}

function splitProxyHeaders(headers: Readonly<Record<string, string>> | undefined): {
  headers?: Record<string, string>
  token?: string
} {
  if (headers === undefined) return {}

  let token: string | undefined
  const remaining: Record<string, string> = {}
  for (const [name, value] of Object.entries(headers)) {
    if (name.toLowerCase() === "proxy-authorization") token = value
    else remaining[name] = value
  }

  return {
    ...(Object.keys(remaining).length === 0 ? {} : { headers: remaining }),
    ...(token === undefined ? {} : { token }),
  }
}

function descriptorKey(descriptor: GatewayDescriptor): string {
  const headers = Object.entries(descriptor.proxyHeaders ?? {}).sort(([left], [right]) =>
    left.localeCompare(right),
  )
  return createHash("sha256")
    .update(JSON.stringify([descriptor.proxyUrl, headers]))
    .digest("hex")
}

export class KoteGatewayTransport implements HttpTransport {
  readonly #logger: SafeLogger
  readonly #gatewayClientFactory: GatewayClientFactory
  readonly #bunFetch: FetchLike
  readonly #runtime: "bun" | "node"
  readonly #dispatchers = new Map<string, ProxyAgent>()
  readonly #disposeController = new AbortController()
  #clientPromise: Promise<KoteGatewayClient> | undefined
  #disposed = false

  constructor(options: KoteGatewayTransportOptions) {
    this.#logger = options.logger
    this.#gatewayClientFactory =
      options.gatewayClientFactory ??
      (() => defaultGatewayClientFactory(this.#disposeController.signal))
    this.#bunFetch = options.bunFetch ?? nativeFetch
    this.#runtime =
      options.forceRuntime ??
      (typeof process.versions.bun === "string" ? "bun" : "node")
  }

  async request(url: URL, init: RequestInit, signal: AbortSignal): Promise<Response> {
    if (this.#disposed) {
      throw new GatewayTransportError(
        "GENIMAGE_GATEWAY_CONNECT_FAILED",
        "KoteGateway transport is already disposed.",
      )
    }

    const linked = createLinkedAbortSignal([
      signal,
      this.#disposeController.signal,
    ])
    const requestSignal = linked.signal
    try {
      const client = await abortablePromise(this.#getClient(), requestSignal)
      const descriptor = validateDescriptor(
        await abortablePromise(client.getGateway(), requestSignal),
      )
      throwIfAborted(requestSignal)
      const gatewayOrigin = safeUrlOrigin(descriptor.proxyUrl)
      this.#logger.log("debug", "Routing OpenRouter request through KoteGateway.", {
        routing: "proxy",
        ...(gatewayOrigin === undefined ? {} : { gatewayOrigin }),
      })

      if (this.#runtime === "bun") {
        const proxy =
          descriptor.proxyHeaders === undefined
            ? descriptor.proxyUrl
            : {
                url: descriptor.proxyUrl,
                headers: { ...descriptor.proxyHeaders },
              }
        return await this.#bunFetch(url, {
          ...init,
          signal: requestSignal,
          proxy,
        } as BunProxyInit)
      }

      const dispatcher = this.#getDispatcher(descriptor)
      return (await undiciFetch(url, {
        ...init,
        signal: requestSignal,
        dispatcher,
      } as Parameters<typeof undiciFetch>[1])) as unknown as Response
    } catch (error) {
      if (requestSignal.aborted || isAbortError(error)) throw error
      this.#clientPromise?.then((client) => client.invalidateGateway()).catch(() => {})
      throw mapGatewayError(error)
    } finally {
      linked.dispose()
    }
  }

  async dispose(): Promise<void> {
    this.#disposed = true
    this.#disposeController.abort(
      new DOMException("KoteGateway transport was disposed", "AbortError"),
    )
    this.#clientPromise = undefined
    const dispatchers = [...this.#dispatchers.values()]
    this.#dispatchers.clear()
    await Promise.all(dispatchers.map(async (dispatcher) => dispatcher.close().catch(() => {})))
  }

  #getClient(): Promise<KoteGatewayClient> {
    if (this.#clientPromise !== undefined) return this.#clientPromise

    const created = Promise.resolve().then(() => this.#gatewayClientFactory())
    const guarded = created.catch((error: unknown) => {
      if (this.#clientPromise === guarded) this.#clientPromise = undefined
      throw error
    })
    this.#clientPromise = guarded
    return this.#clientPromise
  }

  #getDispatcher(descriptor: GatewayDescriptor): ProxyAgent {
    const key = descriptorKey(descriptor)
    const existing = this.#dispatchers.get(key)
    if (existing !== undefined) {
      this.#dispatchers.delete(key)
      this.#dispatchers.set(key, existing)
      return existing
    }

    if (this.#dispatchers.size >= MAX_CACHED_DISPATCHERS) {
      const oldest = this.#dispatchers.entries().next()
      if (!oldest.done) {
        this.#dispatchers.delete(oldest.value[0])
        void oldest.value[1].close().catch(() => undefined)
      }
    }

    const proxyHeaders = splitProxyHeaders(descriptor.proxyHeaders)
    const dispatcher = new ProxyAgent({
      uri: descriptor.proxyUrl,
      ...proxyHeaders,
    })
    this.#dispatchers.set(key, dispatcher)
    return dispatcher
  }
}
