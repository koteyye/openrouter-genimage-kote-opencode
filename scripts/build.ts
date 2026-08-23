import { spawn } from "node:child_process"
import { realpathSync } from "node:fs"
import { access, chmod, rm } from "node:fs/promises"
import { basename, dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const defaultPackageRoot = resolve(
  fileURLToPath(new URL("../", import.meta.url)),
)

async function runCompiler(packageRoot: string): Promise<void> {
  const compiler = join(packageRoot, "node_modules", "typescript", "bin", "tsc")
  await access(compiler)

  const child = spawn(
    process.execPath,
    [compiler, "-p", join(packageRoot, "tsconfig.build.json")],
    {
      cwd: packageRoot,
      stdio: "inherit",
      windowsHide: true,
    },
  )
  const exitCode = await new Promise<number>((resolveExit, reject) => {
    child.once("error", reject)
    child.once("exit", (code, signal) => {
      if (code !== null) {
        resolveExit(code)
        return
      }
      reject(new Error(`TypeScript compiler terminated by signal ${signal ?? "unknown"}.`))
    })
  })

  if (exitCode !== 0) {
    throw new Error(`TypeScript compiler exited with code ${exitCode}.`)
  }
}

function checkedDistPath(packageRoot: string): string {
  const normalizedRoot = resolve(packageRoot)
  const dist = resolve(normalizedRoot, "dist")
  if (dirname(dist) !== normalizedRoot || basename(dist) !== "dist") {
    throw new Error("Refusing to clean an unexpected build output path.")
  }
  return dist
}

export async function buildProject(
  packageRoot = defaultPackageRoot,
): Promise<void> {
  const normalizedRoot = resolve(packageRoot)
  await Promise.all([
    access(join(normalizedRoot, "package.json")),
    access(join(normalizedRoot, "tsconfig.build.json")),
  ])

  const dist = checkedDistPath(normalizedRoot)
  await rm(dist, { recursive: true, force: true })
  await runCompiler(normalizedRoot)

  const requiredOutputs = [
    join(dist, "server.js"),
    join(dist, "server.d.ts"),
    join(dist, "cli.js"),
    join(dist, "cli.d.ts"),
  ]
  await Promise.all(requiredOutputs.map((path) => access(path)))

  if (process.platform !== "win32") {
    await chmod(join(dist, "cli.js"), 0o755)
  }

  console.log("Build complete: dist/server.js and dist/cli.js are ready.")
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
    await buildProject()
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Build failed.")
    process.exitCode = 1
  }
}
