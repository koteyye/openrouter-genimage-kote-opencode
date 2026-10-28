import { tool } from "@opencode-ai/plugin"

import { requireResolvedPluginOptions } from "../config/resolve.js"
import { buildImageToImageRequest } from "../openrouter/requests.js"
import { resolveImageReferences } from "../references/attachments.js"
import { runToolOperation } from "./common.js"
import { finishGeneration, preflightOutput } from "./generation.js"
import { editToolArgs } from "./schema.js"
import type { ToolDependencies } from "./types.js"

export function createEditImageTool(dependencies: ToolDependencies) {
  return tool({
    description: `Edit, transform, or create a new image from one or more visual references using the OpenRouter image model configured by the user.

Use this tool when the user wants to modify an attached image, create a variation, preserve a character or object, transfer a style, or create a new asset based on visual references.

The operation may incur OpenRouter charges.`,
    args: editToolArgs,
    async execute(args, context) {
      return runToolOperation(dependencies.logger, async () => {
        const options = requireResolvedPluginOptions(dependencies.configState)
        const runtime = dependencies.getRuntime()
        const { references: referenceArgs, ...generationArgs } = args
        const references = await resolveImageReferences({
          references: referenceArgs,
          context,
          client: dependencies.messageClient,
          serverUrl: dependencies.serverUrl,
          limits: options.input,
          promptLength: Array.from(args.prompt).length,
        })
        await preflightOutput(
          runtime,
          args,
          context,
          references.canonicalSourcePaths,
        )
        const request = buildImageToImageRequest(
          options,
          generationArgs,
          references.inputReferences,
        )
        await runtime.capabilities.validate("edit", request, context.abort)
        const response = await runtime.client.generateImage(request, context.abort)
        return finishGeneration({
          operation: "edit",
          args,
          request,
          response,
          runtime,
          dependencies,
          context,
          references,
        })
      })
    },
  })
}
