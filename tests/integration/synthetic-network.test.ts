import { describe, expect, test } from "bun:test"
import gatewayPlugin from "@koteye/kote-gateway-opencode"
import {
  createKoteGatewayClient,
  signBootstrapConfig,
  type BootstrapConfig,
} from "@koteye/kote-gateway-opencode/core"
import type { Hooks, PluginInput } from "@opencode-ai/plugin"
import { once } from "node:events"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { createServer as createHttpsServer } from "node:https"
import { connect, type Socket } from "node:net"
import { tmpdir } from "node:os"
import path from "node:path"
import {
  createServer as createTlsServer,
  type TLSSocket,
} from "node:tls"
import { fileURLToPath } from "node:url"

import { resolvePluginOptions } from "../../src/config/resolve.js"
import type {
  ResolvedPluginOptions,
  RoutingMode,
} from "../../src/config/types.js"
import { noopLogger } from "../../src/logging.js"
import {
  createOpenRouterClient,
  type DefaultOpenRouterImageClient,
} from "../../src/openrouter/client.js"
import { PluginError } from "../../src/openrouter/errors.js"
import type { OpenRouterImageRequest } from "../../src/openrouter/schemas.js"
import { server as imagePlugin } from "../../src/server.js"
import {
  DirectTransport,
  type FetchLike,
} from "../../src/transport/direct.js"
import { KoteGatewayTransport } from "../../src/transport/kote-gateway.js"

const HOST = "127.0.0.1"
const MODEL = "synthetic/image-model"
const API_KEY = "sk-or-synthetic-target-secret"
const PROMPT = "private synthetic prompt that only the TLS target may read"
const FIRST_REFERENCE =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB"
const SECOND_REFERENCE =
  "data:image/webp;base64,UklGRhIAAABXRUJQVlA4TAUAAAAvAAAAAA=="
const HTTPS_REFERENCE =
  "https://assets.example.test/reference.png?signature=unchanged"
const FIXED_NOW = new Date("2030-01-02T03:04:05.000Z")

// RFC 8032 test vector #1. These keys sign test-only bootstrap documents.
const BOOTSTRAP_PRIVATE_KEY =
  "9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60"
const BOOTSTRAP_PUBLIC_KEY =
  "d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a"

const fixtureDirectory = fileURLToPath(new URL("../fixtures/", import.meta.url))
const [certificate, privateKey] = await Promise.all([
  readFile(path.join(fixtureDirectory, "loopback-cert.pem"), "utf8"),
  readFile(path.join(fixtureDirectory, "loopback-key.pem"), "utf8"),
])

interface CapturedTargetRequest {
  readonly body: string
  readonly headers: Readonly<Record<string, string | string[] | undefined>>
  readonly method: string
  readonly path: string
}

interface StartedServer {
  readonly port: number
  stop(): Promise<void>
}

interface TargetServer extends StartedServer {
  readonly requests: CapturedTargetRequest[]
}

type ProxyBehavior = "refuse" | "tunnel"

interface ConnectProxy extends StartedServer {
  readonly connectRequests: string[]
}

interface BootstrapServer extends StartedServer {
  readonly requestCount: () => number
}

interface HarnessOptions {
  readonly bootstrapState?: "expired" | "invalid-signature" | "valid"
  readonly proxyBehavior?: ProxyBehavior
}

interface NetworkHarness {
  readonly baseUrl: string
  readonly bootstrap: BootstrapServer
  readonly proxy: ConnectProxy
  readonly target: TargetServer
  createProxyTransport(): Promise<KoteGatewayTransport>
  stop(): Promise<void>
}

function portOf(server: { address(): string | { port: number } | null }): number {
  const address = server.address()
  if (address === null || typeof address === "string") {
    throw new Error("Synthetic server did not bind a TCP port")
  }
  return address.port
}

function closeServer(
  server: { close(callback: () => void): unknown; listening: boolean },
  sockets: ReadonlySet<Socket>,
): Promise<void> {
  for (const socket of sockets) socket.destroy()
  if (!server.listening) return Promise.resolve()
  return new Promise((resolve) => {
    server.close(resolve)
  })
}

function trackSocket(sockets: Set<Socket>, socket: Socket): void {
  sockets.add(socket)
  socket.once("close", () => sockets.delete(socket))
  socket.on("error", () => undefined)
}

async function startTargetServer(): Promise<TargetServer> {
  const requests: CapturedTargetRequest[] = []
  const sockets = new Set<Socket>()
  const server = createHttpsServer({ cert: certificate, key: privateKey }, (request, response) => {
    const chunks: Buffer[] = []
    let total = 0
    request.on("data", (chunk: Buffer) => {
      total += chunk.byteLength
      if (total > 1024 * 1024) {
        request.destroy(new Error("Synthetic request exceeded 1 MiB"))
        return
      }
      chunks.push(chunk)
    })
    request.once("end", () => {
      requests.push({
        body: Buffer.concat(chunks, total).toString("utf8"),
        headers: { ...request.headers },
        method: request.method ?? "",
        path: request.url ?? "",
      })
      const body = JSON.stringify({
        data: [
          {
            b64_json: Buffer.from("synthetic-result").toString("base64"),
            media_type: "image/png",
          },
        ],
      })
      response.writeHead(200, {
        "connection": "close",
        "content-length": Buffer.byteLength(body),
        "content-type": "application/json",
      })
      response.end(body)
    })
  })
  server.on("connection", (socket) => trackSocket(sockets, socket))
  server.listen(0, HOST)
  await once(server, "listening")

  return {
    port: portOf(server),
    requests,
    stop: () => closeServer(server, sockets),
  }
}

function parseConnectAuthority(header: string): { host: string; port: number } {
  const firstLine = header.slice(0, header.indexOf("\r\n"))
  const match = /^CONNECT ([^ ]+) HTTP\/1\.[01]$/u.exec(firstLine)
  if (match?.[1] === undefined) {
    throw new Error("Synthetic proxy expected an HTTP CONNECT request")
  }
  const separator = match[1].lastIndexOf(":")
  const host = match[1].slice(0, separator)
  const port = Number(match[1].slice(separator + 1))
  if (separator <= 0 || !Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new Error("Synthetic proxy received an invalid CONNECT authority")
  }
  return { host, port }
}

async function startConnectProxy(
  targetPort: number,
  behavior: ProxyBehavior,
): Promise<ConnectProxy> {
  const connectRequests: string[] = []
  const sockets = new Set<Socket>()
  const upstreamSockets = new Set<Socket>()
  const server = createTlsServer(
    { cert: certificate, key: privateKey },
    (client: TLSSocket) => {
      trackSocket(sockets, client)
      let pending = Buffer.alloc(0)

      const receiveConnect = (chunk: Buffer): void => {
        pending = Buffer.concat([pending, chunk])
        if (pending.byteLength > 64 * 1024) {
          client.end("HTTP/1.1 431 Request Header Fields Too Large\r\n\r\n")
          return
        }
        const boundary = pending.indexOf("\r\n\r\n")
        if (boundary < 0) return

        client.off("data", receiveConnect)
        const connectHeader = pending.subarray(0, boundary + 4).toString("latin1")
        const tunnelHead = pending.subarray(boundary + 4)
        connectRequests.push(connectHeader)

        if (behavior === "refuse") {
          // A reset models a refused CONNECT without turning the proxy's HTTP
          // status into an indistinguishable synthetic target response in Bun.
          client.destroy()
          return
        }

        let authority: { host: string; port: number }
        try {
          authority = parseConnectAuthority(connectHeader)
        } catch {
          client.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n")
          return
        }
        if (authority.host !== HOST || authority.port !== targetPort) {
          client.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n")
          return
        }

        const upstream = connect({ host: HOST, port: targetPort })
        trackSocket(upstreamSockets, upstream)
        upstream.once("connect", () => {
          client.write("HTTP/1.1 200 Connection Established\r\n\r\n")
          if (tunnelHead.byteLength > 0) upstream.write(tunnelHead)
          client.pipe(upstream)
          upstream.pipe(client)
        })
        upstream.once("error", () => {
          if (!client.destroyed) {
            client.end(
              "HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\nContent-Length: 0\r\n\r\n",
            )
          }
        })
      }

      client.on("data", receiveConnect)
    },
  )
  server.listen(0, HOST)
  await once(server, "listening")

  return {
    port: portOf(server),
    connectRequests,
    async stop() {
      await closeServer(server, sockets)
      for (const socket of upstreamSockets) socket.destroy()
    },
  }
}

async function startBootstrapServer(
  document: BootstrapConfig,
): Promise<BootstrapServer> {
  let requests = 0
  const sockets = new Set<Socket>()
  const server = createHttpsServer({ cert: certificate, key: privateKey }, (request, response) => {
    requests += 1
    const body = JSON.stringify(document)
    response.writeHead(request.url === "/bootstrap.json" ? 200 : 404, {
      "connection": "close",
      "content-length": Buffer.byteLength(body),
      "content-type": "application/json",
    })
    response.end(body)
  })
  server.on("connection", (socket) => trackSocket(sockets, socket))
  server.listen(0, HOST)
  await once(server, "listening")

  return {
    port: portOf(server),
    requestCount: () => requests,
    stop: () => closeServer(server, sockets),
  }
}

const trustedLoopbackFetch: FetchLike = (input, init = {}) =>
  Bun.fetch(input, {
    ...init,
    protocol: "http1.1",
    tls: {
      ca: certificate,
      rejectUnauthorized: true,
    },
  } as BunFetchRequestInit)

async function signedBootstrap(
  proxyUrl: string,
  state: NonNullable<HarnessOptions["bootstrapState"]>,
): Promise<BootstrapConfig> {
  const expired = state === "expired"
  const signed = await signBootstrapConfig(
    {
      config_version: 1,
      proxy: { url: proxyUrl },
      issued_at: expired
        ? "2029-12-01T00:00:00.000Z"
        : "2030-01-02T03:00:00.000Z",
      expires_at: expired
        ? "2029-12-02T00:00:00.000Z"
        : "2030-01-02T04:00:00.000Z",
    },
    BOOTSTRAP_PRIVATE_KEY,
  )
  if (state !== "invalid-signature") return signed
  const finalCharacter = signed.signature.at(-1)
  return {
    ...signed,
    signature: `${signed.signature.slice(0, -1)}${finalCharacter === "0" ? "1" : "0"}`,
  }
}

async function startHarness(options: HarnessOptions = {}): Promise<NetworkHarness> {
  const bootstrapState = options.bootstrapState ?? "valid"
  const proxyBehavior = options.proxyBehavior ?? "tunnel"
  const temporaryDirectory = await mkdtemp(path.join(tmpdir(), "genimage-network-"))
  const transports: KoteGatewayTransport[] = []
  let target: TargetServer | undefined
  let proxy: ConnectProxy | undefined
  let bootstrap: BootstrapServer | undefined

  try {
    target = await startTargetServer()
    proxy = await startConnectProxy(target.port, proxyBehavior)
    const document = await signedBootstrap(
      `https://${HOST}:${proxy.port}`,
      bootstrapState,
    )
    bootstrap = await startBootstrapServer(document)
    const baseUrl = `https://${HOST}:${target.port}/api/v1/`
    const bootstrapUrl = `https://${HOST}:${bootstrap.port}/bootstrap.json`

    return {
      baseUrl,
      bootstrap,
      proxy,
      target,
      async createProxyTransport() {
        const cachePath = path.join(
          temporaryDirectory,
          `bootstrap-${transports.length}.json`,
        )
        const client = await createKoteGatewayClient({
          bootstrapUrl,
          cachePath,
          config: {
            version: 1,
            default: "proxy",
            strict: true,
            providers: { openrouter: "proxy" },
          },
          fetch: trustedLoopbackFetch,
          now: () => new Date(FIXED_NOW),
          publicKeyHex: BOOTSTRAP_PUBLIC_KEY,
        })
        const transport = new KoteGatewayTransport({
          bunFetch: trustedLoopbackFetch,
          forceRuntime: "bun",
          gatewayClientFactory: () => Promise.resolve(client),
          logger: noopLogger,
        })
        transports.push(transport)
        return transport
      },
      async stop() {
        await Promise.all(transports.map((transport) => transport.dispose()))
        await proxy?.stop()
        await bootstrap?.stop()
        await target?.stop()
        await rm(temporaryDirectory, { force: true, recursive: true })
      },
    }
  } catch (error) {
    await proxy?.stop()
    await bootstrap?.stop()
    await target?.stop()
    await rm(temporaryDirectory, { force: true, recursive: true })
    throw error
  }
}

function pluginOptions(routing: RoutingMode): ResolvedPluginOptions {
  return resolvePluginOptions(
    {
      routing,
      model: MODEL,
      apiKey: API_KEY,
      requestTimeoutMs: 2_000,
      maxResponseBytes: 1024 * 1024,
    },
    {},
  )
}

function openRouterClient(
  harness: NetworkHarness,
  routing: RoutingMode,
  transport: DirectTransport | KoteGatewayTransport,
): DefaultOpenRouterImageClient {
  return createOpenRouterClient(pluginOptions(routing), transport, noopLogger, {
    baseUrl: harness.baseUrl,
  })
}

function editRequest(): OpenRouterImageRequest {
  return {
    model: MODEL,
    prompt: PROMPT,
    input_references: [
      { type: "image_url", image_url: { url: FIRST_REFERENCE } },
      { type: "image_url", image_url: { url: HTTPS_REFERENCE } },
      { type: "image_url", image_url: { url: SECOND_REFERENCE } },
    ],
    n: 1,
    output_format: "png",
  }
}

function targetRequestAt(
  requests: readonly CapturedTargetRequest[],
  index: number,
): CapturedTargetRequest {
  const request = requests.at(index)
  if (request === undefined) throw new Error(`Missing target request ${index}`)
  return request
}

async function capturePluginError(promise: Promise<unknown>): Promise<PluginError> {
  try {
    await promise
  } catch (error) {
    expect(error).toBeInstanceOf(PluginError)
    if (error instanceof PluginError) return error
    throw error
  }
  throw new Error("Expected a PluginError rejection")
}

function expectEncryptedBoundary(rawConnect: string): void {
  expect(rawConnect).toStartWith("CONNECT ")
  expect(rawConnect).not.toContain(API_KEY)
  expect(rawConnect).not.toContain(PROMPT)
  expect(rawConnect).not.toContain(FIRST_REFERENCE)
  expect(rawConnect).not.toContain(SECOND_REFERENCE)
  expect(rawConnect).not.toContain("input_references")
}

function pluginInput(directory: string): PluginInput {
  return {
    directory,
    worktree: directory,
    serverUrl: new URL("http://127.0.0.1:4096"),
    client: {
      app: {
        log() {
          return Promise.resolve({})
        },
      },
    },
  } as unknown as PluginInput
}

async function disposeHooks(hooks: readonly Hooks[]): Promise<void> {
  for (const hook of [...hooks].reverse()) await hook.dispose?.()
}

describe("synthetic TLS, OpenRouter, and KoteGateway network", () => {
  test("direct stays direct while proxy uses one encrypted CONNECT with an ordered edit body", async () => {
    const harness = await startHarness()
    try {
      const directClient = openRouterClient(
        harness,
        "direct",
        new DirectTransport(trustedLoopbackFetch),
      )
      await directClient.generateImage(editRequest(), new AbortController().signal)

      expect(harness.bootstrap.requestCount()).toBe(0)
      expect(harness.proxy.connectRequests).toHaveLength(0)
      expect(harness.target.requests).toHaveLength(1)

      const proxyTransport = await harness.createProxyTransport()
      const proxiedClient = openRouterClient(harness, "proxy", proxyTransport)
      const response = await proxiedClient.generateImage(
        editRequest(),
        new AbortController().signal,
      )

      expect(response.data).toHaveLength(1)
      expect(harness.bootstrap.requestCount()).toBe(1)
      expect(harness.proxy.connectRequests).toHaveLength(1)
      expect(harness.target.requests).toHaveLength(2)
      expectEncryptedBoundary(harness.proxy.connectRequests[0] ?? "")

      const targetRequest = targetRequestAt(harness.target.requests, 1)
      expect(targetRequest.method).toBe("POST")
      expect(targetRequest.path).toBe("/api/v1/images")
      expect(targetRequest.headers.authorization).toBe(`Bearer ${API_KEY}`)
      expect(targetRequest.headers["x-kote-route-token"]).toBeUndefined()
      expect(JSON.parse(targetRequest.body)).toEqual(editRequest())
    } finally {
      await harness.stop()
    }
  })

  test("invalid signed bootstrap fails closed before CONNECT or target I/O", async () => {
    const harness = await startHarness({ bootstrapState: "invalid-signature" })
    try {
      const transport = await harness.createProxyTransport()
      const client = openRouterClient(harness, "proxy", transport)
      const error = await capturePluginError(
        client.generateImage(editRequest(), new AbortController().signal),
      )

      expect(error.code).toBe("GENIMAGE_GATEWAY_SIGNATURE_INVALID")
      expect(harness.bootstrap.requestCount()).toBe(1)
      expect(harness.proxy.connectRequests).toHaveLength(0)
      expect(harness.target.requests).toHaveLength(0)
    } finally {
      await harness.stop()
    }
  })

  test("expired bootstrap fails closed before CONNECT or target I/O", async () => {
    const harness = await startHarness({ bootstrapState: "expired" })
    try {
      const transport = await harness.createProxyTransport()
      const client = openRouterClient(harness, "proxy", transport)
      const error = await capturePluginError(
        client.generateImage(editRequest(), new AbortController().signal),
      )

      expect(error.code).toBe("GENIMAGE_GATEWAY_CACHE_EXPIRED")
      expect(harness.bootstrap.requestCount()).toBe(1)
      expect(harness.proxy.connectRequests).toHaveLength(0)
      expect(harness.target.requests).toHaveLength(0)
    } finally {
      await harness.stop()
    }
  })

  test("CONNECT refusal has no direct fallback and exposes no target secrets", async () => {
    const harness = await startHarness({ proxyBehavior: "refuse" })
    try {
      const transport = await harness.createProxyTransport()
      const client = openRouterClient(harness, "proxy", transport)
      const error = await capturePluginError(
        client.generateImage(editRequest(), new AbortController().signal),
      )

      expect(error.code).toBe("GENIMAGE_GATEWAY_CONNECT_FAILED")
      expect(harness.bootstrap.requestCount()).toBe(1)
      expect(harness.proxy.connectRequests).toHaveLength(1)
      expectEncryptedBoundary(harness.proxy.connectRequests[0] ?? "")
      expect(harness.target.requests).toHaveLength(0)
    } finally {
      await harness.stop()
    }
  })

  test("both plugin load orders leave the image proxy at exactly one CONNECT", async () => {
    const originalFetch = globalThis.fetch
    const harness = await startHarness()
    try {
      for (const order of ["image-first", "gateway-first"] as const) {
        const directory = await mkdtemp(path.join(tmpdir(), `genimage-${order}-`))
        const configPath = path.join(directory, "kote-gateway.json")
        await writeFile(
          configPath,
          JSON.stringify({
            version: 1,
            default: "proxy",
            strict: true,
            providers: { openrouter: "proxy" },
          }),
        )
        const input = pluginInput(directory)
        const hooks: Hooks[] = []
        const beforeConnects = harness.proxy.connectRequests.length
        const beforeTargets = harness.target.requests.length

        try {
          if (order === "image-first") {
            hooks.push(
              await imagePlugin(input, {
                apiKey: API_KEY,
                model: MODEL,
                routing: "proxy",
              }),
            )
            hooks.push(await gatewayPlugin.server(input, { configPath }))
          } else {
            hooks.push(await gatewayPlugin.server(input, { configPath }))
            hooks.push(
              await imagePlugin(input, {
                apiKey: API_KEY,
                model: MODEL,
                routing: "proxy",
              }),
            )
          }

          expect(globalThis.fetch).not.toBe(originalFetch)
          const transport = await harness.createProxyTransport()
          await openRouterClient(harness, "proxy", transport).generateImage(
            editRequest(),
            new AbortController().signal,
          )
          await transport.dispose()

          expect(harness.proxy.connectRequests.length - beforeConnects).toBe(1)
          expect(harness.target.requests.length - beforeTargets).toBe(1)
          const targetRequest = targetRequestAt(
            harness.target.requests,
            harness.target.requests.length - 1,
          )
          expect(targetRequest.headers["x-kote-route-token"]).toBeUndefined()
        } finally {
          await disposeHooks(hooks)
          await rm(directory, { force: true, recursive: true })
        }

        expect(globalThis.fetch).toBe(originalFetch)
      }
    } finally {
      await harness.stop()
      globalThis.fetch = originalFetch
    }
  })
})
