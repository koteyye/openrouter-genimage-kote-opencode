import { spawn } from "node:child_process"
import { realpathSync } from "node:fs"
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, join, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

const BASELINE_VERSION = "1.18.21"
const TEMPORARY_PREFIX = "openrouter-genimage-opencode-smoke-"
const MAX_OUTPUT_BYTES = 1024 * 1024
const defaultPackageRoot = resolve(
  fileURLToPath(new URL("../", import.meta.url)),
)

interface CommandResult {
  readonly exitCode: number | null
  readonly stderr: string
  readonly stdout: string
  readonly timedOut: boolean
}

interface SmokeEvidence {
  readonly attachmentClient: boolean
  readonly commandRegistered: boolean
  readonly configApplied: boolean
  readonly context: {
    readonly directory: boolean
    readonly serverUrl: boolean
    readonly worktree: boolean
  }
  readonly permissions: Record<string, unknown>
  readonly toolDefinitionsExecutable: boolean
  readonly tools: string[]
  readonly tupleOptions: boolean
}

export type OpenCodeSmokeOutcome = "passed" | "skipped"

function parsePositiveInteger(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error("OPENCODE_SMOKE_TIMEOUT_MS must be a positive integer.")
  }
  return parsed
}

function runCommand(
  command: string,
  arguments_: readonly string[],
  options: {
    readonly cwd: string
    readonly env: NodeJS.ProcessEnv
    readonly timeoutMs: number
  },
): Promise<CommandResult> {
  return new Promise((resolveCommand, reject) => {
    const child = spawn(command, arguments_, {
      cwd: options.cwd,
      env: options.env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    })
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    let totalBytes = 0
    let outputExceeded = false
    let timedOut = false

    const append = (target: Buffer[], chunk: Buffer): void => {
      totalBytes += chunk.byteLength
      if (totalBytes > MAX_OUTPUT_BYTES) {
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
    }, options.timeoutMs)

    child.once("close", (exitCode) => {
      clearTimeout(timeout)
      if (outputExceeded) {
        reject(new Error("OpenCode exceeded the smoke-test output limit."))
        return
      }
      resolveCommand({
        exitCode,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
        timedOut,
      })
    })
  })
}

function isolatedEnvironment(home: string): NodeJS.ProcessEnv {
  const allowedNames = new Set([
    "PATH",
    "SYSTEMROOT",
    "WINDIR",
    "TEMP",
    "TMP",
    "PATHEXT",
    "COMSPEC",
  ])
  const inherited = Object.fromEntries(
    Object.entries(process.env).filter(([name]) =>
      allowedNames.has(name.toUpperCase()),
    ),
  )
  const environment: NodeJS.ProcessEnv = {
    ...inherited,
    HOME: home,
    USERPROFILE: home,
    XDG_CACHE_HOME: join(home, ".cache"),
    XDG_CONFIG_HOME: join(home, ".config"),
    XDG_DATA_HOME: join(home, ".local", "share"),
    XDG_STATE_HOME: join(home, ".local", "state"),
    OPENCODE_CONFIG_CONTENT: JSON.stringify({ plugin: [] }),
    OPENCODE_DISABLE_AUTOUPDATE: "true",
    OPENCODE_DISABLE_DEFAULT_PLUGINS: "1",
    OPENCODE_DISABLE_EXTERNAL_SKILLS: "1",
    OPENCODE_DISABLE_LSP_DOWNLOAD: "1",
    OPENCODE_DISABLE_MODELS_FETCH: "1",
    OPENCODE_DISABLE_PROJECT_CONFIG: "1",
    NPM_CONFIG_OFFLINE: "true",
    HTTP_PROXY: "http://127.0.0.1:9",
    HTTPS_PROXY: "http://127.0.0.1:9",
    ALL_PROXY: "http://127.0.0.1:9",
    NO_PROXY: "127.0.0.1,localhost",
  }
  return environment
}

function diagnosticSummary(value: string): string {
  const bytes = Buffer.byteLength(value)
  return bytes === 0
    ? "No diagnostic output was emitted."
    : `${bytes} bytes of diagnostic output were suppressed.`
}

async function timedOutEvidenceSummary(evidencePath: string): Promise<string> {
  try {
    const evidence = parseEvidence(
      JSON.parse(await readFile(evidencePath, "utf8")) as unknown,
    )
    return evidence.configApplied
      ? "plugin registration completed before the timeout"
      : "the plugin loaded but its config hook did not complete"
  } catch {
    return "the plugin did not produce registration evidence"
  }
}

function unavailable(reason: string, strict: boolean): OpenCodeSmokeOutcome {
  if (strict) throw new Error(`OpenCode smoke unavailable: ${reason}`)
  console.log(`OpenCode smoke skipped: ${reason}`)
  return "skipped"
}

function parseRuntimeVersion(stdout: string): string | undefined {
  return /(?:^|\s)(\d+\.\d+\.\d+)(?:\s|$)/u.exec(stdout)?.[1]
}

function wrapperSource(serverUrl: string, evidencePath: string): string {
  return `
import { writeFile } from "node:fs/promises"
import { server } from ${JSON.stringify(serverUrl)}

const evidencePath = ${JSON.stringify(evidencePath)}

export const OpenRouterImageSmokePlugin = async (input, options) => {
  const hooks = await server(input, options)
  const tools = Object.entries(hooks.tool ?? {})
  const baseEvidence = {
    tools: tools.map(([name]) => name).sort(),
    toolDefinitionsExecutable: tools.every(([, definition]) => typeof definition.execute === "function"),
    tupleOptions:
      options?.routing === "direct" &&
      options?.model === "smoke/no-paid-request" &&
      options?.apiKey === "smoke-not-a-real-key",
    context: {
      directory: typeof input.directory === "string" && input.directory.length > 0,
      worktree: typeof input.worktree === "string" && input.worktree.length > 0,
      serverUrl: input.serverUrl instanceof URL,
    },
    attachmentClient:
      typeof input.client?.session?.message === "function",
    configApplied: false,
    commandRegistered: false,
    permissions: {},
  }
  await writeFile(evidencePath, JSON.stringify(baseEvidence))

  const originalConfig = hooks.config
  return {
    ...hooks,
    config: async (config) => {
      await originalConfig?.(config)
      await writeFile(evidencePath, JSON.stringify({
        ...baseEvidence,
        configApplied: true,
        commandRegistered: config.command?.["openrouter-balance"] !== undefined,
        permissions:
          typeof config.permission === "object" && config.permission !== null
            ? config.permission
            : {},
      }))
    },
  }
}
`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function parseEvidence(value: unknown): SmokeEvidence {
  if (
    !isRecord(value) ||
    !Array.isArray(value.tools) ||
    !value.tools.every((tool) => typeof tool === "string") ||
    typeof value.toolDefinitionsExecutable !== "boolean" ||
    typeof value.tupleOptions !== "boolean" ||
    typeof value.attachmentClient !== "boolean" ||
    !isRecord(value.context) ||
    typeof value.context.directory !== "boolean" ||
    typeof value.context.worktree !== "boolean" ||
    typeof value.context.serverUrl !== "boolean" ||
    typeof value.configApplied !== "boolean" ||
    typeof value.commandRegistered !== "boolean" ||
    !isRecord(value.permissions)
  ) {
    throw new Error("OpenCode smoke evidence has an invalid shape.")
  }

  return {
    tools: value.tools,
    toolDefinitionsExecutable: value.toolDefinitionsExecutable,
    tupleOptions: value.tupleOptions,
    attachmentClient: value.attachmentClient,
    context: {
      directory: value.context.directory,
      worktree: value.context.worktree,
      serverUrl: value.context.serverUrl,
    },
    configApplied: value.configApplied,
    commandRegistered: value.commandRegistered,
    permissions: value.permissions,
  }
}

function verifyEvidence(evidence: SmokeEvidence): void {
  const expectedTools = [
    "openrouter_balance",
    "openrouter_edit_image",
    "openrouter_generate_image",
  ]
  if (JSON.stringify(evidence.tools) !== JSON.stringify(expectedTools)) {
    throw new Error("OpenCode did not register all three plugin tools.")
  }
  if (!evidence.toolDefinitionsExecutable) {
    throw new Error("OpenCode did not receive executable plugin tool definitions.")
  }
  if (!evidence.tupleOptions) {
    throw new Error("OpenCode did not pass the configured plugin tuple options.")
  }
  if (!evidence.attachmentClient) {
    throw new Error("OpenCode did not provide the message attachment client shape.")
  }
  if (
    !evidence.context.directory ||
    !evidence.context.worktree ||
    !evidence.context.serverUrl
  ) {
    throw new Error("OpenCode did not provide the required plugin context fields.")
  }
  if (!evidence.configApplied || !evidence.commandRegistered) {
    throw new Error("OpenCode did not apply the plugin config hook and command.")
  }
  const expectedPermissions: Record<string, string> = {
    openrouter_edit_image: "ask",
    openrouter_generate_image: "ask",
    openrouter_balance: "allow",
  }
  for (const [name, value] of Object.entries(expectedPermissions)) {
    if (evidence.permissions[name] !== value) {
      throw new Error(`OpenCode did not apply the default ${name} permission.`)
    }
  }
}

function parsePackageRoot(arguments_: readonly string[]): string {
  if (arguments_.length === 0) return defaultPackageRoot
  if (arguments_.length === 2 && arguments_[0] === "--plugin-root") {
    const value = arguments_[1]
    if (value === undefined || value.trim().length === 0) {
      throw new Error("--plugin-root requires a path.")
    }
    return resolve(value)
  }
  throw new Error("Usage: bun scripts/opencode-smoke.ts [--plugin-root PATH]")
}

function assertSafeTemporaryRoot(path: string): void {
  if (!basename(path).startsWith(TEMPORARY_PREFIX)) {
    throw new Error("Refusing to clean an unexpected OpenCode smoke directory.")
  }
}

export async function runOpenCodeSmoke(
  packageRoot = defaultPackageRoot,
): Promise<OpenCodeSmokeOutcome> {
  const normalizedRoot = resolve(packageRoot)
  const server = join(normalizedRoot, "dist", "server.js")
  await access(server)

  const strict = process.env.OPENCODE_SMOKE_STRICT === "1"
  const configuredVersion = process.env.OPENCODE_SMOKE_VERSION?.trim()
  const expectedVersion =
    configuredVersion !== undefined && configuredVersion.length > 0
      ? configuredVersion
      : BASELINE_VERSION
  const timeoutMs = parsePositiveInteger(
    process.env.OPENCODE_SMOKE_TIMEOUT_MS,
    30_000,
  )
  const configuredBinary = process.env.OPENCODE_BIN?.trim()
  const binary =
    configuredBinary !== undefined && configuredBinary.length > 0
      ? configuredBinary
      : Bun.which("opencode")
  if (binary === null) {
    return unavailable("the opencode binary was not found", strict)
  }

  const temporaryRoot = await mkdtemp(join(tmpdir(), TEMPORARY_PREFIX))
  assertSafeTemporaryRoot(temporaryRoot)
  try {
    const home = join(temporaryRoot, "home")
    const project = join(temporaryRoot, "project")
    await Promise.all([
      mkdir(home, { recursive: true }),
      mkdir(project, { recursive: true }),
    ])
    const environment = isolatedEnvironment(home)

    let versionResult: CommandResult
    try {
      versionResult = await runCommand(binary, ["--version"], {
        cwd: project,
        env: environment,
        timeoutMs: Math.min(timeoutMs, 10_000),
      })
    } catch {
      return unavailable("the binary could not start", strict)
    }
    if (versionResult.timedOut || versionResult.exitCode !== 0) {
      return unavailable("the opencode version check failed", strict)
    }
    const runtimeVersion = parseRuntimeVersion(versionResult.stdout)
    if (runtimeVersion === undefined) {
      return unavailable("the opencode version could not be parsed", strict)
    }
    if (expectedVersion !== "any" && runtimeVersion !== expectedVersion) {
      return unavailable(
        `runtime ${runtimeVersion} does not match baseline ${expectedVersion}`,
        strict,
      )
    }

    const evidencePath = join(temporaryRoot, "evidence.json")
    const wrapper = join(project, "smoke-plugin.js")
    await writeFile(
      wrapper,
      wrapperSource(pathToFileURL(server).href, evidencePath),
    )
    environment.OPENCODE_CONFIG_CONTENT = JSON.stringify({
      plugin: [
        [
          pathToFileURL(wrapper).href,
          {
            routing: "direct",
            model: "smoke/no-paid-request",
            apiKey: "smoke-not-a-real-key",
          },
        ],
      ],
    })

    const result = await runCommand(
      binary,
      ["debug", "config", "--print-logs", "--log-level", "ERROR"],
      { cwd: project, env: environment, timeoutMs },
    )
    if (result.timedOut) {
      const evidenceSummary = await timedOutEvidenceSummary(evidencePath)
      return unavailable(
        `the runtime configuration probe timed out (${evidenceSummary})`,
        strict,
      )
    }
    if (result.exitCode !== 0) {
      throw new Error(
        `OpenCode configuration probe failed with code ${result.exitCode}. ${diagnosticSummary(result.stderr + result.stdout)}`,
      )
    }

    let rawEvidence: unknown
    try {
      rawEvidence = JSON.parse(await readFile(evidencePath, "utf8")) as unknown
    } catch (error) {
      throw new Error("OpenCode did not produce plugin registration evidence.", {
        cause: error,
      })
    }
    verifyEvidence(parseEvidence(rawEvidence))
    console.log(
      `OpenCode smoke passed on ${runtimeVersion}: tuple options, tools, context, attachment-client shape, command, and permissions registered without a model request.`,
    )
    return "passed"
  } finally {
    assertSafeTemporaryRoot(temporaryRoot)
    await rm(temporaryRoot, {
      recursive: true,
      force: true,
      maxRetries: 20,
      retryDelay: 100,
    })
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
    await runOpenCodeSmoke(parsePackageRoot(process.argv.slice(2)))
  } catch (error) {
    console.error(
      error instanceof Error ? error.message : "OpenCode smoke test failed.",
    )
    process.exitCode = 1
  }
}
