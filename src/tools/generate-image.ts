import { tool } from "@opencode-ai/plugin"

import { requireResolvedPluginOptions } from "../config/resolve.js"
import { buildTextToImageRequest } from "../openrouter/requests.js"
import { runToolOperation } from "./common.js"
import { finishGeneration, preflightOutput } from "./generation.js"
import { generationToolArgs } from "./schema.js"
import type { ToolDependencies } from "./types.js"

export function createGenerateImageTool(dependencies: ToolDependencies) {
  return tool({
    description: `Generate a completely new raster image from a text prompt using the OpenRouter image model configured by the user.

Use this tool only when the user requests a new image or asset and no existing image needs to be preserved or used as a visual reference.

The operation may incur OpenRouter charges.`,
    args: generationToolArgs,
    async execute(args, context) {
      return runToolOperation(dependencies.logger, async () => {
        const options = requireResolvedPluginOptions(dependencies.configState)
        const runtime = dependencies.getRuntime()
        const request = buildTextToImageRequest(options, args)

        await preflightOutput(runtime, args, context)
        await runtime.capabilities.validate("generate", request, context.abort)
        const response = await runtime.client.generateImage(request, context.abort)
        return finishGeneration({
          operation: "generate",
          args,
          request,
          response,
          runtime,
          dependencies,
          context,
        })
      })
    },
  })
}
