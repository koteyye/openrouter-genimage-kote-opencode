import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { pathToFileURL } from "node:url"

import { PluginError } from "../../src/openrouter/errors.js"
import {
  decodeStrictBase64,
  loadProjectImage,
  parseImageDataUrl,
  resolveImageReferences,
  validatePublicHttpsUrl,
  type OpenCodeMessageClient,
} from "../../src/references/index.js"

const PNG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 1, 2, 3])
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 1])

const temporaryDirectories: string[] = []

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "genimage-reference-"))
  temporaryDirectories.push(directory)
  return directory
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  )
})

function messageClient(parts: Array<Record<string, unknown>>): OpenCodeMessageClient {
  return {
    session: {
      async message(options) {
        if (options.path.messageID === "assistant") {
          return {
            data: {
              info: { role: "assistant", parentID: "user" },
              parts: [],
            },
          }
        }
        return {
          data: {
            info: { role: "user" },
            parts,
          },
        }
      },
    },
  } as OpenCodeMessageClient
}

function toolContext(worktree: string) {
  return {
    sessionID: "session",
    messageID: "assistant",
    directory: worktree,
    worktree,
    abort: new AbortController().signal,
  }
}

const limits = {
  maxReferences: 16,
  maxFileBytes: 1_024,
  maxTotalBytes: 4_096,
}

describe("strict image data URLs", () => {
  test("normalizes a valid PNG data URL", () => {
    const value = `data:image/png;base64,${PNG.toString("base64")}`
    const result = parseImageDataUrl(value, 1_024)
    expect(result.bytes).toEqual(PNG)
    expect(result.detected.format).toBe("png")
    expect(result.dataUrl).toBe(value)
  })

  test("rejects invalid base64 instead of using Buffer's lenient decoder", () => {
    expect(() => decodeStrictBase64("AAAA!!!!")).toThrow(PluginError)
  })

  test("rejects a declared MIME that disagrees with magic bytes", () => {
    const value = `data:image/png;base64,${JPEG.toString("base64")}`
    expect(() => parseImageDataUrl(value)).toThrow(
      expect.objectContaining({ code: "GENIMAGE_REFERENCE_INVALID" }),
    )
  })

  test("never includes base64 in a validation error", () => {
    const secretPayload = "A".repeat(48) + "!"
    try {
      decodeStrictBase64(secretPayload)
      throw new Error("expected decoder failure")
    } catch (error) {
      expect(String(error)).not.toContain(secretPayload)
    }
  })
})

describe("project files", () => {
  test("reads by magic bytes and leaves the source unchanged", async () => {
    const worktree = await temporaryDirectory()
    await mkdir(path.join(worktree, "assets"))
    const source = path.join(worktree, "assets", "looks-like-text.bin")
    await writeFile(source, PNG)

    const before = await readFile(source)
    const loaded = await loadProjectImage(
      worktree,
      "assets/looks-like-text.bin",
      1_024,
      new AbortController().signal,
    )
    const after = await readFile(source)

    expect(loaded.detected.format).toBe("png")
    expect(after).toEqual(before)
  })

  test.each(["../outside.png", "/tmp/outside.png", "C:\\outside.png", "\\\\server\\share\\x.png"])(
    "rejects unsafe path %s",
    async (unsafePath) => {
      const worktree = await temporaryDirectory()
      await expect(
        loadProjectImage(
          worktree,
          unsafePath,
          1_024,
          new AbortController().signal,
        ),
      ).rejects.toMatchObject({ code: "GENIMAGE_REFERENCE_NOT_FOUND" })
    },
  )

  test("rejects a symlink or junction that escapes the worktree", async () => {
    const worktree = await temporaryDirectory()
    const outside = await temporaryDirectory()
    await writeFile(path.join(outside, "outside.png"), PNG)
    const link = path.join(worktree, "escape")
    try {
      await symlink(
        outside,
        link,
        process.platform === "win32" ? "junction" : "dir",
      )
    } catch {
      return
    }

    await expect(
      loadProjectImage(
        worktree,
        "escape/outside.png",
        1_024,
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: "GENIMAGE_REFERENCE_NOT_FOUND" })
  })
})

describe("reference resolution", () => {
  test("uses all current user image attachments and preserves image-only order", async () => {
    const worktree = await temporaryDirectory()
    const first = `data:image/png;base64,${PNG.toString("base64")}`
    const second = `data:image/jpeg;base64,${JPEG.toString("base64")}`
    const client = messageClient([
      { type: "file", mime: "application/pdf", url: "data:application/pdf;base64,AA==" },
      { type: "file", mime: "image/png", url: first },
      { type: "text", text: "not an attachment" },
      { type: "file", mime: "image/jpeg", url: second },
    ])

    const result = await resolveImageReferences({
      references: undefined,
      context: toolContext(worktree),
      client,
      serverUrl: new URL("http://127.0.0.1:4096"),
      limits,
      promptLength: 10,
    })

    expect(result.inputReferences.map((reference) => reference.image_url.url)).toEqual([
      first,
      second,
    ])
  })

  test("preserves an explicit mixed project/URL/attachment order", async () => {
    const worktree = await temporaryDirectory()
    await writeFile(path.join(worktree, "source.png"), PNG)
    const attachment = `data:image/jpeg;base64,${JPEG.toString("base64")}`

    const result = await resolveImageReferences({
      references: [
        { type: "project_file", path: "source.png" },
        { type: "https_url", url: "https://example.com/reference.webp?token=opaque" },
        { type: "message_attachment", index: 1 },
      ],
      context: toolContext(worktree),
      client: messageClient([
        { type: "file", mime: "image/jpeg", url: attachment },
      ]),
      serverUrl: new URL("http://127.0.0.1:4096"),
      limits,
      promptLength: 20,
    })

    expect(result.references.map((reference) => reference.source)).toEqual([
      "project_file",
      "https_url",
      "message_attachment",
    ])
    expect(result.inputReferences[1]?.image_url.url).toBe(
      "https://example.com/reference.webp?token=opaque",
    )
  })

  test("reads a trusted attachment file URL without changing the source", async () => {
    const worktree = await temporaryDirectory()
    const source = path.join(worktree, "attachment.png")
    await writeFile(source, PNG)

    const result = await resolveImageReferences({
      references: [{ type: "message_attachment", index: 1 }],
      context: toolContext(worktree),
      client: messageClient([
        {
          type: "file",
          mime: "image/png",
          url: pathToFileURL(source).href,
        },
      ]),
      serverUrl: new URL("http://127.0.0.1:4096"),
      limits,
      promptLength: 1,
    })

    expect(result.localBytes).toBe(PNG.byteLength)
    expect(result.inputReferences[0]?.image_url.url).toBe(
      `data:image/png;base64,${PNG.toString("base64")}`,
    )
    expect(await readFile(source)).toEqual(PNG)
  })

  test("fetches a same-origin OpenCode-managed attachment with a bounded request", async () => {
    const worktree = await temporaryDirectory()
    const calls: Array<{ init?: RequestInit; url: string }> = []
    const managedUrl = "http://127.0.0.1:4096/session/attachment/1"

    const result = await resolveImageReferences({
      references: [{ type: "message_attachment", index: 1 }],
      context: toolContext(worktree),
      client: messageClient([
        { type: "file", mime: "image/png", url: managedUrl },
      ]),
      serverUrl: new URL("http://127.0.0.1:4096"),
      limits,
      promptLength: 1,
      fetch: (async (input, init) => {
        calls.push({
          url: input instanceof Request ? input.url : input.toString(),
          ...(init === undefined ? {} : { init }),
        })
        return new Response(PNG, {
          status: 200,
          headers: {
            "content-length": String(PNG.byteLength),
            "content-type": "image/png",
          },
        })
      }) as typeof fetch,
    })

    expect(calls).toHaveLength(1)
    expect(calls[0]?.url).toBe(managedUrl)
    expect(calls[0]?.init?.redirect).toBe("manual")
    expect(result.inputReferences[0]?.image_url.url).toBe(
      `data:image/png;base64,${PNG.toString("base64")}`,
    )
  })

  test("requires an attachment and validates attachment indexes", async () => {
    const worktree = await temporaryDirectory()
    const base = {
      context: toolContext(worktree),
      client: messageClient([]),
      serverUrl: new URL("http://127.0.0.1:4096"),
      limits,
      promptLength: 1,
    }
    await expect(
      resolveImageReferences({ ...base, references: undefined }),
    ).rejects.toMatchObject({ code: "GENIMAGE_REFERENCE_REQUIRED" })
    await expect(
      resolveImageReferences({
        ...base,
        references: [{ type: "message_attachment", index: 1 }],
      }),
    ).rejects.toMatchObject({ code: "GENIMAGE_REFERENCE_INDEX_INVALID" })
  })

  test("enforces total local byte limits without dropping references", async () => {
    const worktree = await temporaryDirectory()
    const attachment = `data:image/png;base64,${PNG.toString("base64")}`
    await expect(
      resolveImageReferences({
        references: undefined,
        context: toolContext(worktree),
        client: messageClient([
          { type: "file", mime: "image/png", url: attachment },
          { type: "file", mime: "image/png", url: attachment },
        ]),
        serverUrl: new URL("http://127.0.0.1:4096"),
        limits: { ...limits, maxTotalBytes: PNG.byteLength },
        promptLength: 1,
      }),
    ).rejects.toMatchObject({
      code: "GENIMAGE_TOTAL_REFERENCE_SIZE_EXCEEDED",
    })
  })

  test("rejects more than sixteen references before resolving them", async () => {
    const worktree = await temporaryDirectory()
    await expect(
      resolveImageReferences({
        references: Array.from({ length: 17 }, (_, index) => ({
          type: "https_url" as const,
          url: `https://example.com/reference-${index}.png`,
        })),
        context: toolContext(worktree),
        client: messageClient([]),
        serverUrl: new URL("http://127.0.0.1:4096"),
        limits,
        promptLength: 1,
      }),
    ).rejects.toMatchObject({ code: "GENIMAGE_TOO_MANY_REFERENCES" })
  })

  test("rejects an individually oversized project file", async () => {
    const worktree = await temporaryDirectory()
    await writeFile(path.join(worktree, "large.png"), PNG)

    await expect(
      resolveImageReferences({
        references: [{ type: "project_file", path: "large.png" }],
        context: toolContext(worktree),
        client: messageClient([]),
        serverUrl: new URL("http://127.0.0.1:4096"),
        limits: { ...limits, maxFileBytes: PNG.byteLength - 1 },
        promptLength: 1,
      }),
    ).rejects.toMatchObject({ code: "GENIMAGE_REFERENCE_TOO_LARGE" })
  })

  test("rejects unsupported attachment MIME and invalid magic bytes", async () => {
    const worktree = await temporaryDirectory()
    const base = {
      references: [{ type: "message_attachment" as const, index: 1 }],
      context: toolContext(worktree),
      serverUrl: new URL("http://127.0.0.1:4096"),
      limits,
      promptLength: 1,
    }

    await expect(
      resolveImageReferences({
        ...base,
        client: messageClient([
          {
            type: "file",
            mime: "image/gif",
            url: "data:image/gif;base64,R0lGODlh",
          },
        ]),
      }),
    ).rejects.toMatchObject({ code: "GENIMAGE_REFERENCE_FORMAT_UNSUPPORTED" })
    await expect(
      resolveImageReferences({
        ...base,
        client: messageClient([
          {
            type: "file",
            mime: "image/png",
            url: `data:image/png;base64,${Buffer.from("not an image").toString("base64")}`,
          },
        ]),
      }),
    ).rejects.toMatchObject({ code: "GENIMAGE_REFERENCE_FORMAT_UNSUPPORTED" })
  })
})

describe("public reference URLs", () => {
  test("allows HTTPS without rewriting it", () => {
    const value = "https://example.com/path/image.png?signature=opaque#frame"
    expect(validatePublicHttpsUrl(value)).toBe(value)
  })

  test.each([
    "http://example.com/image.png",
    "file:///tmp/image.png",
    "data:image/png;base64,AA==",
    "https://user:password@example.com/image.png",
  ])("rejects unsafe URL %s", (value) => {
    expect(() => validatePublicHttpsUrl(value)).toThrow(
      expect.objectContaining({ code: "GENIMAGE_REFERENCE_URL_INVALID" }),
    )
  })
})
