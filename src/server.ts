import type {
  Config,
  Plugin,
  PluginInput,
  PluginModule,
  PluginOptions,
} from "@opencode-ai/plugin"

import { OPENROUTER_BALANCE_COMMAND } from "./commands/balance-command.js"
import {
  requireResolvedPluginOptions,
  resolvePluginConfig,
} from "./config/resolve.js"
import { createOpenCodeLogger, type SafeLogger } from "./logging.js"
import { ModelCapabilityService } from "./openrouter/capabilities.js"
import { createOpenRouterClient } from "./openrouter/client.js"
import type { OpenCodeMessageClient } from "./references/attachments.js"
import { createBalanceTool } from "./tools/balance.js"
import { createEditImageTool } from "./tools/edit-image.js"
import { createGenerateImageTool } from "./tools/generate-image.js"
import type { RuntimeServices, ToolDependencies } from "./tools/types.js"
import {
  DirectTransport,
  KoteGatewayTransport,
  type HttpTransport,
} from "./transport/index.js"

const TOOL_PERMISSIONS = {
  openrouter_edit_image: "ask",
  openrouter_generate_image: "ask",
  openrouter_balance: "allow",
} as const

function applyDefaultPermissions(config: Config): void {
  const current = config.permission as unknown
  if (current !== undefined && (typeof current !== "object" || current === null)) {
    return
  }

  const permissions = (current ?? {}) as Record<string, unknown>
  if (!("*" in permissions)) {
    for (const [name, value] of Object.entries(TOOL_PERMISSIONS)) {
      if (!(name in permissions)) permissions[name] = value
    }
  }
  config.permission = permissions as NonNullable<Config["permission"]>
}

function applyBalanceCommand(config: Config, logger: SafeLogger): void {
  config.command ??= {}
  if (config.command["openrouter-balance"] !== undefined) {
    logger.log(
      "warn",
      "The user-defined openrouter-balance command was preserved; the plugin default was not installed.",
    )
    return
  }
  config.command["openrouter-balance"] = { ...OPENROUTER_BALANCE_COMMAND }
}

interface RuntimeOwner {
  getRuntime(): RuntimeServices
  dispose(): Promise<void>
}

function createRuntimeOwner(
  configState: ReturnType<typeof resolvePluginConfig>,
  logger: SafeLogger,
): RuntimeOwner {
  let runtime: RuntimeServices | undefined
  let transport: HttpTransport | undefined

  return {
    getRuntime() {
      if (runtime !== undefined) return runtime
      const options = requireResolvedPluginOptions(configState)
      transport =
        options.routing === "direct"
          ? new DirectTransport()
          : new KoteGatewayTransport({ logger })
      const client = createOpenRouterClient(options, transport, logger)
      const capabilities = new ModelCapabilityService({
        client,
        pluginOptions: options,
        logger,
      })
      runtime = { options, client, capabilities }
      return runtime
    },
    async dispose() {
      runtime?.capabilities.clear()
      await transport?.dispose?.()
      runtime = undefined
      transport = undefined
    },
  }
}

function loggerFromInput(input: PluginInput): SafeLogger {
  return createOpenCodeLogger(
    input.client as unknown as Parameters<typeof createOpenCodeLogger>[0],
    input.directory,
  )
}

export const server: Plugin = async (
  input: PluginInput,
  rawOptions?: PluginOptions,
) => {
  const logger = loggerFromInput(input)
  const configState = resolvePluginConfig(rawOptions)
  const runtimeOwner = createRuntimeOwner(configState, logger)
  const dependencies: ToolDependencies = {
    configState,
    getRuntime: () => runtimeOwner.getRuntime(),
    messageClient: input.client as unknown as OpenCodeMessageClient,
    serverUrl: input.serverUrl,
    logger,
  }

  return {
    tool: {
      openrouter_edit_image: createEditImageTool(dependencies),
      openrouter_generate_image: createGenerateImageTool(dependencies),
      openrouter_balance: createBalanceTool(dependencies),
    },
    config: async (config) => {
      applyBalanceCommand(config, logger)
      applyDefaultPermissions(config)
    },
    dispose: async () => runtimeOwner.dispose(),
  }
}

export default {
  id: "openrouter-genimage-kote-opencode",
  server,
} satisfies PluginModule
