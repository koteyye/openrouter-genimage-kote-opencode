import { describe, expect, test } from "bun:test"

import { resolvePluginOptions } from "../../src/config/resolve.js"
import type { ImageGenerationDefaults } from "../../src/config/types.js"
import { PluginError } from "../../src/openrouter/errors.js"
import {
  buildImageToImageRequest,
  buildTextToImageRequest,
} from "../../src/openrouter/requests.js"
import type {
  GenerateImageArgs,
  OpenRouterInputReference,
} from "../../src/openrouter/schemas.js"

function options(defaults: ImageGenerationDefaults = {}) {
  return resolvePluginOptions(
    {
      routing: "direct",
      model: "configured/model-id",
      apiKey: "generation-key",
      defaults,
    },
    {},
  )
}

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

const REFERENCES: OpenRouterInputReference[] = [
  {
    type: "image_url",
    image_url: { url: "data:image/png;base64,iVBORw0KGgo=" },
  },
  {
    type: "image_url",
    image_url: { url: "https://example.test/reference.webp" },
  },
]

describe("OpenRouter image request parameters", () => {
  test("builds a text-to-image request with n=1 by default", () => {
    const request = buildTextToImageRequest(options(), {
      prompt: "A fantasy inventory icon",
    })

    expect(request).toEqual({
      model: "configured/model-id",
      prompt: "A fantasy inventory icon",
      n: 1,
    })
    expect("input_references" in request).toBe(false)
  })

  test("builds an image-to-image request and preserves reference order", () => {
    const request = buildImageToImageRequest(
      options({ output_format: "png" }),
      { prompt: "Preserve the character and change only the pose" },
      REFERENCES,
    )

    expect(request.model).toBe("configured/model-id")
    expect(request.input_references).toEqual(REFERENCES)
    expect(request.input_references?.[0]?.image_url.url).toStartWith(
      "data:image/png",
    )
    expect(request.input_references?.[1]?.image_url.url).toStartWith("https://")
  })

  test("allows n=1 and n=10", () => {
    expect(
      buildTextToImageRequest(options(), { prompt: "one", n: 1 }).n,
    ).toBe(1)
    expect(
      buildTextToImageRequest(options(), { prompt: "ten", n: 10 }).n,
    ).toBe(10)
  })

  test("rejects n=0 and n=11", () => {
    for (const n of [0, 11]) {
      const error = getPluginError(() =>
        buildTextToImageRequest(options(), {
          prompt: "invalid count",
          n,
        }),
      )
      expect(error.code).toBe("GENIMAGE_PARAMETER_UNSUPPORTED")
    }
  })

  test("allows transparent PNG and WebP", () => {
    for (const output_format of ["png", "webp"] as const) {
      const request = buildTextToImageRequest(options(), {
        prompt: "transparent asset",
        background: "transparent",
        output_format,
      })

      expect(request.background).toBe("transparent")
      expect(request.output_format).toBe(output_format)
    }
  })

  test("rejects transparent JPEG before a request can be sent", () => {
    const error = getPluginError(() =>
      buildTextToImageRequest(options(), {
        prompt: "transparent asset",
        background: "transparent",
        output_format: "jpeg",
      }),
    )

    expect(error.code).toBe("GENIMAGE_PARAMETER_UNSUPPORTED")
  })

  test("rejects a transparent background when no output format can be resolved", () => {
    const error = getPluginError(() =>
      buildTextToImageRequest(options(), {
        prompt: "transparent asset",
        background: "transparent",
      }),
    )

    expect(error.code).toBe("GENIMAGE_PARAMETER_UNSUPPORTED")
  })

  test("allows compression for JPEG and WebP", () => {
    for (const output_format of ["jpeg", "webp"] as const) {
      const request = buildTextToImageRequest(options(), {
        prompt: "compressed asset",
        output_format,
        output_compression: 73,
      })

      expect(request.output_compression).toBe(73)
    }
  })

  test("uses a default WebP format with an argument-level compression", () => {
    const request = buildTextToImageRequest(
      options({ output_format: "webp" }),
      { prompt: "compressed asset", output_compression: 50 },
    )

    expect(request.output_format).toBe("webp")
    expect(request.output_compression).toBe(50)
  })

  test("rejects compression for PNG or an unresolved output format", () => {
    const args = [
      { output_format: "png", output_compression: 73 },
      { output_compression: 73 },
    ] as const

    for (const invalid of args) {
      const error = getPluginError(() =>
        buildTextToImageRequest(options(), {
          prompt: "invalid compression",
          ...invalid,
        }),
      )
      expect(error.code).toBe("GENIMAGE_PARAMETER_UNSUPPORTED")
    }
  })

  test("rejects invalid resolution, aspect ratio, and seed", () => {
    const invalidArgs: unknown[] = [
      { prompt: "invalid", resolution: "8K" },
      { prompt: "invalid", aspect_ratio: "7:3" },
      { prompt: "invalid", seed: -1 },
      { prompt: "invalid", seed: 1.5 },
    ]

    for (const invalid of invalidArgs) {
      const error = getPluginError(() =>
        buildTextToImageRequest(options(), invalid as GenerateImageArgs),
      )
      expect(error.code).toBe("GENIMAGE_PARAMETER_UNSUPPORTED")
    }
  })

  test("omits undefined and non-API output fields", () => {
    const request = buildTextToImageRequest(options(), {
      prompt: "asset",
      output_path: "assets/generated/custom.png",
      aspect_ratio: undefined,
      background: undefined,
      output_format: undefined,
      seed: undefined,
    })

    expect(Object.values(request)).not.toContain(undefined)
    expect("output_path" in request).toBe(false)
    expect("aspect_ratio" in request).toBe(false)
    expect("background" in request).toBe(false)
    expect("output_format" in request).toBe(false)
    expect("seed" in request).toBe(false)
  })

  test("takes model only from configuration and rejects a model tool argument", () => {
    const request = buildTextToImageRequest(options(), { prompt: "asset" })
    expect(request.model).toBe("configured/model-id")

    const error = getPluginError(() =>
      buildTextToImageRequest(options(), {
        prompt: "asset",
        model: "attacker/selected-model",
      } as unknown as GenerateImageArgs),
    )
    expect(error.code).toBe("GENIMAGE_PARAMETER_UNSUPPORTED")
  })

  test("preserves prompt text exactly while rejecting empty and oversized prompts", () => {
    const prompt = "  Keep this spacing and wording exactly.  "
    expect(buildTextToImageRequest(options(), { prompt }).prompt).toBe(prompt)

    for (const invalidPrompt of ["   ", "x".repeat(32_001)]) {
      const error = getPluginError(() =>
        buildTextToImageRequest(options(), { prompt: invalidPrompt }),
      )
      expect(error.code).toBe("GENIMAGE_PARAMETER_UNSUPPORTED")
    }
  })

  test("requires at least one image-to-image reference", () => {
    const error = getPluginError(() =>
      buildImageToImageRequest(options(), { prompt: "edit" }, []),
    )

    expect(error.code).toBe("GENIMAGE_REFERENCE_REQUIRED")
  })

  test("enforces the configured reference count", () => {
    const restricted = resolvePluginOptions(
      {
        routing: "direct",
        model: "configured/model-id",
        apiKey: "generation-key",
        input: { maxReferences: 1 },
      },
      {},
    )
    const error = getPluginError(() =>
      buildImageToImageRequest(restricted, { prompt: "edit" }, REFERENCES),
    )

    expect(error.code).toBe("GENIMAGE_TOO_MANY_REFERENCES")
    expect(error.details).toEqual({ maxReferences: 1 })
  })
})
