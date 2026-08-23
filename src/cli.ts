#!/usr/bin/env node

import { createHash, randomUUID } from "node:crypto"
import { constants, realpathSync } from "node:fs"
import {
  copyFile,
  lstat,
  mkdir,
  readFile,
  realpath,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises"
import { homedir } from "node:os"
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const SKILL_NAME = "openrouter-image-generation"
const SKILL_RELATIVE_PATH = join(
  ".opencode",
  "skills",
  SKILL_NAME,
  "SKILL.md",
)
const GLOBAL_SKILL_RELATIVE_PATH = join(
  ".config",
  "opencode",
  "skills",
  SKILL_NAME,
  "SKILL.md",
)

const USAGE = `Usage:
  openrouter-genimage-kote-opencode install-skill [--global] [--force]
  openrouter-genimage-kote-opencode check-skill [--global]

Options:
  --global  Use ~/.config/opencode instead of the current project.
  --force   Replace a modified installed skill (install-skill only).
  -h, --help  Show this help.`

type CliCommand = "check-skill" | "install-skill"

interface ParsedArguments {
  command: CliCommand
  force: boolean
  global: boolean
}

export interface CliRuntime {
  cwd?: string
  homeDirectory?: string
  packageRoot?: string
  stderr?: (line: string) => void
  stdout?: (line: string) => void
}

export interface SkillPaths {
  source: string
  target: string
  targetRoot: string
}

export type InstallSkillResult = "current" | "installed" | "updated"
export type CheckSkillResult = "current" | "missing" | "modified"

class UsageError extends Error {}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error
}

function packageRootFromModule(): string {
  return fileURLToPath(new URL("../", import.meta.url))
}

export function resolveSkillPaths(
  global: boolean,
  runtime: Pick<CliRuntime, "cwd" | "homeDirectory" | "packageRoot"> = {},
): SkillPaths {
  const packageRoot = resolve(runtime.packageRoot ?? packageRootFromModule())
  const targetRoot = global
    ? resolve(runtime.homeDirectory ?? homedir())
    : resolve(runtime.cwd ?? process.cwd())

  return {
    source: join(packageRoot, SKILL_RELATIVE_PATH),
    target: join(
      targetRoot,
      global ? GLOBAL_SKILL_RELATIVE_PATH : SKILL_RELATIVE_PATH,
    ),
    targetRoot,
  }
}

function isPathInside(root: string, candidate: string): boolean {
  const difference = relative(root, candidate)
  return (
    difference === "" ||
    (difference !== ".." &&
      !difference.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) &&
      !isAbsolute(difference))
  )
}

async function nearestExistingAncestor(candidate: string): Promise<string> {
  let current = resolve(candidate)
  for (;;) {
    try {
      await lstat(current)
      return current
    } catch (error) {
      if (!isNodeError(error) || error.code !== "ENOENT") throw error
      const parent = dirname(current)
      if (parent === current) throw error
      current = parent
    }
  }
}

async function secureTargetPath(
  paths: SkillPaths,
  createParent: boolean,
): Promise<string> {
  const lexicalRoot = resolve(paths.targetRoot)
  const lexicalTarget = resolve(paths.target)
  if (!isPathInside(lexicalRoot, lexicalTarget)) {
    throw new Error("The skill destination escapes its configured root.")
  }

  const canonicalRoot = await realpath(lexicalRoot)
  const targetParent = dirname(lexicalTarget)
  const existingAncestor = await nearestExistingAncestor(targetParent)
  const canonicalAncestor = await realpath(existingAncestor)
  if (!isPathInside(canonicalRoot, canonicalAncestor)) {
    throw new Error(
      "The skill destination resolves outside its configured root through a symbolic link or junction.",
    )
  }

  if (createParent) await mkdir(targetParent, { recursive: true })

  try {
    const canonicalParent = await realpath(targetParent)
    if (!isPathInside(canonicalRoot, canonicalParent)) {
      throw new Error(
        "The skill destination resolves outside its configured root through a symbolic link or junction.",
      )
    }
    const secureTarget = join(canonicalParent, basename(lexicalTarget))
    try {
      const targetStats = await lstat(secureTarget)
      if (targetStats.isSymbolicLink()) {
        throw new Error("Refusing to read or replace a symbolic-link skill destination.")
      }
    } catch (error) {
      if (!isNodeError(error) || error.code !== "ENOENT") throw error
    }
    return secureTarget
  } catch (error) {
    if (!isNodeError(error) || error.code !== "ENOENT" || createParent) throw error
    return lexicalTarget
  }
}

function sha256(content: Uint8Array): string {
  return createHash("sha256").update(content).digest("hex")
}

async function readOptional(path: string): Promise<Buffer | undefined> {
  try {
    return await readFile(path)
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return undefined
    }

    throw error
  }
}

async function copyWithoutOverwrite(
  source: string,
  target: string,
): Promise<void> {
  try {
    await copyFile(source, target, constants.COPYFILE_EXCL)
  } catch (error) {
    if (!isNodeError(error) || error.code !== "EEXIST") {
      throw error
    }

    const [sourceContent, targetContent] = await Promise.all([
      readFile(source),
      readFile(target),
    ])
    if (sha256(sourceContent) !== sha256(targetContent)) {
      throw new Error(
        "The destination appeared during installation and differs from the packaged skill. Run the command again after reviewing it.",
      )
    }
  }
}

async function replaceAtomically(
  target: string,
  content: Uint8Array,
): Promise<void> {
  const temporary = join(
    dirname(target),
    `.${SKILL_NAME}-${process.pid}-${randomUUID()}.tmp`,
  )

  try {
    await writeFile(temporary, content, { flag: "wx", mode: 0o644 })
    await rename(temporary, target)
  } catch (error) {
    try {
      await unlink(temporary)
    } catch (cleanupError) {
      if (!isNodeError(cleanupError) || cleanupError.code !== "ENOENT") {
        throw new AggregateError(
          [error, cleanupError],
          "Failed to replace the skill and clean up its temporary file.",
        )
      }
    }

    throw error
  }
}

export async function installSkill(
  paths: SkillPaths,
  force: boolean,
): Promise<InstallSkillResult> {
  const sourceContent = await readFile(paths.source)
  const target = await secureTargetPath(paths, true)
  const targetContent = await readOptional(target)

  if (
    targetContent !== undefined &&
    sha256(sourceContent) === sha256(targetContent)
  ) {
    return "current"
  }

  if (targetContent !== undefined && !force) {
    throw new Error(
      "The destination contains a modified skill. Refusing to overwrite it without --force.",
    )
  }

  if (targetContent === undefined) {
    await copyWithoutOverwrite(paths.source, target)
    return "installed"
  }

  await replaceAtomically(target, sourceContent)
  return "updated"
}

export async function checkSkill(paths: SkillPaths): Promise<CheckSkillResult> {
  const target = await secureTargetPath(paths, false)
  const [sourceContent, targetContent] = await Promise.all([
    readFile(paths.source),
    readOptional(target),
  ])

  if (targetContent === undefined) {
    return "missing"
  }

  return sha256(sourceContent) === sha256(targetContent)
    ? "current"
    : "modified"
}

function parseArguments(arguments_: readonly string[]): ParsedArguments | null {
  if (arguments_.includes("--help") || arguments_.includes("-h")) {
    return null
  }

  const [command, ...flags] = arguments_
  if (command !== "install-skill" && command !== "check-skill") {
    throw new UsageError(
      command === undefined
        ? "A command is required."
        : `Unknown command: ${command}`,
    )
  }

  for (const flag of flags) {
    if (flag !== "--global" && flag !== "--force") {
      throw new UsageError(`Unknown option: ${flag}`)
    }
  }

  const force = flags.includes("--force")
  if (command === "check-skill" && force) {
    throw new UsageError("--force is only valid with install-skill.")
  }

  return {
    command,
    force,
    global: flags.includes("--global"),
  }
}

function formatFailure(error: unknown): string {
  if (error instanceof Error) {
    return error.message
  }

  return "Unknown CLI error."
}

export async function runCli(
  arguments_: readonly string[],
  runtime: CliRuntime = {},
): Promise<number> {
  const stdout = runtime.stdout ?? ((line: string) => console.log(line))
  const stderr = runtime.stderr ?? ((line: string) => console.error(line))

  try {
    const parsed = parseArguments(arguments_)
    if (parsed === null) {
      stdout(USAGE)
      return 0
    }

    const paths = resolveSkillPaths(parsed.global, runtime)
    stdout(`Source: ${paths.source}`)
    stdout(`Destination: ${paths.target}`)

    if (parsed.command === "install-skill") {
      const result = await installSkill(paths, parsed.force)
      if (result === "current") {
        stdout("Skill is already current; no files were changed.")
      } else if (result === "installed") {
        stdout("Skill installed.")
      } else {
        stdout("Skill updated with --force.")
      }

      return 0
    }

    const result = await checkSkill(paths)
    if (result === "current") {
      stdout("Skill status: current (SHA-256 matches the packaged skill).")
      return 0
    }

    if (result === "missing") {
      stderr("Skill status: missing. Run install-skill to install it.")
    } else {
      stderr(
        "Skill status: modified. Review it or run install-skill --force to restore the packaged version.",
      )
    }

    return 1
  } catch (error) {
    stderr(`Error: ${formatFailure(error)}`)
    if (error instanceof UsageError) {
      stderr(USAGE)
      return 2
    }

    return 1
  }
}

function isDirectExecution(): boolean {
  const entrypoint = process.argv[1]
  if (entrypoint === undefined) {
    return false
  }

  const modulePath = fileURLToPath(import.meta.url)
  try {
    return realpathSync(entrypoint) === realpathSync(modulePath)
  } catch {
    return resolve(entrypoint) === resolve(modulePath)
  }
}

if (isDirectExecution()) {
  void runCli(process.argv.slice(2)).then((exitCode) => {
    process.exitCode = exitCode
  })
}
