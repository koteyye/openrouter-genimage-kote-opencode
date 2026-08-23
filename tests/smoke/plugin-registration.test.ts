import { describe, expect, test } from "bun:test"
import type { Config, PluginInput } from "@opencode-ai/plugin"

function blockedFetch(counter: { calls: number }): typeof globalThis.fetch {
  return (() => {
    counter.calls += 1
    return Promise.reject(
      new Error("Network access is forbidden during plugin registration smoke"),
    )
  }) as unknown as typeof globalThis.fetch
}

describe("plugin registration smoke", () => {
  test("imports and registers tools/config without network side effects", async () => {
    const originalFetch = globalThis.fetch
    const counter = { calls: 0 }
    const networkBlocker = blockedFetch(counter)
    globalThis.fetch = networkBlocker

    try {
      const imported = await import("../../src/server.js")
      expect(globalThis.fetch).toBe(networkBlocker)
      expect(counter.calls).toBe(0)

      const input = {
        client: {
          app: {
            log: () => Promise.resolve({}),
          },
        },
        directory: "C:/smoke/project",
        worktree: "C:/smoke/project",
        serverUrl: new URL("http://127.0.0.1:4096"),
      } as unknown as PluginInput
      const hooks = await imported.server(input, {
        routing: "direct",
        model: "smoke/no-paid-request",
        apiKey: "smoke-not-a-real-key",
      })

      expect(Object.keys(hooks.tool ?? {}).sort()).toEqual([
        "openrouter_balance",
        "openrouter_edit_image",
        "openrouter_generate_image",
      ])
      const config: Config = {}
      if (hooks.config === undefined) {
        throw new Error("Plugin config hook is missing")
      }
      await hooks.config(config)

      expect(config.command?.["openrouter-balance"]).toBeDefined()
      const permissions = config.permission as unknown as Record<string, unknown>
      expect(permissions).toMatchObject({
        openrouter_edit_image: "ask",
        openrouter_generate_image: "ask",
        openrouter_balance: "allow",
      })
      expect(counter.calls).toBe(0)
      expect(globalThis.fetch).toBe(networkBlocker)
      await hooks.dispose?.()
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})
