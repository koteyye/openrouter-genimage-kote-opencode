import { describe, expect, test } from "bun:test"

import {
  IMAGE_ASPECT_RATIOS,
  IMAGE_BACKGROUNDS,
  IMAGE_OUTPUT_FORMATS,
  IMAGE_QUALITIES,
  IMAGE_RESOLUTIONS,
} from "../../src/config/types.js"
import {
  requireResolvedPluginOptions,
  resolvePluginConfig,
  resolvePluginOptions,
} from "../../src/config/resolve.js"
import { PluginError } from "../../src/openrouter/errors.js"

function getPluginError(action: () => unknown): PluginError {
  let caught: unknown
  try {
    action()
  } catch (error) {
    caught = error
  }

  expect(caught).toBeInstanceOf(PluginError)
  return caught as PluginError
}

describe("plugin configuration", () => {
  test("resolves valid direct configuration with documented defaults", () => {
    const options = resolvePluginOptions(
      {
        routing: "direct",
        model: "openai/gpt-image-1",
        apiKey: "generation-key",
      },
      {},
    )

    expect(options).toEqual({
      routing: "direct",
      model: "openai/gpt-image-1",
      apiKey: "generation-key",
      outputDirectory: "assets/generated",
      defaults: { n: 1 },
      input: {
        maxReferences: 16,
        maxFileBytes: 20 * 1024 * 1024,
        maxTotalBytes: 50 * 1024 * 1024,
      },
      requestTimeoutMs: 300_000,
      modelCacheTtlMs: 3_600_000,
      maxResponseBytes: 128 * 1024 * 1024,
      maxDecodedBytes: 128 * 1024 * 1024,
    })
  })

  test("resolves valid proxy configuration", () => {
    const options = resolvePluginOptions(
      {
        routing: "proxy",
        model: "openai/gpt-image-1",
        apiKey: "generation-key",
      },
      {},
    )

    expect(options.routing).toBe("proxy")
  })

  test("rejects missing and unknown routing", () => {
    const missing = getPluginError(() =>
      resolvePluginOptions(
        { model: "openai/gpt-image-1", apiKey: "generation-key" },
        {},
      ),
    )
    const unknown = getPluginError(() =>
      resolvePluginOptions(
        {
          routing: "automatic",
          model: "openai/gpt-image-1",
          apiKey: "generation-key",
        },
        {},
      ),
    )

    expect(missing.code).toBe("GENIMAGE_CONFIG_INVALID")
    expect(unknown.code).toBe("GENIMAGE_CONFIG_INVALID")
  })

  test("rejects an empty model", () => {
    const error = getPluginError(() =>
      resolvePluginOptions(
        { routing: "direct", model: "  ", apiKey: "generation-key" },
        {},
      ),
    )

    expect(error.code).toBe("GENIMAGE_CONFIG_INVALID")
  })

  test("rejects control characters and oversized credentials without echoing them", () => {
    const secret = "generation-secret\r\nX-Evil: injected"
    const optionError = getPluginError(() =>
      resolvePluginOptions(
        {
          routing: "direct",
          model: "openai/gpt-image-1",
          apiKey: secret,
        },
        {},
      ),
    )
    const environmentError = getPluginError(() =>
      resolvePluginOptions(
        { routing: "direct", model: "openai/gpt-image-1" },
        { OPENROUTER_API_KEY: secret },
      ),
    )
    const oversizedError = getPluginError(() =>
      resolvePluginOptions(
        {
          routing: "direct",
          model: "openai/gpt-image-1",
          apiKey: "x".repeat(4_097),
        },
        {},
      ),
    )

    for (const error of [optionError, environmentError, oversizedError]) {
      expect(error.code).toBe("GENIMAGE_CONFIG_INVALID")
      expect(JSON.stringify(error.toJSON())).not.toContain(secret)
    }
  })

  test("prefers the option API key to the environment", () => {
    const options = resolvePluginOptions(
      {
        routing: "direct",
        model: "openai/gpt-image-1",
        apiKey: "option-key",
      },
      { OPENROUTER_API_KEY: "environment-key" },
    )

    expect(options.apiKey).toBe("option-key")
  })

  test("uses the environment API key when the option is absent", () => {
    const options = resolvePluginOptions(
      { routing: "direct", model: "openai/gpt-image-1" },
      { OPENROUTER_API_KEY: " environment-key " },
    )

    expect(options.apiKey).toBe("environment-key")
  })

  test("reports a missing API key separately from invalid configuration", () => {
    const error = getPluginError(() =>
      resolvePluginOptions(
        { routing: "direct", model: "openai/gpt-image-1" },
        { OPENROUTER_API_KEY: "   " },
      ),
    )

    expect(error.code).toBe("GENIMAGE_OPENROUTER_KEY_MISSING")
  })

  test("does not fall through to env when an explicitly configured key is empty", () => {
    const error = getPluginError(() =>
      resolvePluginOptions(
        {
          routing: "direct",
          model: "openai/gpt-image-1",
          apiKey: " ",
        },
        { OPENROUTER_API_KEY: "environment-key" },
      ),
    )

    expect(error.code).toBe("GENIMAGE_CONFIG_INVALID")
  })

  test("resolves and prioritizes the management key independently", () => {
    const fromEnvironment = resolvePluginOptions(
      {
        routing: "direct",
        model: "openai/gpt-image-1",
        apiKey: "generation-key",
      },
      { OPENROUTER_MANAGEMENT_API_KEY: " management-environment-key " },
    )
    const fromOptions = resolvePluginOptions(
      {
        routing: "direct",
        model: "openai/gpt-image-1",
        apiKey: "generation-key",
        managementApiKey: "management-option-key",
      },
      { OPENROUTER_MANAGEMENT_API_KEY: "management-environment-key" },
    )

    expect(fromEnvironment.managementApiKey).toBe("management-environment-key")
    expect(fromOptions.managementApiKey).toBe("management-option-key")
  })

  test("merges nested defaults without losing documented defaults", () => {
    const options = resolvePluginOptions(
      {
        routing: "direct",
        model: "openai/gpt-image-1",
        apiKey: "generation-key",
        outputDirectory: "custom/output",
        defaults: { quality: "high", output_format: "webp" },
        input: { maxReferences: 4, maxFileBytes: 1024 },
        requestTimeoutMs: 1000,
      },
      {},
    )

    expect(options.outputDirectory).toBe("custom/output")
    expect(options.defaults).toEqual({
      n: 1,
      output_format: "webp",
      quality: "high",
    })
    expect(options.input).toEqual({
      maxReferences: 4,
      maxFileBytes: 1024,
      maxTotalBytes: 50 * 1024 * 1024,
    })
    expect(options.requestTimeoutMs).toBe(1000)
  })

  test("accepts every documented generation enum", () => {
    for (const aspectRatio of IMAGE_ASPECT_RATIOS) {
      expect(() =>
        resolvePluginOptions(
          {
            routing: "direct",
            model: "openai/gpt-image-1",
            apiKey: "generation-key",
            defaults: { aspect_ratio: aspectRatio },
          },
          {},
        ),
      ).not.toThrow()
    }

    for (const background of IMAGE_BACKGROUNDS) {
      expect(() =>
        resolvePluginOptions(
          {
            routing: "direct",
            model: "openai/gpt-image-1",
            apiKey: "generation-key",
            defaults: { background, output_format: "png" },
          },
          {},
        ),
      ).not.toThrow()
    }

    for (const outputFormat of IMAGE_OUTPUT_FORMATS) {
      expect(() =>
        resolvePluginOptions(
          {
            routing: "direct",
            model: "openai/gpt-image-1",
            apiKey: "generation-key",
            defaults: { output_format: outputFormat },
          },
          {},
        ),
      ).not.toThrow()
    }

    for (const quality of IMAGE_QUALITIES) {
      expect(() =>
        resolvePluginOptions(
          {
            routing: "direct",
            model: "openai/gpt-image-1",
            apiKey: "generation-key",
            defaults: { quality },
          },
          {},
        ),
      ).not.toThrow()
    }

    for (const resolution of IMAGE_RESOLUTIONS) {
      expect(() =>
        resolvePluginOptions(
          {
            routing: "direct",
            model: "openai/gpt-image-1",
            apiKey: "generation-key",
            defaults: { resolution },
          },
          {},
        ),
      ).not.toThrow()
    }
  })

  test("rejects unknown top-level and nested fields including custom base URLs", () => {
    const topLevel = getPluginError(() =>
      resolvePluginOptions(
        {
          routing: "direct",
          model: "openai/gpt-image-1",
          apiKey: "generation-key",
          baseUrl: "https://example.test",
        },
        {},
      ),
    )
    const nested = getPluginError(() =>
      resolvePluginOptions(
        {
          routing: "direct",
          model: "openai/gpt-image-1",
          apiKey: "generation-key",
          defaults: { n: 1, style: "expensive" },
        },
        {},
      ),
    )

    expect(topLevel.code).toBe("GENIMAGE_CONFIG_INVALID")
    expect(nested.code).toBe("GENIMAGE_CONFIG_INVALID")
  })

  test("rejects invalid numeric limits and cross-field input limits", () => {
    const invalidOptions = [
      { input: { maxReferences: 0 } },
      { input: { maxReferences: 17 } },
      { input: { maxFileBytes: 0 } },
      { input: { maxTotalBytes: -1 } },
      { input: { maxFileBytes: 60 * 1024 * 1024 } },
      { input: { maxFileBytes: 200, maxTotalBytes: 100 } },
      { requestTimeoutMs: 0 },
      { modelCacheTtlMs: 0 },
      { maxResponseBytes: Number.POSITIVE_INFINITY },
      { maxDecodedBytes: 1.5 },
    ]

    for (const invalid of invalidOptions) {
      const error = getPluginError(() =>
        resolvePluginOptions(
          {
            routing: "direct",
            model: "openai/gpt-image-1",
            apiKey: "generation-key",
            ...invalid,
          },
          {},
        ),
      )
      expect(error.code).toBe("GENIMAGE_CONFIG_INVALID")
    }
  })

  test("rejects unsafe output directories during configuration", () => {
    for (const outputDirectory of [
      "/tmp/generated",
      "C:\\generated",
      "\\\\server\\share",
      "assets/../outside",
      "assets\u0000generated",
    ]) {
      const error = getPluginError(() =>
        resolvePluginOptions(
          {
            routing: "direct",
            model: "openai/gpt-image-1",
            apiKey: "generation-key",
            outputDirectory,
          },
          {},
        ),
      )
      expect(error.code).toBe("GENIMAGE_CONFIG_INVALID")
    }
  })

  test("accepts ignorable compression and a negative integer seed", () => {
    const options = resolvePluginOptions(
      {
        routing: "direct",
        model: "openai/gpt-image-1",
        apiKey: "generation-key",
        defaults: { output_format: "png", output_compression: 80, seed: -42 },
      },
      {},
    )

    expect(options.defaults).toEqual({ n: 1, output_format: "png", output_compression: 80, seed: -42 })
  })

  test("rejects incompatible generation defaults", () => {
    const invalidDefaults = [
      { background: "transparent", output_format: "jpeg" },
      { background: "transparent", output_format: "svg" },
      { background: "transparent" },
      { n: 0 },
      { n: 11 },
      { seed: 1.5 },
    ]

    for (const defaults of invalidDefaults) {
      const error = getPluginError(() =>
        resolvePluginOptions(
          {
            routing: "direct",
            model: "openai/gpt-image-1",
            apiKey: "generation-key",
            defaults,
          },
          {},
        ),
      )
      expect(error.code).toBe("GENIMAGE_CONFIG_INVALID")
    }
  })

  test("retains a blocked state and prevents access to options", () => {
    const state = resolvePluginConfig(
      { routing: "direct", model: "", apiKey: "generation-key" },
      {},
    )

    expect(state.blocked).toBe(true)
    if (!state.blocked) {
      throw new Error("Expected blocked configuration")
    }
    expect(state.error.code).toBe("GENIMAGE_CONFIG_INVALID")
    expect(() => requireResolvedPluginOptions(state)).toThrow(PluginError)
  })
})
