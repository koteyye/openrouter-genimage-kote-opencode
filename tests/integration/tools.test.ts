import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import type { ToolContext } from "@opencode-ai/plugin"

import { resolvePluginConfig, resolvePluginOptions } from "../../src/config/resolve.js"
import { noopLogger } from "../../src/logging.js"
import type { ModelCapabilityService } from "../../src/openrouter/capabilities.js"
import type {
  OpenRouterCredits,
  OpenRouterImageClient,
  OpenRouterKeyInfo,
} from "../../src/openrouter/client.js"
import type { OpenRouterImageRequest } from "../../src/openrouter/schemas.js"
import type { OpenCodeMessageClient } from "../../src/references/attachments.js"
import { createBalanceTool } from "../../src/tools/balance.js"
import { createEditImageTool } from "../../src/tools/edit-image.js"
import { createGenerateImageTool } from "../../src/tools/generate-image.js"
import type { ToolDependencies } from "../../src/tools/types.js"

const PNG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 1, 2, 3])
const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  )
})

async function temporaryDirectory(): Promise<string> {
  const value = await mkdtemp(path.join(tmpdir(), "genimage-tools-"))
  temporaryDirectories.push(value)
  return value
}

function context(worktree: string, ask?: ToolContext["ask"]): ToolContext {
  return {
    sessionID: "session",
    messageID: "assistant",
    agent: "build",
    directory: worktree,
    worktree,
    abort: new AbortController().signal,
    metadata() {},
    ask:
      ask ??
      (async () => {
        throw new Error("Tools must delegate permission checks to OpenCode")
      }),
  }
}

function attachmentClient(dataUrl: string): OpenCodeMessageClient {
  return {
    session: {
      async message(options) {
        return options.path.messageID === "assistant"
          ? {
              data: {
                info: { role: "assistant", parentID: "user" },
                parts: [],
              },
            }
          : {
              data: {
                info: { role: "user" },
                parts: [{ type: "file", mime: "image/png", url: dataUrl }],
              },
            }
      },
    },
  }
}

function dependencies(options: {
  worktree: string
  onGenerate?: (request: OpenRouterImageRequest) => void
  generatedImages?: number
  includeUsageCost?: boolean
  key?: OpenRouterKeyInfo
  credits?: OpenRouterCredits | Error
  managementApiKey?: string
  onCreditsKey?: (key: string) => void
}): ToolDependencies {
  const pluginOptions = resolvePluginOptions({
    routing: "direct",
    model: "test/image-model",
    apiKey: "test-generation-key",
    ...(options.managementApiKey === undefined
      ? {}
      : { managementApiKey: options.managementApiKey }),
    outputDirectory: "assets/generated",
    defaults: { n: 1, output_format: "png" },
  })
  const imageClient: OpenRouterImageClient = {
    async listImageModels() {
      return []
    },
    async listImageModelEndpoints() {
      return { id: pluginOptions.model, endpoints: [] }
    },
    async generateImage(request) {
      options.onGenerate?.(request)
      return {
        data: Array.from({ length: options.generatedImages ?? 1 }, () => ({
          b64_json: PNG.toString("base64"),
        })),
        ...(options.includeUsageCost === false
          ? {}
          : { usage: { cost: 0.0000001 } }),
      }
    },
    async getCurrentKey() {
      return options.key ?? { usage: 1.25, limit: 10, limit_remaining: 8.75 }
    },
    async getCredits(key) {
      options.onCreditsKey?.(key)
      if (options.credits instanceof Error) throw options.credits
      return options.credits ?? { total_credits: 5, total_usage: 6 }
    },
  }
  const capabilities = {
    async validate() {
      return {
        id: pluginOptions.model,
        architecture: {
          input_modalities: ["text", "image"],
          output_modalities: ["image"],
        },
        supported_parameters: {},
      }
    },
    clear() {},
  } as unknown as ModelCapabilityService

  return {
    configState: { blocked: false, options: pluginOptions },
    getRuntime: () => ({ options: pluginOptions, client: imageClient, capabilities }),
    messageClient: attachmentClient(
      `data:image/png;base64,${PNG.toString("base64")}`,
    ),
    serverUrl: new URL("http://127.0.0.1:4096"),
    logger: noopLogger,
  }
}

describe("image tools", () => {
  test("generates, saves, and returns an OpenCode attachment", async () => {
    const worktree = await temporaryDirectory()
    let captured: OpenRouterImageRequest | undefined
    let askCount = 0
    const tool = createGenerateImageTool(
      dependencies({ worktree, onGenerate: (request) => (captured = request) }),
    )

    const result = await tool.execute(
      {
        prompt: "A single potion icon",
        output_path: "assets/icons/potion.png",
        n: 1,
        output_format: "png",
      },
      context(worktree, async () => {
        askCount += 1
      }),
    )

    expect(captured).toEqual({
      model: "test/image-model",
      prompt: "A single potion icon",
      n: 1,
      output_format: "png",
    })
    expect(askCount).toBe(0)
    expect(typeof result).toBe("object")
    if (typeof result === "string") throw new Error("expected structured result")
    expect(result.attachments).toHaveLength(1)
    expect(result.attachments?.[0]?.url).toStartWith("data:image/png;base64,")
    expect(result.output).not.toContain(PNG.toString("base64"))
    expect(await readFile(path.join(worktree, "assets/icons/potion.png"))).toEqual(PNG)
  })

  test("edits the current attachment and preserves prompt/reference bytes", async () => {
    const worktree = await temporaryDirectory()
    let captured: OpenRouterImageRequest | undefined
    let askCount = 0
    const tool = createEditImageTool(
      dependencies({ worktree, onGenerate: (request) => (captured = request) }),
    )
    const prompt = "Reference image 1 is primary. Change only the pose."

    const result = await tool.execute(
      { prompt, output_path: "edited.png" },
      context(worktree, async () => {
        askCount += 1
      }),
    )

    expect(askCount).toBe(0)
    expect(captured?.model).toBe("test/image-model")
    expect(captured?.prompt).toBe(prompt)
    const url = captured?.input_references?.[0]?.image_url.url
    expect(url).toStartWith("data:image/png;base64,")
    expect(Buffer.from(url?.split(",")[1] ?? "", "base64")).toEqual(PNG)
    expect(typeof result).toBe("object")
  })

  test("delegates permission checks to the OpenCode host", async () => {
    const worktree = await temporaryDirectory()
    let askCount = 0
    const tool = createEditImageTool(dependencies({ worktree }))

    await tool.execute(
      { prompt: "edit this image" },
      context(worktree, async () => {
        askCount += 1
      }),
    )

    expect(askCount).toBe(0)
  })

  test("a blocked config makes no permission or network call", async () => {
    const worktree = await temporaryDirectory()
    let asked = false
    let runtimeRequested = false
    const blocked = resolvePluginConfig({ routing: "direct", model: "x" }, {})
    const deps: ToolDependencies = {
      configState: blocked,
      getRuntime() {
        runtimeRequested = true
        throw new Error("should not initialize runtime")
      },
      messageClient: attachmentClient("data:image/png;base64,AA=="),
      serverUrl: new URL("http://127.0.0.1:4096"),
      logger: noopLogger,
    }
    await expect(
      createGenerateImageTool(deps).execute(
        { prompt: "new image" },
        context(worktree, async () => {
          asked = true
        }),
      ),
    ).rejects.toMatchObject({ code: "GENIMAGE_OPENROUTER_KEY_MISSING" })
    expect(asked).toBeFalse()
    expect(runtimeRequested).toBeFalse()
  })

  test("forbids an edit output that names its project source before POST", async () => {
    const worktree = await temporaryDirectory()
    await writeFile(path.join(worktree, "source.png"), PNG)
    let generated = false
    const tool = createEditImageTool(
      dependencies({ worktree, onGenerate: () => (generated = true) }),
    )
    await expect(
      tool.execute(
        {
          prompt: "make a variation",
          references: [{ type: "project_file", path: "source.png" }],
          output_path: "source.png",
        },
        context(worktree),
      ),
    ).rejects.toMatchObject({ code: "GENIMAGE_SOURCE_OVERWRITE_FORBIDDEN" })
    expect(generated).toBeFalse()
  })

  test("warns when fewer images return and omits an unreported cost", async () => {
    const worktree = await temporaryDirectory()
    const result = await createGenerateImageTool(
      dependencies({
        worktree,
        generatedImages: 1,
        includeUsageCost: false,
      }),
    ).execute(
      {
        prompt: "two potion icons",
        n: 2,
        output_path: "potion.png",
      },
      context(worktree),
    )
    if (typeof result === "string") throw new Error("expected structured result")

    expect(result.output).toContain("fewer than the 2 requested")
    expect(result.output).toContain("OpenRouter cost: not reported")
    expect(result.metadata).not.toHaveProperty("costUsd")
  })
})

describe("balance tool", () => {
  test("distinguishes key limit from negative account credits", async () => {
    const worktree = await temporaryDirectory()
    let asks = 0
    const tool = createBalanceTool(
      dependencies({
        worktree,
        managementApiKey: "management-key",
        key: {
          label: "Production",
          usage: 1e-8,
          limit: 10,
          limit_remaining: 9,
          is_management_key: false,
        },
        credits: { total_credits: 5, total_usage: 6 },
      }),
    )
    const result = await tool.execute(
      {},
      context(worktree, async () => {
        asks += 1
      }),
    )
    if (typeof result === "string") throw new Error("expected structured result")
    expect(asks).toBe(0)
    expect(result.output).toContain("Remaining API-key spending limit: $9.000000")
    expect(result.output).toContain("Available account credits: $-1.000000")
    expect(result.output).not.toContain("Lifetime usage: $0.000000")
  })

  test("returns key data when credits fail", async () => {
    const worktree = await temporaryDirectory()
    const result = await createBalanceTool(
      dependencies({
        worktree,
        managementApiKey: "management-key",
        credits: new Error("401 secret upstream body"),
      }),
    ).execute({}, context(worktree))
    if (typeof result === "string") throw new Error("expected structured result")
    expect(result.output).toContain("Lifetime usage: $1.250000")
    expect(result.output).toContain("Account credits: unavailable")
    expect(result.output).not.toContain("secret upstream body")
  })

  test("reports unlimited and period usage without calling account credits", async () => {
    const worktree = await temporaryDirectory()
    let creditsCalls = 0
    const result = await createBalanceTool(
      dependencies({
        worktree,
        key: {
          usage_daily: 1,
          usage_weekly: 2,
          usage_monthly: 3,
          limit: null,
          limit_remaining: null,
          limit_reset: "monthly",
          expires_at: null,
        },
        onCreditsKey: () => {
          creditsCalls += 1
        },
      }),
    ).execute({}, context(worktree))
    if (typeof result === "string") throw new Error("expected structured result")

    expect(result.output).toContain("Daily usage: $1.000000")
    expect(result.output).toContain("Weekly usage: $2.000000")
    expect(result.output).toContain("Monthly usage: $3.000000")
    expect(result.output).toContain("API-key spending limit: unlimited")
    expect(result.output).toContain("Remaining API-key spending limit: unlimited")
    expect(result.output).toContain("Limit reset: monthly")
    expect(result.output).toContain("Expires at: never")
    expect(creditsCalls).toBe(0)
  })

  test("uses a generation key for credits only when OpenRouter marks it management", async () => {
    const worktree = await temporaryDirectory()
    let creditsKey: string | undefined
    const result = await createBalanceTool(
      dependencies({
        worktree,
        key: { is_management_key: true },
        credits: { total_credits: 10, total_usage: 4 },
        onCreditsKey: (key) => {
          creditsKey = key
        },
      }),
    ).execute({}, context(worktree))
    if (typeof result === "string") throw new Error("expected structured result")

    expect(creditsKey).toBe("test-generation-key")
    expect(result.output).toContain("Available account credits: $6.000000")
  })

  test("sanitizes provider-controlled key strings in output and metadata", async () => {
    const worktree = await temporaryDirectory()
    const leaked = `data:image/png;base64,${"A".repeat(128)}`
    const result = await createBalanceTool(
      dependencies({
        worktree,
        key: {
          limit_reset: leaked,
          expires_at: "Bearer secret-token",
        },
      }),
    ).execute({}, context(worktree))
    if (typeof result === "string") throw new Error("expected structured result")

    const safeSurface = JSON.stringify(result)
    expect(safeSurface).not.toContain(leaked)
    expect(safeSurface).not.toContain("secret-token")
    expect(safeSurface).toContain("[REDACTED]")
  })
})
