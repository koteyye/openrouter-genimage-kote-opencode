import { afterAll, describe, expect, test } from "bun:test"
import gatewayPlugin from "@koteye/kote-gateway-opencode"
import type { Hooks, PluginInput } from "@opencode-ai/plugin"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

import { server as imagePlugin } from "../../src/server.js"
import { DirectTransport } from "../../src/transport/direct.js"

const temporaryDirectories: string[] = []

afterAll(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  )
})

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

async function createGatewayConfig(directory: string): Promise<string> {
  const configPath = path.join(directory, "kote-gateway.json")
  await writeFile(
    configPath,
    JSON.stringify({
      version: 1,
      default: "direct",
      strict: true,
      providers: { openrouter: "direct" },
    }),
  )
  return configPath
}

async function disposeAll(hooks: readonly Hooks[]): Promise<void> {
  for (const hook of [...hooks].reverse()) await hook.dispose?.()
}

describe("coexistence with @koteye/kote-gateway-opencode", () => {
  test("both load orders preserve native image routing and restore global state", async () => {
    const originalFetch = globalThis.fetch

    for (const order of ["image-first", "gateway-first"] as const) {
      const directory = await mkdtemp(path.join(tmpdir(), `genimage-${order}-`))
      temporaryDirectories.push(directory)
      const configPath = await createGatewayConfig(directory)
      const input = pluginInput(directory)
      const hooks: Hooks[] = []
      let imageHooks: Hooks
      let gatewayHooks: Hooks

      try {
        if (order === "image-first") {
          imageHooks = await imagePlugin(input, {
            routing: "direct",
            model: "test/image-model",
            apiKey: "test-key",
          })
          hooks.push(imageHooks)
          expect(globalThis.fetch).toBe(originalFetch)
          gatewayHooks = await gatewayPlugin.server(input, { configPath })
          hooks.push(gatewayHooks)
        } else {
          gatewayHooks = await gatewayPlugin.server(input, { configPath })
          hooks.push(gatewayHooks)
          imageHooks = await imagePlugin(input, {
            routing: "direct",
            model: "test/image-model",
            apiKey: "test-key",
          })
          hooks.push(imageHooks)
        }

        const gatewayWrapper = globalThis.fetch
        expect(gatewayWrapper).not.toBe(originalFetch)
        expect(imageHooks.tool).toHaveProperty("openrouter_edit_image")
        expect(imageHooks.tool).toHaveProperty("openrouter_generate_image")
        expect(imageHooks.tool).toHaveProperty("openrouter_balance")

        const receivedHeaders: Headers[] = []
        const target = Bun.serve({
          hostname: "127.0.0.1",
          port: 0,
          fetch(request) {
            receivedHeaders.push(request.headers)
            return new Response("ok")
          },
        })
        try {
          const targetUrl = `http://127.0.0.1:${target.port}/provider`
          const output = { headers: {} as Record<string, string> }
          await gatewayHooks["chat.headers"]?.(
            {
              model: {
                providerID: "openrouter",
                api: { url: targetUrl },
              },
            } as Parameters<NonNullable<Hooks["chat.headers"]>>[0],
            output,
          )

          const ordinary = await globalThis.fetch(targetUrl, {
            headers: output.headers,
          })
          expect(await ordinary.text()).toBe("ok")

          const imageRequest = await new DirectTransport().request(
            new URL(targetUrl),
            { method: "GET" },
            new AbortController().signal,
          )
          expect(await imageRequest.text()).toBe("ok")
          expect(receivedHeaders).toHaveLength(2)
          for (const headers of receivedHeaders) {
            expect(
              [...headers.keys()].some((name) => name.toLowerCase().includes("kote")),
            ).toBeFalse()
          }
          expect(globalThis.fetch).toBe(gatewayWrapper)
        } finally {
          await target.stop(true)
        }
      } finally {
        await disposeAll(hooks)
      }

      expect(globalThis.fetch).toBe(originalFetch)
    }
  })
})
