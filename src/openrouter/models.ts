export type CapabilityDescriptor =
  | { type: "boolean" }
  | { type: "enum"; values: readonly (string | number)[] }
  | { type: "range"; min: number; max: number }

export type SupportedParameters = Readonly<Record<string, CapabilityDescriptor>>

export interface ImageModel {
  id: string
  name?: string
  architecture: {
    input_modalities: readonly string[]
    output_modalities: readonly string[]
  }
  supported_parameters: SupportedParameters
  endpoints?: string
  supports_streaming?: boolean
}

export interface ImageModelEndpoint {
  provider_name?: string
  provider_slug?: string
  provider_tag?: string | null
  supported_parameters: SupportedParameters
  supports_streaming?: boolean
}

export interface ImageModelEndpoints {
  id: string
  endpoints: readonly ImageModelEndpoint[]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function parseFiniteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

function parseCapability(value: unknown): CapabilityDescriptor | undefined {
  if (!isRecord(value)) return undefined

  if (value.type === "boolean") return { type: "boolean" }

  if (value.type === "enum" && Array.isArray(value.values)) {
    const values = value.values.filter(
      (entry): entry is string | number =>
        typeof entry === "string" ||
        (typeof entry === "number" && Number.isFinite(entry)),
    )
    return values.length === value.values.length
      ? { type: "enum", values }
      : undefined
  }

  const min = parseFiniteNumber(value.min)
  const max = parseFiniteNumber(value.max)
  if (value.type === "range" && min !== undefined && max !== undefined && min <= max) {
    return { type: "range", min, max }
  }

  return undefined
}

function parseSupportedParameters(value: unknown): SupportedParameters {
  if (!isRecord(value)) return {}

  const result: Record<string, CapabilityDescriptor> = {}
  for (const [name, descriptor] of Object.entries(value)) {
    const parsed = parseCapability(descriptor)
    if (parsed !== undefined) result[name] = parsed
  }
  return result
}

function parseModalities(value: unknown): readonly string[] {
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
    return []
  }
  return value
}

function parseImageModel(value: unknown): ImageModel | undefined {
  if (!isRecord(value) || typeof value.id !== "string" || !isRecord(value.architecture)) {
    return undefined
  }

  return {
    id: value.id,
    ...(typeof value.name === "string" ? { name: value.name } : {}),
    architecture: {
      input_modalities: parseModalities(value.architecture.input_modalities),
      output_modalities: parseModalities(value.architecture.output_modalities),
    },
    supported_parameters: parseSupportedParameters(value.supported_parameters),
    ...(typeof value.endpoints === "string" ? { endpoints: value.endpoints } : {}),
    ...(typeof value.supports_streaming === "boolean"
      ? { supports_streaming: value.supports_streaming }
      : {}),
  }
}

export function parseImageModelsResponse(value: unknown): ImageModel[] {
  if (!isRecord(value) || !Array.isArray(value.data)) {
    throw new TypeError("OpenRouter image-model response has an invalid shape.")
  }

  const models = value.data.map(parseImageModel)
  if (models.some((model) => model === undefined)) {
    throw new TypeError("OpenRouter image-model response contains an invalid record.")
  }
  return models as ImageModel[]
}

function parseEndpoint(value: unknown): ImageModelEndpoint | undefined {
  if (!isRecord(value)) return undefined
  return {
    ...(typeof value.provider_name === "string"
      ? { provider_name: value.provider_name }
      : {}),
    ...(typeof value.provider_slug === "string"
      ? { provider_slug: value.provider_slug }
      : {}),
    ...(typeof value.provider_tag === "string" || value.provider_tag === null
      ? { provider_tag: value.provider_tag }
      : {}),
    supported_parameters: parseSupportedParameters(value.supported_parameters),
    ...(typeof value.supports_streaming === "boolean"
      ? { supports_streaming: value.supports_streaming }
      : {}),
  }
}

export function parseImageModelEndpointsResponse(value: unknown): ImageModelEndpoints {
  if (!isRecord(value) || typeof value.id !== "string" || !Array.isArray(value.endpoints)) {
    throw new TypeError("OpenRouter image endpoint response has an invalid shape.")
  }

  const endpoints = value.endpoints.map(parseEndpoint)
  if (endpoints.some((endpoint) => endpoint === undefined)) {
    throw new TypeError("OpenRouter image endpoint response contains an invalid record.")
  }
  return { id: value.id, endpoints: endpoints as ImageModelEndpoint[] }
}

export function capabilitySupports(
  descriptor: CapabilityDescriptor | undefined,
  value: string | number | boolean | readonly unknown[],
): boolean {
  if (descriptor === undefined) return false
  if (descriptor.type === "boolean") return true
  if (descriptor.type === "enum") return descriptor.values.includes(value as string | number)
  const numericValue = Array.isArray(value) ? value.length : value
  return (
    typeof numericValue === "number" &&
    Number.isFinite(numericValue) &&
    numericValue >= descriptor.min &&
    numericValue <= descriptor.max
  )
}
