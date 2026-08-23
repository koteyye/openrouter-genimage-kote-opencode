import { describe, expect, test } from "bun:test"
import { readFile } from "node:fs/promises"

import { DEFAULT_OPTIONS } from "../../src/config/schema.js"
import {
  IMAGE_ASPECT_RATIOS,
  IMAGE_BACKGROUNDS,
  IMAGE_OUTPUT_FORMATS,
  IMAGE_QUALITIES,
  IMAGE_RESOLUTIONS,
  ROUTING_MODES,
} from "../../src/config/types.js"

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`)
  }
  return value as Record<string, unknown>
}

function property(
  properties: Record<string, unknown>,
  name: string,
): Record<string, unknown> {
  return record(properties[name], `property ${name}`)
}

describe("published plugin-options JSON Schema", () => {
  test("stays aligned with runtime options, enums, defaults, and strictness", async () => {
    const parsed = JSON.parse(
      await readFile(
        new URL("../../schema/plugin-options.schema.json", import.meta.url),
        "utf8",
      ),
    ) as unknown
    const schema = record(parsed, "schema")
    const properties = record(schema.properties, "properties")

    expect(schema.additionalProperties).toBe(false)
    expect(schema.required).toEqual(["routing", "model"])
    expect(Object.keys(properties).sort()).toEqual(
      [
        "apiKey",
        "defaults",
        "input",
        "managementApiKey",
        "maxDecodedBytes",
        "maxResponseBytes",
        "model",
        "modelCacheTtlMs",
        "outputDirectory",
        "requestTimeoutMs",
        "routing",
      ].sort(),
    )
    expect(property(properties, "routing").enum).toEqual([...ROUTING_MODES])

    for (const credential of ["apiKey", "managementApiKey"]) {
      const definition = property(properties, credential)
      expect(definition.maxLength).toBe(4_096)
      expect(definition.pattern).toBe(
        "^(?=.*\\S)[^\\u0000-\\u001F\\u007F]+$",
      )
    }

    const defaults = property(properties, "defaults")
    expect(defaults.additionalProperties).toBe(false)
    const generation = record(defaults.properties, "defaults.properties")
    expect(property(generation, "background").enum).toEqual([
      ...IMAGE_BACKGROUNDS,
    ])
    expect(property(generation, "output_format").enum).toEqual([
      ...IMAGE_OUTPUT_FORMATS,
    ])
    expect(property(generation, "quality").enum).toEqual([...IMAGE_QUALITIES])
    expect(property(generation, "resolution").enum).toEqual([
      ...IMAGE_RESOLUTIONS,
    ])
    expect(property(generation, "n").default).toBe(DEFAULT_OPTIONS.defaults.n)

    const definitions = record(schema.$defs, "$defs")
    expect(property(definitions, "imageAspectRatio").enum).toEqual([
      ...IMAGE_ASPECT_RATIOS,
    ])

    const input = property(properties, "input")
    expect(input.additionalProperties).toBe(false)
    const inputProperties = record(input.properties, "input.properties")
    expect(property(inputProperties, "maxReferences").default).toBe(
      DEFAULT_OPTIONS.input.maxReferences,
    )
    expect(property(inputProperties, "maxReferences").maximum).toBe(16)
    expect(property(inputProperties, "maxFileBytes").default).toBe(
      DEFAULT_OPTIONS.input.maxFileBytes,
    )
    expect(property(inputProperties, "maxTotalBytes").default).toBe(
      DEFAULT_OPTIONS.input.maxTotalBytes,
    )
    expect(property(properties, "requestTimeoutMs").default).toBe(
      DEFAULT_OPTIONS.requestTimeoutMs,
    )
    expect(property(properties, "modelCacheTtlMs").default).toBe(
      DEFAULT_OPTIONS.modelCacheTtlMs,
    )
    expect(property(properties, "maxResponseBytes").default).toBe(
      DEFAULT_OPTIONS.maxResponseBytes,
    )
    expect(property(properties, "maxDecodedBytes").default).toBe(
      DEFAULT_OPTIONS.maxDecodedBytes,
    )
  })
})
