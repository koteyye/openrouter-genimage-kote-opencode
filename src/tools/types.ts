import type { PluginConfigState, ResolvedPluginOptions } from "../config/types.js"
import type { SafeLogger } from "../logging.js"
import type { ModelCapabilityService } from "../openrouter/capabilities.js"
import type { OpenRouterImageClient } from "../openrouter/client.js"
import type { OpenCodeMessageClient } from "../references/attachments.js"

export interface RuntimeServices {
  options: ResolvedPluginOptions
  client: OpenRouterImageClient
  capabilities: ModelCapabilityService
}

export interface ToolDependencies {
  configState: PluginConfigState
  getRuntime(): RuntimeServices
  messageClient: OpenCodeMessageClient
  serverUrl: URL
  logger: SafeLogger
}
