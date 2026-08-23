import { afterAll, describe, expect, test } from "bun:test"
import { Buffer } from "node:buffer"
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

import { PluginError } from "../../src/openrouter/errors.js"
import {
  assertSafeOutputRelativePath,
  createToolAttachments,
  decodeOutputImage,
  decodeOutputImages,
  ImageSaveError,
  saveImages,
  type ValidatedImage,
} from "../../src/output/index.js"
import { detectImageFormat } from "../../src/references/formats.js"

const temporaryRoots: string[] = []

afterAll(async () => {
  await Promise.all(
    temporaryRoots.map(async (root) => {
      await rm(root, { recursive: true, force: true })
    }),
  )
})

async function temporaryWorktree(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "genimage-output-test-"))
  temporaryRoots.push(root)
  return root
}

const PNG_BYTES = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00,
])
const JPEG_BYTES = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00])
const WEBP_BYTES = Buffer.from([
  0x52, 0x49, 0x46, 0x46, 0x04, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50,
])

function validated(bytes: Buffer, warnings: string[] = []): ValidatedImage {
  const detected = detectImageFormat(bytes)
  if (detected === undefined) throw new Error("invalid test fixture")
  return { bytes, detected, warnings }
}

function pluginErrorFrom(action: () => unknown): PluginError {
  let caught: unknown
  try {
    action()
  } catch (error) {
    caught = error
  }
  expect(caught).toBeInstanceOf(PluginError)
  return caught as PluginError
}

async function asyncPluginErrorFrom(
  action: () => Promise<unknown>,
): Promise<PluginError> {
  let caught: unknown
  try {
    await action()
  } catch (error) {
    caught = error
  }
  expect(caught).toBeInstanceOf(PluginError)
  return caught as PluginError
}

describe("output format validation", () => {
  test("decodes raw base64 and classifies bytes by magic", () => {
    const result = decodeOutputImage(
      { b64_json: PNG_BYTES.toString("base64") },
      { maxDecodedBytes: 1024, expectedFormat: "png" },
    )

    expect(result.bytes).toEqual(PNG_BYTES)
    expect(result.detected).toEqual({
      format: "png",
      mime: "image/png",
      extension: ".png",
    })
    expect(result.warnings).toEqual([])
  })

  test("accepts a data URL but trusts actual bytes over declarations", () => {
    const result = decodeOutputImage(
      {
        b64_json: `data:image/png;base64,${JPEG_BYTES.toString("base64")}`,
        media_type: "image/webp",
      },
      { maxDecodedBytes: 1024, expectedFormat: "png", index: 2 },
    )

    expect(result.detected.format).toBe("jpeg")
    expect(result.warnings).toHaveLength(3)
    expect(result.warnings.join("\n")).toContain("bytes are image/jpeg")
    expect(result.warnings.join("\n")).toContain("although PNG was requested")
  })

  test("rejects malformed base64, SVG, empty data, and oversized data", () => {
    const invalid = [
      { b64_json: "%%%" },
      { b64_json: Buffer.from("<svg/>").toString("base64") },
      { b64_json: "" },
      { b64_json: PNG_BYTES.toString("base64"), maximum: 4 },
    ]

    for (const item of invalid) {
      const error = pluginErrorFrom(() =>
        decodeOutputImage(item, {
          maxDecodedBytes: "maximum" in item ? item.maximum : 1024,
        }),
      )
      expect(error.code).toBe("GENIMAGE_IMAGE_INVALID")
    }
  })

  test("keeps valid images from a partially invalid response", () => {
    const result = decodeOutputImages(
      [
        { b64_json: PNG_BYTES.toString("base64") },
        { b64_json: "not base64" },
        { b64_json: WEBP_BYTES.toString("base64") },
      ],
      { maxDecodedBytes: 1024 },
    )

    expect(result.images.map((image) => image.detected.format)).toEqual([
      "png",
      "webp",
    ])
    expect(result.invalidCount).toBe(1)
    expect(result.warnings).toContain(
      "Returned image 2 was invalid and was skipped (GENIMAGE_IMAGE_INVALID).",
    )
  })

  test("fails when a response has no usable image", () => {
    const empty = pluginErrorFrom(() =>
      decodeOutputImages([], { maxDecodedBytes: 1024 }),
    )
    expect(empty.code).toBe("GENIMAGE_RESPONSE_INVALID")

    const invalid = pluginErrorFrom(() =>
      decodeOutputImages([{ b64_json: "invalid" }], {
        maxDecodedBytes: 1024,
      }),
    )
    expect(invalid.code).toBe("GENIMAGE_IMAGE_INVALID")
  })
})

describe("output path confinement", () => {
  test("rejects absolute, drive, UNC, traversal, and control-character paths", () => {
    const invalidPaths = [
      "/tmp/result.png",
      "C:\\temp\\result.png",
      "C:result.png",
      "\\\\server\\share\\result.png",
      "../result.png",
      "assets/../../result.png",
      "assets/result\nforged.png",
      "assets/result\u007f.png",
    ]

    for (const invalidPath of invalidPaths) {
      expect(() => assertSafeOutputRelativePath(invalidPath)).toThrow(PluginError)
    }
    expect(assertSafeOutputRelativePath("assets/generated/result.png")).toBe(
      "assets/generated/result.png",
    )
  })

  test("rejects a parent symlink that resolves outside the worktree", async () => {
    const root = await temporaryWorktree()
    const worktree = path.join(root, "worktree")
    const outside = path.join(root, "outside")
    await mkdir(worktree)
    await mkdir(outside)
    await symlink(
      outside,
      path.join(worktree, "escaped"),
      process.platform === "win32" ? "junction" : "dir",
    )

    const error = await asyncPluginErrorFrom(() =>
      saveImages({
        images: [validated(PNG_BYTES)],
        outputPath: "escaped/result.png",
        outputDirectory: "assets/generated",
        worktree,
      }),
    )
    expect(error.code).toBe("GENIMAGE_OUTPUT_OUTSIDE_WORKTREE")
    expect(await readdir(outside)).toEqual([])
  })
})

describe("atomic image saving", () => {
  test("rejects an empty validated image set", async () => {
    const worktree = await temporaryWorktree()
    const error = await asyncPluginErrorFrom(() =>
      saveImages({
        images: [],
        outputDirectory: "assets/generated",
        worktree,
      }),
    )

    expect(error.code).toBe("GENIMAGE_IMAGE_INVALID")
  })

  test("creates parents and saves an explicit relative path", async () => {
    const worktree = await temporaryWorktree()
    const [saved] = await saveImages({
      images: [validated(PNG_BYTES)],
      outputPath: "nested/icons/potion.png",
      outputDirectory: "unused",
      worktree,
    })

    expect(saved?.relativePath).toBe("nested/icons/potion.png")
    expect(saved?.filename).toBe("potion.png")
    expect(saved?.mime).toBe("image/png")
    expect(saved?.bytes).toBe(PNG_BYTES.byteLength)
    expect(await readFile(path.join(worktree, "nested/icons/potion.png"))).toEqual(
      PNG_BYTES,
    )
  })

  test("uses the actual magic-byte extension and reports a warning", async () => {
    const worktree = await temporaryWorktree()
    const [saved] = await saveImages({
      images: [validated(JPEG_BYTES)],
      outputPath: "assets/requested.png",
      outputDirectory: "unused",
      worktree,
    })

    expect(saved?.relativePath).toBe("assets/requested.jpeg")
    expect(saved?.warnings.join("\n")).toContain("did not match")
    expect(await readFile(path.join(worktree, "assets/requested.jpeg"))).toEqual(
      JPEG_BYTES,
    )
  })

  test("adds stable multi-image suffixes in response order", async () => {
    const worktree = await temporaryWorktree()
    const saved = await saveImages({
      images: [validated(PNG_BYTES), validated(PNG_BYTES), validated(PNG_BYTES)],
      outputPath: "assets/potion.png",
      outputDirectory: "unused",
      worktree,
    })

    expect(saved.map((image) => image.relativePath)).toEqual([
      "assets/potion-01.png",
      "assets/potion-02.png",
      "assets/potion-03.png",
    ])
  })

  test("never overwrites an existing output and uses a collision suffix", async () => {
    const worktree = await temporaryWorktree()
    await mkdir(path.join(worktree, "assets"))
    await writeFile(path.join(worktree, "assets/potion.png"), "keep me")

    const [saved] = await saveImages({
      images: [validated(PNG_BYTES)],
      outputPath: "assets/potion.png",
      outputDirectory: "unused",
      worktree,
    })

    expect(saved?.relativePath).toBe("assets/potion-2.png")
    expect(await readFile(path.join(worktree, "assets/potion.png"), "utf8")).toBe(
      "keep me",
    )
    expect(await readFile(path.join(worktree, "assets/potion-2.png"))).toEqual(
      PNG_BYTES,
    )
  })

  test("atomically continues collision numbering across concurrent saves", async () => {
    const worktree = await temporaryWorktree()
    await mkdir(path.join(worktree, "assets"))
    await writeFile(path.join(worktree, "assets/potion.png"), "original")

    const results = await Promise.all(
      [0x01, 0x02].map(async (marker) =>
        saveImages({
          images: [validated(Buffer.concat([PNG_BYTES, Buffer.from([marker])]))],
          outputPath: "assets/potion.png",
          outputDirectory: "unused",
          worktree,
        }),
      ),
    )
    const relativePaths = results
      .flat()
      .map((image) => image.relativePath)
      .sort()

    expect(relativePaths).toEqual([
      "assets/potion-2.png",
      "assets/potion-3.png",
    ])
    expect(await readFile(path.join(worktree, "assets/potion.png"), "utf8")).toBe(
      "original",
    )
  })

  test("forbids an explicit source path before collision or multi suffixing", async () => {
    const worktree = await temporaryWorktree()
    const source = path.join(worktree, "source.png")
    await writeFile(source, PNG_BYTES)

    for (const images of [
      [validated(PNG_BYTES)],
      [validated(PNG_BYTES), validated(PNG_BYTES)],
    ]) {
      const error = await asyncPluginErrorFrom(() =>
        saveImages({
          images,
          outputPath: "source.png",
          outputDirectory: "unused",
          worktree,
          sourcePaths: [source],
        }),
      )
      expect(error.code).toBe("GENIMAGE_SOURCE_OVERWRITE_FORBIDDEN")
    }
    expect(await readFile(source)).toEqual(PNG_BYTES)
  })

  test("creates deterministic automatic names and leaves no temp file", async () => {
    const worktree = await temporaryWorktree()
    const saved = await saveImages({
      images: [validated(WEBP_BYTES)],
      outputDirectory: "assets/generated",
      worktree,
      now: new Date("2026-08-23T12:34:56.789Z"),
      randomId: () => "abc123",
    })

    expect(saved[0]?.relativePath).toBe(
      "assets/generated/generated-20260823T123456789Z-abc123.webp",
    )
    const entries = await readdir(path.join(worktree, "assets/generated"))
    expect(entries).toEqual([
      "generated-20260823T123456789Z-abc123.webp",
    ])
    expect(entries.some((entry) => entry.endsWith(".tmp"))).toBe(false)
  })

  test("returns file attachments without putting base64 in saved metadata", async () => {
    const worktree = await temporaryWorktree()
    const saved = await saveImages({
      images: [validated(PNG_BYTES)],
      outputPath: "result.png",
      outputDirectory: "unused",
      worktree,
    })
    const attachments = createToolAttachments(saved)

    expect(attachments).toEqual([
      {
        type: "file",
        mime: "image/png",
        filename: "result.png",
        url: `data:image/png;base64,${PNG_BYTES.toString("base64")}`,
      },
    ])
  })

  test("exposes already published files if a later publication fails", () => {
    const underlying = new PluginError(
      "GENIMAGE_OUTPUT_WRITE_FAILED",
      "write failed",
    )
    const partial = new ImageSaveError(underlying, [])

    expect(partial.code).toBe("GENIMAGE_OUTPUT_WRITE_FAILED")
    expect(partial.savedImages).toEqual([])
    expect(partial.details).toEqual({ savedCount: 0 })
  })
})
