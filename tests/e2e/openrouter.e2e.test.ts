import { describe, expect, setDefaultTimeout, test } from "bun:test"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import type { ToolContext } from "@opencode-ai/plugin"

import { resolvePluginOptions } from "../../src/config/resolve.js"
import { noopLogger } from "../../src/logging.js"
import { ModelCapabilityService } from "../../src/openrouter/capabilities.js"
import { createOpenRouterClient } from "../../src/openrouter/client.js"
import type {
  OpenRouterImageRequest,
  OpenRouterImageResponse,
} from "../../src/openrouter/schemas.js"
import type {
  ImageReference,
  OpenCodeMessageClient,
} from "../../src/references/attachments.js"
import { createEditImageTool } from "../../src/tools/edit-image.js"
import type { ToolDependencies } from "../../src/tools/types.js"
import { DirectTransport } from "../../src/transport/direct.js"

const ONE_PIXEL_PNG =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="

function environmentValue(name: string): string | undefined {
  const value = process.env[name]?.trim()
  return value === undefined || value.length === 0 ? undefined : value
}

function assertGeneratedImages(response: OpenRouterImageResponse): void {
  expect(Array.isArray(response.data)).toBe(true)
  expect(response.data.length).toBeGreaterThanOrEqual(1)
  for (const image of response.data) {
    expect(typeof image.b64_json).toBe("string")
    expect(image.b64_json.length).toBeGreaterThan(0)
  }
  if (response.usage?.cost !== undefined) {
    expect(Number.isFinite(response.usage.cost)).toBe(true)
  }
}

function toolContext(worktree: string): ToolContext {
  return {
    sessionID: "e2e-session",
    messageID: "e2e-assistant",
    agent: "build",
    directory: worktree,
    worktree,
    abort: new AbortController().signal,
    metadata() {},
    async ask() {
      throw new Error("OpenCode permissions must run before tool execution")
    },
  }
}

function attachmentClient(): OpenCodeMessageClient {
  return {
    session: {
      async message(options) {
        return options.path.messageID === "e2e-assistant"
          ? {
              data: {
                info: { role: "assistant", parentID: "e2e-user" },
                parts: [],
              },
            }
          : {
              data: {
                info: { role: "user" },
                parts: [
                  { type: "file", mime: "image/png", url: ONE_PIXEL_PNG },
                ],
              },
            }
      },
    },
  }
}

function firstSavedPath(metadata: unknown): string {
  if (
    typeof metadata !== "object" ||
    metadata === null ||
    !("images" in metadata) ||
    !Array.isArray(metadata.images) ||
    metadata.images.length === 0
  ) {
    throw new Error("ToolResult metadata has no saved images")
  }
  const first = metadata.images[0] as unknown
  if (
    typeof first !== "object" ||
    first === null ||
    !("path" in first) ||
    typeof first.path !== "string"
  ) {
    throw new Error("ToolResult image metadata has no path")
  }
  return first.path
}

describe("real OpenRouter Images API (paid, explicit opt-in)", () => {
  const requested = process.env.RUN_OPENROUTER_E2E === "1"
  const apiKey = environmentValue("OPENROUTER_API_KEY")
  const model = environmentValue("OPENROUTER_IMAGE_MODEL_E2E")
  const publicHttpsReference = environmentValue(
    "OPENROUTER_IMAGE_REFERENCE_URL_E2E",
  )

  if (!requested) {
    test.skip(
      "is disabled unless RUN_OPENROUTER_E2E=1",
      () => undefined,
    )
    return
  }

  if (apiKey === undefined || model === undefined) {
    test("requires an explicitly budgeted key and image model", () => {
      throw new Error(
        "RUN_OPENROUTER_E2E=1 requires OPENROUTER_API_KEY and OPENROUTER_IMAGE_MODEL_E2E.",
      )
    })
    return
  }

  setDefaultTimeout(310_000)
  const managementApiKey = environmentValue("OPENROUTER_MANAGEMENT_API_KEY")
  const pluginOptions = resolvePluginOptions(
    {
      routing: "direct",
      model,
      apiKey,
      ...(managementApiKey === undefined ? {} : { managementApiKey }),
      requestTimeoutMs: 300_000,
    },
    {},
  )
  const transport = new DirectTransport()
  const client = createOpenRouterClient(pluginOptions, transport, noopLogger)
  const capabilities = new ModelCapabilityService({
    client,
    pluginOptions,
    logger: noopLogger,
  })
  const signal = new AbortController().signal

  test("reads current-key usage without exposing credentials", async () => {
    const key = await client.getCurrentKey(signal)
    if (key.usage !== undefined) expect(Number.isFinite(key.usage)).toBe(true)
  })

  test("generates one text-to-image result", async () => {
    const request: OpenRouterImageRequest = {
      model,
      prompt: "E2E test: create a simple neutral blue circle icon on white.",
    }
    await capabilities.validate("generate", request, signal)

    assertGeneratedImages(await client.generateImage(request, signal))
  })

  test("edits from one inline image reference", async () => {
    const request: OpenRouterImageRequest = {
      model,
      prompt: "E2E test: preserve the reference and add a thin blue border.",
      input_references: [
        {
          type: "image_url",
          image_url: { url: ONE_PIXEL_PNG },
        },
      ],
    }
    await capabilities.validate("edit", request, signal)

    assertGeneratedImages(await client.generateImage(request, signal))
  })

  test("edits from two ordered inline image references", async () => {
    const request: OpenRouterImageRequest = {
      model,
      prompt:
        "E2E test: use the first reference as the subject and the second as style guidance.",
      input_references: [
        {
          type: "image_url",
          image_url: { url: ONE_PIXEL_PNG },
        },
        {
          type: "image_url",
          image_url: { url: ONE_PIXEL_PNG },
        },
      ],
    }
    await capabilities.validate("edit", request, signal)

    assertGeneratedImages(await client.generateImage(request, signal))
  })

  test("resolves an OpenCode attachment and project file, saves output, and returns ToolResult attachments", async () => {
    const worktree = await mkdtemp(
      path.join(tmpdir(), "openrouter-genimage-paid-e2e-"),
    )
    try {
      const projectSource = Buffer.from(ONE_PIXEL_PNG.split(",")[1] ?? "", "base64")
      await writeFile(path.join(worktree, "project-reference.png"), projectSource)
      const dependencies: ToolDependencies = {
        configState: { blocked: false, options: pluginOptions },
        getRuntime: () => ({ options: pluginOptions, client, capabilities }),
        messageClient: attachmentClient(),
        serverUrl: new URL("http://127.0.0.1:4096"),
        logger: noopLogger,
      }
      const references: ImageReference[] = [
        { type: "message_attachment", index: 1 },
        { type: "project_file", path: "project-reference.png" },
        ...(publicHttpsReference === undefined
          ? []
          : [{ type: "https_url" as const, url: publicHttpsReference }]),
      ]

      const result = await createEditImageTool(dependencies).execute(
        {
          prompt:
            "E2E test: use reference 1 as the primary subject and reference 2 as supporting visual guidance.",
          references,
          output_path: "e2e/generated.png",
        },
        toolContext(worktree),
      )
      if (typeof result === "string") throw new Error("Expected a ToolResult object")

      expect(result.attachments).toBeArray()
      expect(result.attachments).not.toHaveLength(0)
      expect(result.attachments?.[0]?.url).toStartWith("data:image/")
      const savedPath = firstSavedPath(result.metadata)
      expect((await readFile(path.join(worktree, savedPath))).byteLength).toBeGreaterThan(0)
    } finally {
      await rm(worktree, { recursive: true, force: true })
    }
  })

  if (process.env.RUN_OPENROUTER_CREDITS_E2E !== "1") {
    test.skip(
      "account credits require RUN_OPENROUTER_CREDITS_E2E=1",
      () => undefined,
    )
  } else if (managementApiKey === undefined) {
    test("requires a management key for the account-credits opt-in", () => {
      throw new Error(
        "RUN_OPENROUTER_CREDITS_E2E=1 requires OPENROUTER_MANAGEMENT_API_KEY.",
      )
    })
  } else {
    test("reads account credits with separate management authorization", async () => {
      const credits = await client.getCredits(managementApiKey, signal)
      expect(Number.isFinite(credits.total_credits)).toBe(true)
      expect(Number.isFinite(credits.total_usage)).toBe(true)
    })
  }
})
