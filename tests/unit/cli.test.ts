import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

import { resolveSkillPaths, runCli } from "../../src/cli.js"

const packageRoot = resolve(fileURLToPath(new URL("../..", import.meta.url)))

interface CapturedRun {
  code: number
  stderr: string[]
  stdout: string[]
}

async function run(
  arguments_: readonly string[],
  cwd: string,
  homeDirectory: string,
): Promise<CapturedRun> {
  const stdout: string[] = []
  const stderr: string[] = []
  const code = await runCli(arguments_, {
    cwd,
    homeDirectory,
    packageRoot,
    stderr: (line) => stderr.push(line),
    stdout: (line) => stdout.push(line),
  })

  return { code, stderr, stdout }
}

describe("skill CLI", () => {
  let temporaryRoot: string
  let projectRoot: string
  let homeDirectory: string

  beforeEach(async () => {
    temporaryRoot = await mkdtemp(join(tmpdir(), "openrouter-genimage-cli-"))
    projectRoot = join(temporaryRoot, "project with spaces")
    homeDirectory = join(temporaryRoot, "home with spaces")
    await Promise.all([
      mkdir(projectRoot, { recursive: true }),
      mkdir(homeDirectory, { recursive: true }),
    ])
  })

  afterEach(async () => {
    await rm(temporaryRoot, { force: true, recursive: true })
  })

  test("installs the packaged skill into the current project", async () => {
    const paths = resolveSkillPaths(false, {
      cwd: projectRoot,
      homeDirectory,
      packageRoot,
    })

    const result = await run(["install-skill"], projectRoot, homeDirectory)

    expect(result.code).toBe(0)
    expect(result.stderr).toEqual([])
    expect(result.stdout).toContain(`Source: ${paths.source}`)
    expect(result.stdout).toContain(`Destination: ${paths.target}`)
    expect(await readFile(paths.target)).toEqual(await readFile(paths.source))
  })

  test("treats an identical installation as a no-op", async () => {
    const paths = resolveSkillPaths(false, {
      cwd: projectRoot,
      packageRoot,
    })
    expect(
      (await run(["install-skill"], projectRoot, homeDirectory)).code,
    ).toBe(0)

    const oldTimestamp = new Date("2001-02-03T04:05:06.000Z")
    await utimes(paths.target, oldTimestamp, oldTimestamp)
    const before = await stat(paths.target, { bigint: true })

    const result = await run(["install-skill"], projectRoot, homeDirectory)
    const after = await stat(paths.target, { bigint: true })

    expect(result.code).toBe(0)
    expect(result.stdout.at(-1)).toContain("no files were changed")
    expect(after.mtimeNs).toBe(before.mtimeNs)
  })

  test("does not overwrite a modified skill without --force", async () => {
    const paths = resolveSkillPaths(false, {
      cwd: projectRoot,
      packageRoot,
    })
    await mkdir(dirname(paths.target), { recursive: true })
    const customSkill = "custom user skill\n"
    await writeFile(paths.target, customSkill)

    const result = await run(["install-skill"], projectRoot, homeDirectory)

    expect(result.code).toBe(1)
    expect(result.stderr.join("\n")).toContain("without --force")
    expect(await readFile(paths.target, "utf8")).toBe(customSkill)
  })

  test("replaces a modified skill only with --force", async () => {
    const paths = resolveSkillPaths(false, {
      cwd: projectRoot,
      packageRoot,
    })
    await mkdir(dirname(paths.target), { recursive: true })
    await writeFile(paths.target, "custom user skill\n")

    const result = await run(
      ["install-skill", "--force"],
      projectRoot,
      homeDirectory,
    )

    expect(result.code).toBe(0)
    expect(result.stdout.at(-1)).toContain("updated with --force")
    expect(await readFile(paths.target)).toEqual(await readFile(paths.source))
  })

  test("uses ~/.config/opencode for a global installation", async () => {
    const paths = resolveSkillPaths(true, {
      cwd: projectRoot,
      homeDirectory,
      packageRoot,
    })

    const installResult = await run(
      ["install-skill", "--global"],
      projectRoot,
      homeDirectory,
    )
    const checkResult = await run(
      ["check-skill", "--global"],
      projectRoot,
      homeDirectory,
    )

    expect(paths.target).toBe(
      join(
        homeDirectory,
        ".config",
        "opencode",
        "skills",
        "openrouter-image-generation",
        "SKILL.md",
      ),
    )
    expect(installResult.code).toBe(0)
    expect(checkResult.code).toBe(0)
    expect(checkResult.stdout.at(-1)).toContain("SHA-256 matches")
  })

  test("reports a missing skill without creating directories", async () => {
    const paths = resolveSkillPaths(false, {
      cwd: projectRoot,
      packageRoot,
    })

    const result = await run(["check-skill"], projectRoot, homeDirectory)

    expect(result.code).toBe(1)
    expect(result.stderr.at(-1)).toContain("missing")
    expect(Bun.file(paths.target).exists()).resolves.toBe(false)
    expect(Bun.file(dirname(paths.target)).exists()).resolves.toBe(false)
  })

  test("detects same-size modified content by hash", async () => {
    const paths = resolveSkillPaths(false, {
      cwd: projectRoot,
      packageRoot,
    })
    expect(
      (await run(["install-skill"], projectRoot, homeDirectory)).code,
    ).toBe(0)
    const packaged = await readFile(paths.source)
    const modified = Buffer.from(packaged)
    modified[modified.length - 1] =
      modified[modified.length - 1] === 0x0a ? 0x20 : 0x0a
    await writeFile(paths.target, modified)

    const result = await run(["check-skill"], projectRoot, homeDirectory)

    expect(result.code).toBe(1)
    expect(result.stderr.at(-1)).toContain("modified")
    expect((await stat(paths.target)).size).toBe((await stat(paths.source)).size)
  })

  test("does not use the network or require an OpenRouter key", async () => {
    const originalFetch = globalThis.fetch
    let fetchCalls = 0
    globalThis.fetch = (() => {
      fetchCalls += 1
      throw new Error("network access is forbidden in the CLI")
    }) as unknown as typeof fetch

    try {
      const result = await run(
        ["install-skill"],
        projectRoot,
        homeDirectory,
      )
      expect(result.code).toBe(0)
      expect(fetchCalls).toBe(0)
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test("rejects a skill directory junction that escapes the project", async () => {
    const outside = join(temporaryRoot, "outside")
    await mkdir(outside, { recursive: true })
    await symlink(
      outside,
      join(projectRoot, ".opencode"),
      process.platform === "win32" ? "junction" : "dir",
    )

    const result = await run(["install-skill"], projectRoot, homeDirectory)

    expect(result.code).toBe(1)
    expect(result.stderr.join("\n")).toContain("outside its configured root")
    expect(
      Bun.file(
        join(outside, "skills", "openrouter-image-generation", "SKILL.md"),
      ).exists(),
    ).resolves.toBe(false)
  })

  test("rejects unknown commands and invalid flag combinations", async () => {
    const unknownCommand = await run(["wat"], projectRoot, homeDirectory)
    const unknownOption = await run(
      ["install-skill", "--wat"],
      projectRoot,
      homeDirectory,
    )
    const forceCheck = await run(
      ["check-skill", "--force"],
      projectRoot,
      homeDirectory,
    )

    expect(unknownCommand.code).toBe(2)
    expect(unknownOption.code).toBe(2)
    expect(forceCheck.code).toBe(2)
    expect(forceCheck.stderr.join("\n")).toContain(
      "--force is only valid with install-skill",
    )
  })

  test("prints help without touching the filesystem", async () => {
    const result = await run(["--help"], projectRoot, homeDirectory)

    expect(result.code).toBe(0)
    expect(result.stdout.join("\n")).toContain("install-skill")
    expect(result.stdout.join("\n")).toContain("check-skill")
  })
})
