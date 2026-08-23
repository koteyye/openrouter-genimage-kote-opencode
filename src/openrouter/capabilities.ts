import { createHash } from "node:crypto"

import type { ResolvedPluginOptions } from "../config/types.js"
import type { SafeLogger } from "../logging.js"
import { abortablePromise, throwIfAborted } from "../utils/abort.js"
import { PluginError } from "./errors.js"
import {
  capabilitySupports,
  type ImageModel,
  type ImageModelEndpoints,
  type SupportedParameters,
} from "./models.js"
import type { OpenRouterImageRequest } from "./schemas.js"

export type ImageOperation = "edit" | "generate"

export interface ModelDiscoveryClient {
  listImageModels(signal: AbortSignal): Promise<ImageModel[]>
  listImageModelEndpoints(
    path: string,
    signal: AbortSignal,
  ): Promise<ImageModelEndpoints>
}

interface CapabilityRecord {
  model: ImageModel
  parameterSets: readonly SupportedParameters[]
  expiresAt: number
}

interface InflightCapabilityRecord {
  controller: AbortController
  promise: Promise<CapabilityRecord>
}

export interface ModelCapabilityServiceOptions {
  client: ModelDiscoveryClient
  pluginOptions: ResolvedPluginOptions
  logger: SafeLogger
  now?: () => number
}

function apiKeyFingerprint(apiKey: string): string {
  return createHash("sha256").update(apiKey).digest("hex").slice(0, 12)
}

function parameterEntries(
  request: OpenRouterImageRequest,
): Array<readonly [string, string | number | boolean | readonly unknown[]]> {
  const result: Array<
    readonly [string, string | number | boolean | readonly unknown[]]
  > = []
  const fields = [
    "input_references",
    "n",
    "resolution",
    "aspect_ratio",
    "quality",
    "background",
    "output_format",
    "output_compression",
    "seed",
  ] as const

  for (const field of fields) {
    const value = request[field]
    if (value !== undefined) result.push([field, value])
  }
  return result
}

function supportsAllParameters(
  supported: SupportedParameters,
  parameters: ReturnType<typeof parameterEntries>,
): boolean {
  return parameters.every(([name, value]) =>
    capabilitySupports(supported[name], value),
  )
}

export class ModelCapabilityService {
  readonly #client: ModelDiscoveryClient
  readonly #options: ResolvedPluginOptions
  readonly #logger: SafeLogger
  readonly #now: () => number
  readonly #cache = new Map<string, CapabilityRecord>()
  readonly #inflight = new Map<string, InflightCapabilityRecord>()
  #generation = 0

  constructor(options: ModelCapabilityServiceOptions) {
    this.#client = options.client
    this.#options = options.pluginOptions
    this.#logger = options.logger
    this.#now = options.now ?? Date.now
  }

  async validate(
    operation: ImageOperation,
    request: OpenRouterImageRequest,
    signal: AbortSignal,
  ): Promise<ImageModel> {
    if (request.model !== this.#options.model) {
      throw new PluginError(
        "GENIMAGE_CONFIG_INVALID",
        "The image model must come from plugin configuration.",
      )
    }

    const record = await this.#getRecord(signal)
    const { model } = record

    if (!model.architecture.output_modalities.includes("image")) {
      throw new PluginError(
        "GENIMAGE_MODEL_DOES_NOT_SUPPORT_IMAGE_OUTPUT",
        `The configured model does not support image output.`,
        { details: { model: model.id } },
      )
    }

    if (
      operation === "edit" &&
      !model.architecture.input_modalities.includes("image")
    ) {
      throw new PluginError(
        "GENIMAGE_MODEL_DOES_NOT_SUPPORT_IMAGE_INPUT",
        "The configured model does not support image input.",
        { details: { model: model.id } },
      )
    }

    const parameters = parameterEntries(request)
    if (record.parameterSets.some((set) => supportsAllParameters(set, parameters))) {
      return model
    }

    const definitelyUnsupported = parameters.find(([name, value]) =>
      record.parameterSets.every(
        (set) => !capabilitySupports(set[name], value),
      ),
    )

    if (operation === "edit" && definitelyUnsupported?.[0] === "input_references") {
      throw new PluginError(
        "GENIMAGE_MODEL_DOES_NOT_SUPPORT_IMAGE_INPUT",
        "The configured model does not support input references.",
        { details: { model: model.id, parameter: "input_references" } },
      )
    }

    const parameter = definitelyUnsupported?.[0] ?? "parameter combination"
    throw new PluginError(
      "GENIMAGE_PARAMETER_UNSUPPORTED",
      `The configured model does not support the requested ${parameter}.`,
      { details: { model: model.id, parameter } },
    )
  }

  clear(): void {
    this.#generation += 1
    this.#cache.clear()
    for (const pending of this.#inflight.values()) {
      pending.controller.abort(
        new DOMException("Capability discovery was disposed", "AbortError"),
      )
    }
    this.#inflight.clear()
  }

  async #getRecord(signal: AbortSignal): Promise<CapabilityRecord> {
    throwIfAborted(signal)
    const key = `${this.#options.model}:${apiKeyFingerprint(this.#options.apiKey)}`
    const cached = this.#cache.get(key)
    if (cached !== undefined && cached.expiresAt > this.#now()) {
      this.#logger.log("debug", "Using cached OpenRouter image-model capabilities.", {
        model: this.#options.model,
        cacheStatus: "hit",
      })
      return cached
    }

    this.#logger.log("debug", "Loading OpenRouter image-model capabilities.", {
      model: this.#options.model,
      cacheStatus: cached === undefined ? "miss" : "expired",
    })
    if (cached !== undefined) this.#cache.delete(key)

    let pending = this.#inflight.get(key)
    if (pending === undefined) {
      const controller = new AbortController()
      const generation = this.#generation
      const promise = this.#loadRecord(controller.signal).then((record) => {
        if (generation === this.#generation) this.#cache.set(key, record)
        return record
      })
      pending = { controller, promise }
      this.#inflight.set(key, pending)
      const cleanup = () => {
        if (this.#inflight.get(key) === pending) this.#inflight.delete(key)
      }
      void promise.then(cleanup, cleanup)
    }
    return abortablePromise(pending.promise, signal)
  }

  async #loadRecord(signal: AbortSignal): Promise<CapabilityRecord> {
    const models = await this.#client.listImageModels(signal)
    const model = models.find((candidate) => candidate.id === this.#options.model)
    if (model === undefined) {
      throw new PluginError(
        "GENIMAGE_MODEL_NOT_FOUND",
        "The configured OpenRouter image model was not found.",
        { details: { model: this.#options.model } },
      )
    }

    let parameterSets: readonly SupportedParameters[] = [
      model.supported_parameters,
    ]
    if (model.endpoints !== undefined) {
      const endpointResponse = await this.#client.listImageModelEndpoints(
        model.endpoints,
        signal,
      )
      if (endpointResponse.id !== model.id || endpointResponse.endpoints.length === 0) {
        throw new PluginError(
          "GENIMAGE_RESPONSE_INVALID",
          "OpenRouter returned invalid endpoint capabilities for the configured model.",
          { details: { model: model.id } },
        )
      }
      parameterSets = endpointResponse.endpoints.map(
        (endpoint) => endpoint.supported_parameters,
      )
    }

    const record: CapabilityRecord = {
      model,
      parameterSets,
      expiresAt: this.#now() + this.#options.modelCacheTtlMs,
    }
    return record
  }
}
