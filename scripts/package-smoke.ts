import { spawn } from "node:child_process"
import { realpathSync } from "node:fs"
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, dirname, join, relative, resolve, sep } from "node:path"
import { fileURLToPath } from "node:url"

import { runOpenCodeSmoke } from "./opencode-smoke.js"

const PACKAGE_NAME = "openrouter-genimage-kote-opencode"
const TEMPORARY_PREFIX = "openrouter-genimage-package-smoke-"
const MAX_COMMAND_OUTPUT_BYTES = 2 * 1024 * 1024
const COMMAND_TIMEOUT_MS = 180_000
const defaultPackageRoot = resolve(
  fileURLToPath(new URL("../", import.meta.url)),
)

interface CommandResult {
  readonly exitCode: number
  readonly stderr: string
  readonly stdout: string
}

interface PackFile {
  readonly path: string
}

interface CommandInvocation {
  readonly arguments: readonly string[]
  readonly command: string
}

function commandEnvironment(): NodeJS.ProcessEnv {
  const environment = { ...process.env }
  delete environment.OPENROUTER_API_KEY
  delete environment.OPENROUTER_MANAGEMENT_API_KEY
  delete environment.RUN_OPENROUTER_E2E
  return environment
}

function runCommand(
  command: string,
  arguments_: readonly string[],
  options: {
    readonly cwd: string
    readonly env?: NodeJS.ProcessEnv
    readonly timeoutMs?: number
  },
): Promise<CommandResult> {
  return new Promise((resolveCommand, reject) => {
    const child = spawn(command, arguments_, {
      cwd: options.cwd,
      env: options.env ?? commandEnvironment(),
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    })
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    let outputBytes = 0
    let outputExceeded = false
    let timedOut = false

    const append = (target: Buffer[], chunk: Buffer): void => {
      outputBytes += chunk.byteLength
      if (outputBytes > MAX_COMMAND_OUTPUT_BYTES) {
        outputExceeded = true
        child.kill()
        return
      }
      target.push(chunk)
    }
    child.stdout.on("data", (chunk: Buffer) => append(stdout, chunk))
    child.stderr.on("data", (chunk: Buffer) => append(stderr, chunk))
    child.once("error", reject)

    const timeout = setTimeout(() => {
      timedOut = true
      child.kill()
    }, options.timeoutMs ?? COMMAND_TIMEOUT_MS)

    child.once("close", (code, signal) => {
      clearTimeout(timeout)
      if (timedOut) {
        reject(new Error(`${command} timed out.`))
        return
      }
      if (outputExceeded) {
        reject(new Error(`${command} exceeded the smoke-test output limit.`))
        return
      }
      if (code === null) {
        reject(new Error(`${command} terminated by signal ${signal ?? "unknown"}.`))
        return
      }
      resolveCommand({
        exitCode: code,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      })
    })
  })
}

function requireSuccessful(result: CommandResult, description: string): void {
  if (result.exitCode === 0) return
  const diagnostic = result.stderr.trim().slice(0, 2_000)
  throw new Error(
    `${description} failed with exit code ${result.exitCode}.${
      diagnostic.length === 0 ? "" : ` ${diagnostic}`
    }`,
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function parsePackFiles(stdout: string): { filename: string; files: PackFile[] } {
  let parsed: unknown
  try {
    parsed = JSON.parse(stdout) as unknown
  } catch (error) {
    throw new Error("npm pack did not return valid JSON metadata.", {
      cause: error,
    })
  }

  if (!Array.isArray(parsed) || parsed.length !== 1 || !isRecord(parsed[0])) {
    throw new Error("npm pack returned an unexpected result count.")
  }
  const record = parsed[0]
  if (typeof record.filename !== "string" || !Array.isArray(record.files)) {
    throw new Error("npm pack metadata is missing filename or files.")
  }

  const files: PackFile[] = record.files.map((value) => {
    if (!isRecord(value) || typeof value.path !== "string") {
      throw new Error("npm pack metadata contains an invalid file record.")
    }
    return { path: value.path.replaceAll("\\", "/") }
  })
  return { filename: record.filename, files }
}

function verifyPackFileList(files: readonly PackFile[]): void {
  const paths = new Set(files.map((file) => file.path))
  const required = [
    "package.json",
    "dist/server.js",
    "dist/server.d.ts",
    "dist/cli.js",
    "dist/cli.d.ts",
    ".opencode/skills/openrouter-image-generation/SKILL.md",
    "docs/architecture.md",
    "docs/configuration.md",
    "docs/image-to-image.md",
    "docs/security.md",
    "docs/testing.md",
    "docs/troubleshooting.md",
    "schema/plugin-options.schema.json",
    "README.md",
    "README.ru.md",
    "LICENSE",
    "SECURITY.md",
    "THIRD_PARTY_NOTICES.md",
    "CHANGELOG.md",
  ]
  for (const path of required) {
    if (!paths.has(path)) throw new Error(`npm tarball is missing ${path}.`)
  }

  const forbiddenPrefixes = [
    "src/",
    "tests/",
    "scripts/",
    ".github/",
    ".npm/",
    ".npm-cache/",
    "node_modules/",
  ]
  for (const path of paths) {
    if (
      forbiddenPrefixes.some((prefix) => path.startsWith(prefix)) ||
      path === ".env" ||
      path.startsWith(".env.") ||
      path === ".npmrc" ||
      path.endsWith(".tgz")
    ) {
      throw new Error(`npm tarball contains forbidden development file ${path}.`)
    }
  }
}

async function listFiles(root: string, directory = root): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true })
  const result: string[] = []
  for (const entry of entries) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) {
      result.push(...(await listFiles(root, path)))
    } else if (entry.isFile()) {
      result.push(path)
    } else {
      throw new Error(
        `Installed package contains unsupported entry ${relative(root, path)}.`,
      )
    }
  }
  return result
}

function genericSecretFinding(content: string): string | undefined {
  const checks: readonly [RegExp, string][] = [
    [/sk-or-v1-[A-Za-z0-9_-]{20,}/u, "an OpenRouter-style API key"],
    [
      /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/u,
      "a private key",
    ],
    [
      /data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/]{128,}={0,2}/u,
      "a large embedded image payload",
    ],
    [
      /generation-secret|management-secret|private-prompt|cHJpdmF0ZS1pbWFnZQ==/u,
      "a test credential or private fixture",
    ],
  ]
  return checks.find(([pattern]) => pattern.test(content))?.[1]
}

async function verifyInstalledPackageHasNoSecrets(
  installedPackage: string,
): Promise<void> {
  const environmentSecrets = [
    process.env.OPENROUTER_API_KEY,
    process.env.OPENROUTER_MANAGEMENT_API_KEY,
  ].filter(
    (value): value is string => value !== undefined && value.trim().length >= 8,
  )

  for (const path of await listFiles(installedPackage)) {
    const packagePath = relative(installedPackage, path).split(sep).join("/")
    const lowerPath = packagePath.toLowerCase()
    if (
      lowerPath.split("/").some((part) => part === ".env") ||
      lowerPath.endsWith(".pem") ||
      lowerPath.endsWith(".key")
    ) {
      throw new Error(`Installed package contains sensitive file ${packagePath}.`)
    }

    const content = await readFile(path)
    for (const secret of environmentSecrets) {
      if (content.includes(Buffer.from(secret))) {
        throw new Error(
          `Installed package contains an environment credential in ${packagePath}.`,
        )
      }
    }

    const finding = genericSecretFinding(content.toString("utf8"))
    if (finding !== undefined) {
      throw new Error(`Installed package contains ${finding} in ${packagePath}.`)
    }
  }
}

function nodeImportProbe(): string {
  return `
const originalFetch = globalThis.fetch
let networkCalls = 0
const blockedFetch = async () => {
  networkCalls += 1
  throw new Error("Network access during package import is forbidden")
}
globalThis.fetch = blockedFetch
try {
  const packageRoot = await import(${JSON.stringify(PACKAGE_NAME)})
  const serverEntry = await import(${JSON.stringify(`${PACKAGE_NAME}/server`)})
  await new Promise((resolve) => setImmediate(resolve))
  if (networkCalls !== 0) throw new Error("Package import attempted a network request")
  if (globalThis.fetch !== blockedFetch) throw new Error("Package import replaced global fetch")
  for (const [name, imported] of [["package root", packageRoot], ["server subpath", serverEntry]]) {
    if (typeof imported.server !== "function") throw new Error(name + " named server export is missing")
    if (typeof imported.default !== "object" || imported.default === null) {
      throw new Error(name + " default plugin-module export is missing")
    }
  }
  process.stdout.write("import-ok\\n")
} finally {
  globalThis.fetch = originalFetch
}
`
}

function nodeBinary(): string | undefined {
  const configured = process.env.NODE_BINARY?.trim()
  if (configured !== undefined && configured.length > 0) return configured
  return Bun.which("node") ?? undefined
}

async function verifyNodeImport(installRoot: string): Promise<void> {
  const executable = nodeBinary()
  if (executable === undefined) {
    throw new Error("Node.js is required for the package import smoke test.")
  }

  const version = await runCommand(executable, ["--version"], {
    cwd: installRoot,
  })
  requireSuccessful(version, "Node.js version check")
  const majorMatch = /^v(\d+)\./u.exec(version.stdout.trim())
  if (majorMatch?.[1] === undefined || Number(majorMatch[1]) < 20) {
    throw new Error(`Node.js 20 or newer is required; got ${version.stdout.trim()}.`)
  }

  const probePath = join(installRoot, "import-probe.mjs")
  await writeFile(probePath, nodeImportProbe())
  const result = await runCommand(executable, [probePath], {
    cwd: installRoot,
  })
  requireSuccessful(result, "Installed package import")
  if (result.stdout.trim() !== "import-ok") {
    throw new Error("Installed package import returned unexpected output.")
  }
}

async function verifyCliSkillInstall(
  installedPackage: string,
  installRoot: string,
  temporaryRoot: string,
): Promise<void> {
  const project = join(temporaryRoot, "skill-project")
  await mkdir(project, { recursive: true })
  const bin = join(
    installRoot,
    "node_modules",
    ".bin",
    process.platform === "win32" ? `${PACKAGE_NAME}.cmd` : PACKAGE_NAME,
  )
  const invocation =
    process.platform === "win32"
      ? {
          command: process.env.ComSpec ?? "cmd.exe",
          arguments: ["/d", "/s", "/c", bin],
        }
      : { command: bin, arguments: [] }
  const install = await runCommand(
    invocation.command,
    [...invocation.arguments, "install-skill"],
    {
      cwd: project,
    },
  )
  requireSuccessful(install, "Packaged skill installation")

  const packagedSkill = join(
    installedPackage,
    ".opencode",
    "skills",
    "openrouter-image-generation",
    "SKILL.md",
  )
  const installedSkill = join(
    project,
    ".opencode",
    "skills",
    "openrouter-image-generation",
    "SKILL.md",
  )
  const [packagedContent, installedContent] = await Promise.all([
    readFile(packagedSkill),
    readFile(installedSkill),
  ])
  if (!packagedContent.equals(installedContent)) {
    throw new Error("Packaged CLI installed a modified skill.")
  }

  const check = await runCommand(
    invocation.command,
    [...invocation.arguments, "check-skill"],
    { cwd: project },
  )
  requireSuccessful(check, "Packaged skill verification")
}

function npmInvocation(): CommandInvocation {
  const configured = process.env.NPM_BINARY?.trim()
  if (configured !== undefined && configured.length > 0) {
    return { command: configured, arguments: [] }
  }

  const npm = Bun.which("npm")
  if (npm === null) throw new Error("npm is required for package smoke tests.")
  if (process.platform !== "win32" || !npm.toLowerCase().endsWith(".cmd")) {
    return { command: npm, arguments: [] }
  }

  const node = Bun.which("node")
  if (node === null) throw new Error("Node.js is required to run npm.")
  return {
    command: node,
    arguments: [join(dirname(npm), "node_modules", "npm", "bin", "npm-cli.js")],
  }
}

function assertSafeTemporaryRoot(path: string): void {
  if (!basename(path).startsWith(TEMPORARY_PREFIX)) {
    throw new Error("Refusing to clean an unexpected package-smoke directory.")
  }
}

function npmCacheDirectory(temporaryRoot: string): string {
  const configured = process.env.PACKAGE_SMOKE_NPM_CACHE?.trim()
  if (configured !== undefined && configured.length > 0) {
    return resolve(configured)
  }

  return join(temporaryRoot, "npm-cache")
}

export async function runPackageSmoke(
  packageRoot = defaultPackageRoot,
): Promise<void> {
  const normalizedRoot = resolve(packageRoot)
  await Promise.all([
    access(join(normalizedRoot, "package.json")),
    access(join(normalizedRoot, "dist", "server.js")),
    access(join(normalizedRoot, "dist", "cli.js")),
  ])

  const temporaryRoot = await mkdtemp(join(tmpdir(), TEMPORARY_PREFIX))
  assertSafeTemporaryRoot(temporaryRoot)
  try {
    const packDirectory = join(temporaryRoot, "pack")
    const installRoot = join(temporaryRoot, "install")
    await Promise.all([
      mkdir(packDirectory, { recursive: true }),
      mkdir(installRoot, { recursive: true }),
    ])
    await writeFile(
      join(installRoot, "package.json"),
      JSON.stringify({ private: true, type: "module" }),
    )
    const npm = npmInvocation()
    const npmCache = npmCacheDirectory(temporaryRoot)

    const pack = await runCommand(
      npm.command,
      [
        ...npm.arguments,
        "pack",
        "--json",
        "--ignore-scripts",
        "--pack-destination",
        packDirectory,
        "--cache",
        npmCache,
      ],
      { cwd: normalizedRoot },
    )
    requireSuccessful(pack, "npm pack")
    const metadata = parsePackFiles(pack.stdout)
    verifyPackFileList(metadata.files)
    if (basename(metadata.filename) !== metadata.filename) {
      throw new Error("npm pack returned an unsafe tarball filename.")
    }

    const tarball = join(packDirectory, metadata.filename)
    await access(tarball)
    const install = await runCommand(
      npm.command,
      [
        ...npm.arguments,
        "install",
        "--ignore-scripts",
        "--no-audit",
        "--no-fund",
        "--no-package-lock",
        "--save-exact",
        "--prefer-offline",
        "--cache",
        npmCache,
        tarball,
      ],
      { cwd: installRoot },
    )
    requireSuccessful(install, "tarball installation")

    const installedPackage = join(installRoot, "node_modules", PACKAGE_NAME)
    await Promise.all([
      access(join(installedPackage, "package.json")),
      access(
        join(
          installRoot,
          "node_modules",
          ".bin",
          process.platform === "win32" ? `${PACKAGE_NAME}.cmd` : PACKAGE_NAME,
        ),
      ),
    ])
    await verifyInstalledPackageHasNoSecrets(installedPackage)
    await verifyNodeImport(installRoot)
    await verifyCliSkillInstall(installedPackage, installRoot, temporaryRoot)
    await runOpenCodeSmoke(installedPackage)

    console.log(
      `Package smoke passed: ${metadata.filename} contains ${metadata.files.length} files.`,
    )
  } finally {
    assertSafeTemporaryRoot(temporaryRoot)
    await rm(temporaryRoot, { recursive: true, force: true })
  }
}

function isDirectExecution(): boolean {
  const entrypoint = process.argv[1]
  if (entrypoint === undefined) return false
  const modulePath = fileURLToPath(import.meta.url)
  try {
    return realpathSync(entrypoint) === realpathSync(modulePath)
  } catch {
    return resolve(entrypoint) === resolve(modulePath)
  }
}

if (isDirectExecution()) {
  try {
    await runPackageSmoke()
  } catch (error) {
    console.error(
      error instanceof Error ? error.message : "Package smoke test failed.",
    )
    process.exitCode = 1
  }
}
