import { describe, expect, test } from "bun:test"

import { resolvePluginOptions } from "../../src/config/resolve.js"
import type { ResolvedPluginOptions } from "../../src/config/types.js"
import { noopLogger, type SafeLogger } from "../../src/logging.js"
import {
  ModelCapabilityService,
  type ModelDiscoveryClient,
} from "../../src/openrouter/capabilities.js"
import { PluginError } from "../../src/openrouter/errors.js"
import type {
  ImageModel,
  ImageModelEndpoints,
  SupportedParameters,
} from "../../src/openrouter/models.js"
import type { OpenRouterImageRequest } from "../../src/openrouter/schemas.js"

const MODEL_ID = "vendor/image-model"
const SIGNAL = new AbortController().signal

const IMAGE_PARAMETERS: SupportedParameters = {
  input_references: { type: "range", min: 1, max: 16 },
  n: { type: "range", min: 1, max: 10 },
  resolution: { type: "enum", values: ["1K", "2K"] },
}

interface ModelOverrides {
  endpoints?: string
  inputModalities?: readonly string[]
  outputModalities?: readonly string[]
  supportedParameters?: SupportedParameters
}

function imageModel(overrides: ModelOverrides = {}): ImageModel {
  return {
    id: MODEL_ID,
    architecture: {
      input_modalities: overrides.inputModalities ?? ["text", "image"],
      output_modalities: overrides.outputModalities ?? ["image"],
    },
    supported_parameters: overrides.supportedParameters ?? IMAGE_PARAMETERS,
    ...(overrides.endpoints === undefined
      ? {}
      : { endpoints: overrides.endpoints }),
  }
}

function pluginOptions(
  overrides: Partial<ResolvedPluginOptions> = {},
): ResolvedPluginOptions {
  return {
    ...resolvePluginOptions(
      {
        routing: "direct",
        model: MODEL_ID,
        apiKey: "generation-key-a",
        modelCacheTtlMs: 100,
      },
      {},
    ),
    ...overrides,
  }
}

class DiscoveryClientFake implements ModelDiscoveryClient {
  modelCalls = 0
  endpointCalls = 0
  readonly endpointPaths: string[] = []

  constructor(
    readonly models: ImageModel[],
    readonly endpointResponse?: ImageModelEndpoints,
  ) {}

  listImageModels(signal: AbortSignal): Promise<ImageModel[]> {
    void signal
    this.modelCalls += 1
    return Promise.resolve(this.models)
  }

  listImageModelEndpoints(
    path: string,
    signal: AbortSignal,
  ): Promise<ImageModelEndpoints> {
    void signal
    this.endpointCalls += 1
    this.endpointPaths.push(path)
    if (this.endpointResponse === undefined) {
      return Promise.reject(new Error("Unexpected endpoint capability lookup"))
    }
    return Promise.resolve(this.endpointResponse)
  }
}

function request(
  overrides: Partial<OpenRouterImageRequest> = {},
): OpenRouterImageRequest {
  return {
    model: MODEL_ID,
    prompt: "Keep the subject and alter only the pose",
    ...overrides,
  }
}

function service(
  client: ModelDiscoveryClient,
  options = pluginOptions(),
  now: () => number = Date.now,
  logger: SafeLogger = noopLogger,
): ModelCapabilityService {
  return new ModelCapabilityService({
    client,
    pluginOptions: options,
    logger,
    now,
  })
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

describe("model capability validation", () => {
  test("rejects a configured model that discovery does not return", async () => {
    const client = new DiscoveryClientFake([
      { ...imageModel(), id: "another/image-model" },
    ])

    const error = await pluginError(
      service(client).validate("generate", request(), SIGNAL),
    )

    expect(error.code).toBe("GENIMAGE_MODEL_NOT_FOUND")
    expect(error.details).toEqual({ model: MODEL_ID })
    expect(client.modelCalls).toBe(1)
  })

  test("does not allow the request to replace the configured model", async () => {
    const client = new DiscoveryClientFake([imageModel()])

    const error = await pluginError(
      service(client).validate(
        "generate",
        request({ model: "attacker/selected-model" }),
        SIGNAL,
      ),
    )

    expect(error.code).toBe("GENIMAGE_CONFIG_INVALID")
    expect(client.modelCalls).toBe(0)
  })

  test("accepts text-to-image when image output is present", async () => {
    const model = imageModel({
      inputModalities: ["text"],
      supportedParameters: {
        n: { type: "range", min: 1, max: 4 },
      },
    })
    const client = new DiscoveryClientFake([model])

    const validated = await service(client).validate(
      "generate",
      request({ n: 1 }),
      SIGNAL,
    )

    expect(validated).toBe(model)
  })

  test("accepts image-to-image with image input and input_references", async () => {
    const model = imageModel()
    const client = new DiscoveryClientFake([model])

    const validated = await service(client).validate(
      "edit",
      request({
        input_references: [
          {
            type: "image_url",
            image_url: { url: "data:image/png;base64,iVBORw0KGgo=" },
          },
        ],
        n: 1,
        resolution: "1K",
      }),
      SIGNAL,
    )

    expect(validated).toBe(model)
  })

  test("rejects a model without image input before a paid edit request", async () => {
    const client = new DiscoveryClientFake([
      imageModel({ inputModalities: ["text"] }),
    ])

    const error = await pluginError(
      service(client).validate(
        "edit",
        request({ input_references: [] }),
        SIGNAL,
      ),
    )

    expect(error.code).toBe("GENIMAGE_MODEL_DOES_NOT_SUPPORT_IMAGE_INPUT")
    expect(error.details).toEqual({ model: MODEL_ID })
  })

  test("rejects a model without image output for every operation", async () => {
    for (const operation of ["generate", "edit"] as const) {
      const client = new DiscoveryClientFake([
        imageModel({ outputModalities: ["text"] }),
      ])

      const error = await pluginError(
        service(client).validate(operation, request(), SIGNAL),
      )

      expect(error.code).toBe("GENIMAGE_MODEL_DOES_NOT_SUPPORT_IMAGE_OUTPUT")
      expect(error.details).toEqual({ model: MODEL_ID })
    }
  })

  test("maps unsupported input_references to the image-input error", async () => {
    const client = new DiscoveryClientFake([
      imageModel({
        supportedParameters: {
          n: { type: "range", min: 1, max: 10 },
        },
      }),
    ])

    const error = await pluginError(
      service(client).validate(
        "edit",
        request({
          input_references: [
            {
              type: "image_url",
              image_url: { url: "https://example.test/reference.png" },
            },
          ],
        }),
        SIGNAL,
      ),
    )

    expect(error.code).toBe("GENIMAGE_MODEL_DOES_NOT_SUPPORT_IMAGE_INPUT")
    expect(error.details).toEqual({
      model: MODEL_ID,
      parameter: "input_references",
    })
  })

  test("rejects unsupported n and resolution with the exact parameter", async () => {
    const cases: {
      expectedParameter: string
      request: Partial<OpenRouterImageRequest>
    }[] = [
      { expectedParameter: "n", request: { n: 5 } },
      { expectedParameter: "resolution", request: { resolution: "4K" } },
    ]

    for (const testCase of cases) {
      const supportedParameters =
        testCase.expectedParameter === "n"
          ? {
              ...IMAGE_PARAMETERS,
              n: { type: "range" as const, min: 1, max: 4 },
            }
          : IMAGE_PARAMETERS
      const error = await pluginError(
        service(
          new DiscoveryClientFake([
            imageModel({ supportedParameters }),
          ]),
        ).validate(
          "generate",
          request(testCase.request),
          SIGNAL,
        ),
      )

      expect(error.code).toBe("GENIMAGE_PARAMETER_UNSUPPORTED")
      expect(error.details).toEqual({
        model: MODEL_ID,
        parameter: testCase.expectedParameter,
      })
    }
  })

  test("does not combine incompatible capabilities from different endpoints", async () => {
    const endpointPath = "/api/v1/images/models/vendor%2Fimage-model/endpoints"
    const client = new DiscoveryClientFake(
      [imageModel({ endpoints: endpointPath })],
      {
        id: MODEL_ID,
        endpoints: [
          {
            supported_parameters: {
              n: { type: "enum", values: [1] },
              resolution: { type: "enum", values: ["1K"] },
            },
          },
          {
            supported_parameters: {
              n: { type: "enum", values: [2] },
              resolution: { type: "enum", values: ["2K"] },
            },
          },
        ],
      },
    )

    const error = await pluginError(
      service(client).validate(
        "generate",
        request({ n: 1, resolution: "2K" }),
        SIGNAL,
      ),
    )

    expect(error.code).toBe("GENIMAGE_PARAMETER_UNSUPPORTED")
    expect(error.details).toEqual({
      model: MODEL_ID,
      parameter: "parameter combination",
    })
    expect(client.endpointPaths).toEqual([endpointPath])
  })

  test("resolves routing and catalog variants without changing the request model", async () => {
    const endpointPath = "/api/v1/images/models/vendor%2Fimage-model/endpoints"
    const cases = [
      { configured: `${MODEL_ID}:nitro`, catalog: MODEL_ID },
      { configured: `${MODEL_ID}:floor:exacto`, catalog: MODEL_ID },
      { configured: `${MODEL_ID}:free:nitro`, catalog: `${MODEL_ID}:free` },
    ]

    for (const testCase of cases) {
      const client = new DiscoveryClientFake(
        [{ ...imageModel({ endpoints: endpointPath }), id: testCase.catalog }],
        {
          id: testCase.catalog,
          endpoints: [{ supported_parameters: IMAGE_PARAMETERS }],
        },
      )
      const validated = await service(
        client,
        pluginOptions({ model: testCase.configured }),
      ).validate("generate", request({ model: testCase.configured, n: 1 }), SIGNAL)

      expect(validated.id).toBe(testCase.catalog)
      expect(client.endpointPaths).toEqual([endpointPath])
    }
  })

  test("treats quality and compression as ignorable only when unadvertised", async () => {
    const unadvertised = new DiscoveryClientFake([
      imageModel({ supportedParameters: { n: { type: "range", min: 1, max: 10 } } }),
    ])
    await service(unadvertised).validate(
      "generate",
      request({ quality: "max", output_compression: 80 }),
      SIGNAL,
    )

    const advertised = new DiscoveryClientFake([
      imageModel({
        supportedParameters: {
          quality: { type: "enum", values: ["high"] },
          output_compression: { type: "range", min: 0, max: 100 },
        },
      }),
    ])
    const error = await pluginError(
      service(advertised).validate("generate", request({ quality: "max" }), SIGNAL),
    )
    expect(error.code).toBe("GENIMAGE_PARAMETER_UNSUPPORTED")
    expect(error.details).toEqual({ model: MODEL_ID, parameter: "quality" })
  })

  test("uses the cache until its TTL expires", async () => {
    let now = 1_000
    const client = new DiscoveryClientFake([imageModel()])
    const capabilities = service(client, pluginOptions(), () => now)

    await capabilities.validate("generate", request(), SIGNAL)
    now = 1_099
    await capabilities.validate("generate", request(), SIGNAL)
    expect(client.modelCalls).toBe(1)

    now = 1_100
    await capabilities.validate("generate", request(), SIGNAL)
    expect(client.modelCalls).toBe(2)
  })

  test("shares discovery without coupling concurrent caller cancellation", async () => {
    let resolveModels: ((models: ImageModel[]) => void) | undefined
    let modelCalls = 0
    const client: ModelDiscoveryClient = {
      listImageModels() {
        modelCalls += 1
        return new Promise<ImageModel[]>((resolve) => {
          resolveModels = resolve
        })
      },
      listImageModelEndpoints() {
        return Promise.reject(new Error("Unexpected endpoint lookup"))
      },
    }
    const capabilities = service(client)
    const firstController = new AbortController()
    const secondController = new AbortController()
    const first = capabilities.validate(
      "generate",
      request(),
      firstController.signal,
    )
    const second = capabilities.validate(
      "generate",
      request(),
      secondController.signal,
    )
    const reason = new DOMException("second caller cancelled", "AbortError")
    secondController.abort(reason)

    expect(await captureError(second)).toBe(reason)
    expect(modelCalls).toBe(1)
    if (resolveModels === undefined) throw new Error("Discovery did not start")
    resolveModels([imageModel()])
    expect((await first).id).toBe(MODEL_ID)
  })

  test("scopes cache entries by API-key fingerprint without logging either key", async () => {
    const options = pluginOptions()
    const client = new DiscoveryClientFake([imageModel()])
    const logs: string[] = []
    const logger: SafeLogger = {
      log(_level, message, fields) {
        logs.push(JSON.stringify({ message, fields }))
      },
    }
    const capabilities = service(client, options, () => 1_000, logger)

    await capabilities.validate("generate", request(), SIGNAL)
    options.apiKey = "generation-key-b"
    await capabilities.validate("generate", request(), SIGNAL)
    options.apiKey = "generation-key-a"
    await capabilities.validate("generate", request(), SIGNAL)

    expect(client.modelCalls).toBe(2)
    expect(logs.join("\n")).not.toContain("generation-key-a")
    expect(logs.join("\n")).not.toContain("generation-key-b")
  })
})
